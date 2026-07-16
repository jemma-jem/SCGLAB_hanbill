#!/usr/bin/env node
/**
 * news_collector.js — 한빌 뉴스 자동 수집기
 * --------------------------------------------------------------------
 * 구글 뉴스 RSS에서 한전·전기요금·전자청구서·에너지정책 관련 기사를 수집해
 * news_archive.json 에 누적(URL 기준 중복 제거 · 최근 N일 유지)한다.
 *
 * 동작 흐름:
 *   .github/workflows/news-collect.yml (매일 크론)
 *     → node news_collector.js        (RSS 수집 → [AI 요약] → news_archive.json 갱신·커밋)
 *     → GitHub Pages 가 news_archive.json 서빙
 *     → ax-admin-v2.html 의 fetchLiveNews() 가 자동 반영 (실패 시 NEWS_DATA 폴백)
 *
 * AI 요약(선택): 환경변수 ANTHROPIC_API_KEY 설정 시 신규 기사를 Claude로 2줄 요약.
 *   미설정이면 자동 스킵(규칙 기반 폴백 요약 유지). 모델은 ANTHROPIC_MODEL 로 변경(기본 claude-opus-4-8).
 *
 * 로컬 실행: `node news_collector.js`  (Node 18+ · 내장 fetch 사용, 외부 의존성 없음)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ARCHIVE_PATH = path.join(__dirname, 'news_archive.json');

// ── AI 요약(선택) ─────────────────────────────────────────────────────
// GitHub Secret ANTHROPIC_API_KEY 가 설정돼 있으면 신규 기사 제목을 Claude로
// 2줄 한국어 요약(핵심 + 한빌 사업 시사점)한다. 키가 없으면 자동 스킵(폴백 요약 유지).
// 한 번 요약한 기사는 ai:true 로 표시해 다음 실행에서 재요약하지 않는다(비용 절감).
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL   = process.env.ANTHROPIC_MODEL   || 'claude-opus-4-8';
const SUMM_BATCH        = 25;   // API 호출당 요약할 기사 수(출력 토큰 상한 관리)

// 지자체 뉴스 확장 키워드 (요청 반영) — 검색어 확장 + 카테고리 매핑에 공통 사용
const JICHE_KW = [
  '가로등','보안등','구좌분리','전수조사','시설물관리','도로조명','도로과','전수표찰',
  '에너지 마일리지','포인트','에너지 절감 정책','탄소중립','탄소절감활동','마일리지',
  '건물에너지관리솔루션','종이고지서','우리집 에너지 컨설팅','탄소중립포인트',
  '빗물받이 관리 솔루션','수목관리솔루션','전자문서중계사업자','모바일 고지서'
];

// 수집 대상 검색어 (구글 뉴스). when:Nd = 최근 N일 기사만
const BASE_KW = ['전기요금','한전','전자청구서','에너지바우처','에너지정책','도시가스',
  '가로등','보안등','시설물관리','도로조명','탄소중립포인트','에너지 마일리지',
  '종이고지서','모바일 고지서','건물에너지관리솔루션','전자문서중계사업자'];

// 단독으로는 노이즈(삼성전자·증시·카드 등)가 매우 큰 '일반어'. OR 검색에 그대로 넣으면
// 결과창이 노이즈로 오염되므로, 아래 CONTEXT_KW(맥락어)와 AND로 묶어서만 검색한다.
const GENERIC_JICHE_KW = ['포인트','마일리지','전수조사','탄소중립','탄소절감활동'];
// 지자체/한전/에너지 맥락어 — 위 일반어와 함께 등장할 때만 지자체 사업 기사로 인정
const CONTEXT_KW = ['지자체','지방자치','지방정부','시청','도청','군청','구청',
  '한전','한국전력','전기요금','에너지'];

// 구체 키워드(단독으로도 안전) = 기본 + 지자체 확장 − 일반어. 그대로 OR 검색.
const SPECIFIC_KW = Array.from(new Set(BASE_KW.concat(JICHE_KW)))
  .filter(function(k){ return GENERIC_JICHE_KW.indexOf(k) < 0; });

// 쿼리 1: 구체 키워드 OR 검색
const QUERY_MAIN = SPECIFIC_KW.map(function(k){ return '"' + k + '"'; }).join(' OR ') + ' when:3d';
// 쿼리 2: (일반어 OR …) AND (맥락어 OR …) — 노이즈 차단하며 지자체 사업 기사만 능동 수집
const QUERY_JICHE = '(' + GENERIC_JICHE_KW.map(function(k){ return '"' + k + '"'; }).join(' OR ') + ')'
  + ' (' + CONTEXT_KW.map(function(k){ return '"' + k + '"'; }).join(' OR ') + ') when:3d';
const QUERY = QUERY_MAIN + ' || ' + QUERY_JICHE;   // 로그·메타 표기용
const RSS_URLS = [QUERY_MAIN, QUERY_JICHE].map(function(q){
  return 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=ko&gl=KR&ceid=KR:ko';
});

// ── 도메인 관련성 필터: 제목에 아래 핵심어가 하나도 없으면 일반 뉴스로 보고 제외 ──
// (삼성전자·증시 등 무관 기사 노이즈 차단) — CONTEXT_KW를 포함해 맥락검색으로 들어온
// 지자체 사업 기사(시청·지자체·에너지 등)가 필터에 걸러지지 않도록 보장
const CORE_KW = Array.from(new Set([
  '한전','한국전력','한전KDN','한전MCS','전기요금','전력요금','전자청구','전자고지',
  '청구서','빌링','납부','자동이체','도시가스','가스요금','에너지바우처','에너지 바우처','에너지정책','전력수급',
  '가로등','보안등','구좌분리','시설물관리','도로조명','도로과','전수표찰',
  '에너지 마일리지','에너지 절감','건물에너지관리','종이고지서','우리집 에너지','탄소중립포인트',
  '빗물받이','수목관리','전자문서중계','모바일 고지서'
].concat(CONTEXT_KW)));
function isRelevant(title) {
  const t = title || '';
  for (const k of CORE_KW) if (t.indexOf(k) >= 0) return true;
  return false;
}

const KEEP_DAYS = 60;   // 이 기간 이내 기사만 보관
const MAX_ITEMS = 200;  // 최대 보관 건수(발행일 최신순) — 여러 날짜분 누적 유지('지난 기사' 탭 누적용)

// 지자체 키워드 → 'local', 그 외 → 'energy'
// '시장'(단독)은 '글로벌/주식 시장' 등 오분류를 유발하므로 제외한다.
const LOCAL_KW = ['지자체','지방자치','지방정부','지방의회','시청','도청','군청','구청',
  '광역시','특별시','특별자치','시·군','시군구','조례','도지사','군수','읍면동','행정복지']
  .concat(JICHE_KW);

function decode(s) {
  return (s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
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

function toISO(pubDate) {
  const d = pubDate ? new Date(pubDate) : new Date();
  if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function categorize(title) {
  const t = (title || '').toLowerCase();
  for (const k of LOCAL_KW) if (t.indexOf(k.toLowerCase()) >= 0) return 'local';
  return 'energy';
}

function relevance(title) {
  return /청구서|빌링|전자청구|요금|납부|바우처/.test(title || '')
    ? '한빌 전기요금 전자청구·빌링 사업과 연관된 동향'
    : '에너지·정책 일반 동향(참고)';
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 구글 뉴스 RSS는 일시적으로 HTTP 503(Service Unavailable) 등을 반환할 때가 있어
// URL별로 백오프 재시도한다(3s·6s·9s). 한 번의 일시 오류로 전체 수집이 실패하지 않게.
async function fetchRssOnce(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; hanbil-news-collector/1.0)' }
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.text();
}

async function fetchRss() {
  const MAX_TRY = 4;
  let combined = '';
  for (const url of RSS_URLS) {                 // 쿼리(구체 OR · 지자체 맥락 AND)별로 순차 수집
    let text = '';
    for (let attempt = 1; attempt <= MAX_TRY; attempt++) {
      try {
        text = await fetchRssOnce(url);         // parseItems가 <item> 단위로 스캔 → 단순 연결로 충분
        break;
      } catch (e) {
        console.warn('RSS 시도 ' + attempt + '/' + MAX_TRY + ' 실패(' + e.message + ') — ' + url.slice(0, 90));
        if (attempt < MAX_TRY) await _sleep(attempt * 3000);   // 3s → 6s → 9s 백오프
      }
    }
    if (text) combined += text;
    else console.warn('RSS 최종 실패(계속): ' + url.slice(0, 90));
  }
  if (!combined) throw new Error('RSS 전체 수집 실패');
  return combined;
}

// 구글 뉴스 RSS(XML) → 아카이브 레코드 배열
function parseItems(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    let title = tag(block, 'title');
    let source = tag(block, 'source');            // <source url="...">언론사</source>
    const sm = title.match(/^(.*)\s-\s([^-]+)$/);  // "제목 - 언론사"
    if (!source && sm) source = sm[2].trim();
    if (sm) title = sm[1].trim();
    const link = tag(block, 'link');
    const date = toISO(tag(block, 'pubDate'));
    if (!title || !link) continue;
    items.push({
      title: title,
      url: link,
      date: date,
      source: source || '구글뉴스',
      category: categorize(title),
      summary: [
        relevance(title),
        '출처: ' + (source || '구글뉴스') + ' · 발행 ' + date + ' · 원문 링크에서 전문 확인'
      ]
    });
  }
  return items;
}

function loadArchive() {
  try {
    const j = JSON.parse(fs.readFileSync(ARCHIVE_PATH, 'utf8'));
    return Array.isArray(j) ? j : (j.articles || []);
  } catch (e) {
    return [];
  }
}

function keyOf(a) {
  return (a.url || '').split('?')[0].replace(/\/$/, '') || (a.title + '|' + a.date);
}

function merge(existing, fresh) {
  const map = new Map();
  for (const a of existing) map.set(keyOf(a), a);
  let added = 0;
  for (const a of fresh) {
    const k = keyOf(a);
    if (!map.has(k)) { map.set(k, a); added++; }
  }
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  const all = [...map.values()]
    .filter((a) => (a.date || '') >= cutoff)
    .filter((a) => isRelevant(a.title))                                  // 무관 기사(삼성전자·증시 등) 제외
    .map((a) => Object.assign({}, a, { category: categorize(a.title) })) // 카테고리 재분류(기존 오분류 교정)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, MAX_ITEMS);
  return { all, added };
}

// 기사 배치(제목·출처) → Claude 2줄 요약. 실패 시 예외를 던져 호출부에서 폴백 유지.
async function claudeSummarizeBatch(items) {
  const schema = {
    type: 'object',
    properties: {
      summaries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            i:     { type: 'integer' },
            line1: { type: 'string' },
            line2: { type: 'string' }
          },
          required: ['i', 'line1', 'line2'],
          additionalProperties: false
        }
      }
    },
    required: ['summaries'],
    additionalProperties: false
  };
  const system =
    '너는 한국전력 전기요금 전자청구 대행 서비스 "한빌"의 영업기획팀 뉴스 큐레이터야. ' +
    '각 기사 제목을 보고 영업 담당자가 빠르게 파악하도록 한국어 2줄 요약을 만들어. ' +
    'line1 = 기사 핵심 내용, line2 = 한빌 전자청구·빌링(또는 지자체 사업) 관점의 시사점. ' +
    '관련성이 낮으면 line2는 에너지·정책 일반 동향으로. 각 줄 15~55자, 명사형 종결(…함/…예정/…전망). ' +
    '과장·추측 금지, 제목에 없는 사실은 창작하지 마.';
  const userText = items.map(function (a) {
    return a.i + '. ' + a.title + ' (출처: ' + a.source + ')';
  }).join('\n');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 8000,
      system: system,
      output_config: { format: { type: 'json_schema', schema: schema } },
      messages: [{ role: 'user', content: '아래 기사들을 각각 2줄로 요약해줘.\n\n' + userText }]
    })
  });
  if (!res.ok) throw new Error('Claude HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const j = await res.json();
  const text = (j.content || []).filter(function (b) { return b.type === 'text'; })
    .map(function (b) { return b.text; }).join('');
  return (JSON.parse(text).summaries) || [];
}

// 아직 AI 요약이 없는(ai!=true) 기사만 배치로 요약해 summary 를 교체. 실패는 조용히 폴백.
async function summarizeNew(all) {
  if (!ANTHROPIC_API_KEY) { console.log('AI 요약 스킵 — ANTHROPIC_API_KEY 미설정(폴백 요약 유지)'); return 0; }
  const targets = all.filter(function (a) { return !a.ai; });
  if (!targets.length) { console.log('AI 요약 대상 없음(모두 요약 완료)'); return 0; }
  let done = 0;
  for (let s = 0; s < targets.length; s += SUMM_BATCH) {
    const batch = targets.slice(s, s + SUMM_BATCH).map(function (a, idx) {
      return { i: s + idx, title: a.title, source: a.source };
    });
    try {
      const byI = {};
      (await claudeSummarizeBatch(batch)).forEach(function (x) { byI[x.i] = x; });
      batch.forEach(function (b) {
        const x = byI[b.i];
        const art = targets[b.i];
        if (x && art && x.line1) {
          art.summary = x.line2 ? [x.line1, x.line2] : [x.line1];
          art.ai = true;
          done++;
        }
      });
    } catch (e) {
      console.warn('AI 요약 배치 실패(폴백 유지): ' + e.message);
    }
  }
  console.log('AI 요약 완료: ' + done + '/' + targets.length + '건 (' + ANTHROPIC_MODEL + ')');
  return done;
}

(async function main() {
  try {
    const xml = await fetchRss();
    const fresh = parseItems(xml);
    console.log('RSS 수집: ' + fresh.length + '건');
    const existing = loadArchive();
    const { all, added } = merge(existing, fresh);
    await summarizeNew(all);   // 신규 기사에 Claude 2줄 요약 채움(키 없으면 스킵)
    const out = {
      updated_at: new Date().toISOString(),
      source: 'Google News RSS',
      query: QUERY,
      count: all.length,
      articles: all
    };
    fs.writeFileSync(ARCHIVE_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
    console.log('news_archive.json 갱신 완료 — 신규 +' + added + ' · 총 ' + all.length + '건');
  } catch (e) {
    console.error('수집 실패:', e.message);
    process.exit(1);
  }
})();
