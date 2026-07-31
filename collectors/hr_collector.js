#!/usr/bin/env node
/**
 * hr_collector.js — 지자체 담당자(인사발령) 자동 수집기
 * --------------------------------------------------------------------
 * 목적: 영업 담당자가 시트에 수동 입력하지 않아도, 지자체 인사발령을
 *       외부 공개 소스에서 자동으로 잡아내 hr_archive.json 에 누적한다.
 *       → ax-admin-v2.html 「영업 레이더」가 이를 읽어 "담당자 변경 감지" 알림을 띄우고,
 *         영업담당자가 확인하면 그 결과를 고객관리리스트 시트에 기록(기준선 갱신)한다.
 *
 * 수집 소스 (모두 공개 RSS — 인증키 불필요)
 *   ① 시정일보 「피플」 섹션 (S1N8) — 지자체 인사발령 전문. 본문에 성명·부서가 그대로 실린다.
 *   ② 구글 뉴스 RSS — 지역 신문의 인사·정기인사·승진·전보 기사
 *
 * 산출: hr_archive.json
 *   { updated_at, count, records: [{
 *       date, url, source, title,
 *       region,            // 추출된 지자체명 (예: '마포구') — 없으면 ''
 *       kinds: ['전보','승진',…],
 *       people: [{ name, dept, rank }],   // 본문에서 파싱된 인사 대상
 *       hit: true/false    // 영업 관련 부서(도로·조명·공원·시설·전산·회계 등) 포함 여부
 *   }] }
 *
 * 로컬 실행: `node collectors/hr_collector.js`   (Node 18+ · 내장 fetch, 외부 의존성 없음)
 */
'use strict';

const fs = require('fs');
const path = require('path');

// 산출물은 저장소 루트에 둔다(웹페이지가 루트 기준으로 fetch). 수집기는 collectors/ 하위.
const ARCHIVE_PATH = path.join(__dirname, '..', 'hr_archive.json');
const KEEP_DAYS = 180;   // 인사는 반기~연 단위라 뉴스보다 길게 보관
const MAX_ITEMS = 600;

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; hanbil-hr-collector/1.0)' };

// ── 수집 대상 ────────────────────────────────────────────────────────
// 시정일보 섹션 RSS. S1N8 = 「피플」(인사발령 전용). allArticle 은 보조.
const SIJUNG_FEEDS = [
  { url: 'https://www.sijung.co.kr/rss/S1N8.xml',        source: '시정일보' },
  { url: 'https://www.sijung.co.kr/rss/allArticle.xml',  source: '시정일보' },
];

// 지역지 직접 RSS — 링크가 '진짜 기사 URL'이라 본문 취득→명단 전체 파싱이 가능하다.
//   (구글뉴스 링크는 news.google.com 중간페이지로 리다이렉트되지 않아 본문 취득 불가)
//   ※ 모두 동일 CMS(#article-view-content-div) → 아래 fetchBody 로직이 그대로 적용된다.
//   ※ 커버 지역을 넓히려면 같은 형식의 지역지 RSS를 이 배열에 추가하면 된다.
const LOCAL_FEEDS = [
  { url: 'https://www.dongbunews.co.kr/rss/allArticle.xml', source: '동부뉴스' },   // 강동·송파
  { url: 'https://www.todaygunsan.co.kr/rss/allArticle.xml', source: '투데이군산' }, // 군산
  { url: 'https://www.djtimes.co.kr/rss/allArticle.xml',    source: '당진신문' },   // 당진
  { url: 'https://www.yntoday.co.kr/rss/allArticle.xml',    source: '영남투데이' }, // 경북(청도·상주·봉화·칠곡 등)
];

// 구글 뉴스 — 전국 지역지의 지자체 인사 기사(지역·날짜·출처 신호. 본문은 구글링크라 명단 추출은 best-effort)
const GNEWS_QUERIES = [
  '"[인사]" (구청 OR 시청 OR 군청) when:21d',                                   // 지역지 정기인사 명단 기사(가장 정확)
  '"인사발령" (구청 OR 시청 OR 군청 OR 구의회 OR 시의회) when:21d',
  '"정기인사" (구청 OR 시청 OR 군청) when:21d',
  '("승진" OR "전보") ("5급" OR "6급" OR "사무관" OR "주무관") (시청 OR 군청 OR 구청) when:21d',
  '"과장 전보" OR "국장 전보" OR "인사 단행" (지자체 OR 시청 OR 구청 OR 군청) when:21d',
  '("도로" OR "조명" OR "시설" OR "건설" OR "전산") ("과장" OR "팀장") (전보 OR 승진 OR 발령) 시청 when:21d', // 영업부서 우선
];

// 한빌 영업과 직접 맞물리는 부서 — 이 부서가 인사에 포함되면 우선 알림 대상(hit)
const TARGET_DEPT = /도로|조명|가로등|보안등|공원|녹지|수목|조경|시설|건설|치수|하수|전산|정보통신|정보화|회계|재무|세무|예산|주차|교통|안전|재난|환경|도시관리|자산|관재/;

// 인사 기사 판별
const HR_TITLE = /인사|발령|승진|전보|임용|보직|의결|취임|부임/;
// 인사 기사가 아닌데 위 단어가 걸리는 케이스 제외 (의회 안건 의결 등)
const HR_EXCLUDE = /조례|예산안|행감|임시회|정례회|간담회|공청회|토론회/;

// ── 유틸 ─────────────────────────────────────────────────────────────
function decode(s) {
  return (s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
function tag(block, name) {
  const m = block.match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)<\\/' + name + '>'));
  return m ? decode(m[1]) : '';
}
function toISO(d) {
  const t = d ? new Date(d) : new Date();
  if (isNaN(t.getTime())) return new Date().toISOString().slice(0, 10);
  return t.toISOString().slice(0, 10);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, tries) {
  tries = tries || 3;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) {
      console.warn('  시도 ' + i + '/' + tries + ' 실패(' + e.message + ') — ' + url.slice(0, 80));
      if (i < tries) await sleep(i * 2500);
    }
  }
  return '';
}

// 기사 본문 텍스트 추출 — 한국 지역지 공통 CMS(#article-view-content-div)에서 본문만 뽑는다.
//   RSS <description>은 리드(앞부분)만 담겨 인사 명단이 잘리므로, 본문을 받아 전체 명단을 파싱한다.
function extractArticleBody(html) {
  const m = String(html || '').match(/id=["']article-view-content-div["'][^>]*>([\s\S]*?)<\/div>/i);
  if (!m) return '';
  return decode(m[1]
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>(?=)/gi, ' '));
}
// 구글뉴스 링크는 본문 취득 불가(중간페이지). 직접 기사 URL만 본문을 받는다.
function isDirectArticle(url) {
  return /articleView\.html/i.test(url) && !/news\.google\./i.test(url);
}

// ── 지자체명 추출 ────────────────────────────────────────────────────
// '마포구 인사발령 사항(4급)' → '마포구'
// 지역이 아닌 '～구' 오탐(지역구·선거구 등)을 막기 위해 접미사와 길이를 제한한다.
const NOT_REGION = /^(지역|선거|사업|공업|주거|상업|녹지|보호|재개발|재건축|학군|본부|중앙|해당|각|전|시내|시외|국내|해외|관할)/;
function extractRegion(title, desc) {
  const cands = [];
  const scan = function (txt, weight) {
    const re = /([가-힣]{2,5}(?:특별자치시|특별자치도|광역시|특별시|시|군|구))/g;
    let m;
    while ((m = re.exec(txt || '')) !== null) {
      const v = m[1];
      if (NOT_REGION.test(v)) continue;
      if (v.length < 3) continue;                 // '시','구' 단독 방지
      cands.push({ v: v, w: weight });
    }
  };
  scan(title, 10);                                 // 제목에 있으면 강한 신호
  scan((desc || '').slice(0, 160), 3);             // 본문 앞부분 (기자 서명 직후)
  if (!cands.length) return '';
  const score = {};
  cands.forEach(function (c) { score[c.v] = (score[c.v] || 0) + c.w; });
  return Object.keys(score).sort(function (a, b) { return score[b] - score[a]; })[0] || '';
}

// ── 인사 대상자 파싱 ─────────────────────────────────────────────────
// 시정일보 본문 형식은 크게 두 가지가 섞여 있다.
//   (A) △성명 부서/직위      예) △김숙현 세무관리과장   ▲ 윤정희 교통행정과장
//   (B) ▲부서 성명           예) ▲ 예산정책과 이주미     (승진예정자 명단에서 흔함)
// 구분자(△▲)로 쪼갠 뒤 토큰 순서로 판별한다.
const POST_SUFFIX = /(과장|국장|팀장|담당관|동장|소장|본부장|실장|관장|원장|센터장|부장|과|국|팀|실|동)$/;
const RANK_RE = /(\d급|서기관|사무관|주사|주무관|주사보|서기|국장|과장|팀장|담당관|동장)/;

function parsePeople(desc) {
  const out = [];
  const body = (desc || '').replace(/\[시정일보[^\]]*\]/g, ' ');
  const chunks = body.split(/[△▲]/).slice(1);      // 첫 조각은 구분자 앞 도입부라 버림
  chunks.forEach(function (raw) {
    // ◈/◆/※ 는 다음 구획(전보→전입, 발령일 안내 등)의 시작이라 그 앞까지만 한 사람의 정보다.
    // 자르지 않으면 "김정해 재정관리국장 전입" 처럼 다음 구획 제목이 부서명에 붙는다.
    raw = raw.split(/[◈◆※]/)[0];
    // 괄호 안 부가정보는 직위 힌트로만 쓰고 파싱 대상에선 제외
    const paren = (raw.match(/[（(]([^）)]*)[）)]/) || [])[1] || '';
    let s = raw.replace(/[（(][^）)]*[）)]/g, ' ')
               .replace(/\s+/g, ' ')
               .trim();
    if (!s || s.length > 40) return;

    const tok = s.split(' ').filter(Boolean);
    if (tok.length < 1) return;

    let name = '', dept = '';
    const isName = function (t) { return /^[가-힣]{2,4}$/.test(t) && !POST_SUFFIX.test(t); };

    if (isName(tok[0]) && tok.length >= 2) {
      // (A) 성명 + 부서/직위
      name = tok[0];
      dept = tok.slice(1).join(' ');
    } else if (tok.length >= 2 && isName(tok[tok.length - 1])) {
      // (B) 부서 + 성명
      name = tok[tok.length - 1];
      dept = tok.slice(0, -1).join(' ');
    } else if (tok.length === 1 && isName(tok[0])) {
      name = tok[0]; dept = '';
    } else {
      return;
    }
    if (!name) return;
    if (dept.length > 30) dept = dept.slice(0, 30);
    const rank = ((dept + ' ' + paren).match(RANK_RE) || [])[1] || '';
    out.push({ name: name, dept: dept + (paren ? ' (' + paren + ')' : ''), rank: rank });
  });
  // 중복 제거 (같은 사람이 여러 번 나오는 경우)
  const seen = {};
  return out.filter(function (p) {
    const k = p.name + '|' + p.dept;
    if (seen[k]) return false; seen[k] = 1; return true;
  }).slice(0, 150);   // 팀장 전보 등 대량 명단 기사 대비(본문 파싱 시 100+건 흔함)
}

function extractKinds(text) {
  const k = [];
  [['전보', /전보/], ['승진', /승진/], ['전입', /전입/], ['전출', /전출/],
   ['임용', /임용/], ['보직부여', /보직/], ['직무대리', /직무대리/], ['정기인사', /정기인사/]]
    .forEach(function (x) { if (x[1].test(text)) k.push(x[0]); });
  return k;
}

// ── RSS → 레코드 ─────────────────────────────────────────────────────
function parseFeed(xml, sourceName) {
  const out = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    let title = tag(b, 'title');
    const link = tag(b, 'link');
    const desc = tag(b, 'description');
    if (!title || !link) continue;

    // 구글뉴스는 "제목 - 언론사" 형태 → 언론사 분리
    let source = tag(b, 'source') || sourceName || '';
    const sm = title.match(/^(.*)\s-\s([^-]+)$/);
    if (sm && !sourceName) { title = sm[1].trim(); source = sm[2].trim(); }

    const full = title + ' ' + desc;
    if (!HR_TITLE.test(title)) continue;             // 인사 기사만
    if (HR_EXCLUDE.test(title)) continue;            // 의회 안건 등 제외

    const people = parsePeople(desc);
    const region = extractRegion(title, desc);
    const hit = people.some(function (p) { return TARGET_DEPT.test(p.dept); })
             || TARGET_DEPT.test(title);

    out.push({
      date: toISO(tag(b, 'pubDate')),
      url: link,
      source: source || '구글뉴스',
      title: title,
      region: region,
      kinds: extractKinds(full),
      people: people,
      hit: hit,
    });
  }
  return out;
}

// ── 누적 병합 ────────────────────────────────────────────────────────
function loadArchive() {
  try {
    const j = JSON.parse(fs.readFileSync(ARCHIVE_PATH, 'utf8'));
    return Array.isArray(j) ? j : (j.records || []);
  } catch (e) { return []; }
}
// 중복 키 — 쿼리스트링을 통째로 버리면 안 된다.
// 시정일보처럼 `articleView.html?idxno=433307` 형태는 쿼리가 곧 기사 식별자라
// 잘라내면 모든 기사가 한 건으로 뭉개진다. 추적용 파라미터만 골라서 제거한다.
const TRACK_PARAM = /^(utm_[^=]*|oc|ved|usg|sa|ei|gws_rd|fbclid|gclid|ref|src)$/i;
function normUrl(u) {
  u = String(u || '');
  const qi = u.indexOf('?');
  if (qi < 0) return u.replace(/\/$/, '');
  const base = u.slice(0, qi);
  const kept = u.slice(qi + 1).split('&')
    .filter(function (kv) { return kv && !TRACK_PARAM.test(kv.split('=')[0]); })
    .sort();
  return (kept.length ? base + '?' + kept.join('&') : base).replace(/\/$/, '');
}
function keyOf(r) { return normUrl(r.url) || (r.title + '|' + r.date); }

function merge(existing, fresh) {
  const map = new Map();
  existing.forEach(function (r) { map.set(keyOf(r), r); });
  let added = 0;
  fresh.forEach(function (r) {
    const k = keyOf(r);
    const prev = map.get(k);
    if (!prev) { map.set(k, r); added++; }
    // 같은 URL이라도 사람 파싱이 더 많이 된 쪽을 채택(전체기사 피드 → 섹션 피드 순서 대비)
    else if ((r.people || []).length > (prev.people || []).length) map.set(k, r);
  });
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  const all = [...map.values()]
    .filter(function (r) { return (r.date || '') >= cutoff; })
    .sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); })
    .slice(0, MAX_ITEMS);
  return { all: all, added: added };
}

// ── 메인 ─────────────────────────────────────────────────────────────
(async function main() {
  const fresh = [];
  const archive = loadArchive();
  const knownKeys = new Set(archive.map(keyOf));   // 본문 보강 시 이미 보관된 건은 재취득 안 함

  console.log('① 시정일보 수집');
  for (const f of SIJUNG_FEEDS) {
    const xml = await fetchText(f.url);
    if (!xml) { console.warn('   실패(계속): ' + f.url); continue; }
    const got = parseFeed(xml, f.source);
    console.log('   ' + f.url.split('/').pop() + ' → 인사 기사 ' + got.length + '건');
    fresh.push(...got);
  }

  console.log('② 지역지 직접 RSS 수집');
  for (const f of LOCAL_FEEDS) {
    const xml = await fetchText(f.url);
    if (!xml) { console.warn('   실패(계속): ' + f.url); continue; }
    const got = parseFeed(xml, f.source);
    console.log('   ' + f.source + ' → 인사 기사 ' + got.length + '건');
    fresh.push(...got);
    await sleep(500);
  }

  console.log('③ 구글 뉴스 수집');
  for (const q of GNEWS_QUERIES) {
    const u = 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=ko&gl=KR&ceid=KR:ko';
    const xml = await fetchText(u);
    if (!xml) { console.warn('   실패(계속): ' + q.slice(0, 40)); continue; }
    const got = parseFeed(xml, '');
    console.log('   [' + q.slice(0, 34) + '…] → ' + got.length + '건');
    fresh.push(...got);
    await sleep(800);
  }

  // ④ 기사 본문 보강 — 직접 기사 URL(지역지·시정일보)의 신규 HR건은 본문을 받아 명단 전체를 파싱
  //    RSS 요약엔 명단이 잘려 담기므로, 본문(#article-view-content-div)에서 △성명·부서를 온전히 뽑는다.
  console.log('④ 기사 본문 보강(직접 URL 신규건)');
  const BODY_FETCH_CAP = 120;
  let bodyTried = 0, bodyGain = 0;
  for (const r of fresh) {
    if (bodyTried >= BODY_FETCH_CAP) break;
    if (!isDirectArticle(r.url)) continue;          // 구글링크는 본문 취득 불가 → 건너뜀
    if (knownKeys.has(keyOf(r))) continue;          // 이미 보관된 건
    if ((r.people || []).length >= 8) continue;     // RSS 요약만으로도 충분히 파싱됨
    const html = await fetchText(r.url, 2);
    bodyTried++;
    if (!html) continue;
    const body = extractArticleBody(html);
    if (!body) continue;
    const bp = parsePeople(body);
    if (bp.length > (r.people || []).length) {
      bodyGain++;
      r.people = bp;
      r.kinds = extractKinds(r.title + ' ' + body);
      r.hit = bp.some(function (p) { return TARGET_DEPT.test(p.dept); }) || TARGET_DEPT.test(r.title);
      if (!r.region) r.region = extractRegion(r.title, body);
    }
    await sleep(400);
  }
  console.log('   본문 취득 ' + bodyTried + '건 · 명단 보강 ' + bodyGain + '건');

  const merged = merge(archive, fresh);
  const withPeople = merged.all.filter(function (r) { return (r.people || []).length; }).length;
  const hits = merged.all.filter(function (r) { return r.hit; }).length;
  const withRegion = merged.all.filter(function (r) { return r.region; }).length;

  fs.writeFileSync(ARCHIVE_PATH, JSON.stringify({
    updated_at: new Date().toISOString(),
    sources: ['시정일보 RSS(피플/전체)', '지역지 직접 RSS(' + LOCAL_FEEDS.map(function(f){ return f.source; }).join('·') + ')', '구글 뉴스 RSS', '기사 본문 보강'],
    count: merged.all.length,
    records: merged.all,
  }, null, 2) + '\n', 'utf8');

  console.log('\nhr_archive.json 갱신 완료');
  console.log('  총 ' + merged.all.length + '건 (신규 +' + merged.added + ')');
  console.log('  · 지자체명 추출: ' + withRegion + '건');
  console.log('  · 인사 대상자 파싱: ' + withPeople + '건');
  console.log('  · 영업 관련 부서 포함(hit): ' + hits + '건');
})().catch(function (e) {
  console.error('수집 실패:', e);
  process.exit(1);
});
