#!/usr/bin/env node
/**
 * g2b_collector.js — 나라장터(조달청) 입찰공고 자동 수집기
 * --------------------------------------------------------------------
 * 목적: 한빌 사업(전자고지·청구서)과 자체 솔루션(도로조명·수목관리·빗물받이·건물에너지)에
 *       맞물리는 지자체 발주를 나라장터에서 잡아내 g2b_archive.json 에 누적한다.
 *       → 「영업 레이더」가 지역별로 붙여 "발주 떴음 · 마감 N일 남음"을 알린다.
 *
 * 뉴스 수집과의 차이:
 *   뉴스는 '보도된 것'만 잡히지만, 나라장터는 발주 자체가 지역·금액·마감일까지
 *   정형 데이터로 나온다. 특히 전자고지/고지서 용역 공고는 경쟁사 계약 만료 시점을
 *   그대로 드러내므로 진입 타이밍을 잡는 데 가장 강력하다.
 *
 * 인증키:
 *   ⚠ 키를 이 파일이나 HTML에 절대 하드코딩하지 말 것 (정적 배포되면 공개된다).
 *   환경변수 G2B_SERVICE_KEY 로만 받는다.
 *     · 로컬:  G2B_SERVICE_KEY='...' node collectors/g2b_collector.js
 *     · CI  :  저장소 Settings → Secrets and variables → Actions → G2B_SERVICE_KEY
 *
 * 사용법:
 *   node collectors/g2b_collector.js            수집 실행 → g2b_archive.json
 *   node collectors/g2b_collector.js --probe    인증키·엔드포인트 진단만 수행(수집/저장 안 함)
 *
 * Node 18+ (내장 fetch), 외부 의존성 없음.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// 산출물은 저장소 루트에 둔다(웹페이지가 루트 기준으로 fetch). 수집기는 collectors/ 하위.
const ARCHIVE_PATH = path.join(__dirname, '..', 'g2b_archive.json');
const SERVICE_KEY = process.env.G2B_SERVICE_KEY || '';
const PROBE = process.argv.includes('--probe');

const LOOKBACK_DAYS = 30;    // 키워드 검색이라 결과가 적어 30일까지 넉넉히 조회
const KEEP_DAYS = 120;       // 공고는 마감 후에도 참고용으로 보관
const MAX_ITEMS = 800;
const ROWS = 100;            // 페이지당 건수
const MAX_PAGES = 2;         // 키워드당 최대 페이지 (키워드가 좁아 1~2면 충분)

// ── 조회 대상 오퍼레이션 ─────────────────────────────────────────────
// 조달청_나라장터 입찰공고정보서비스. 업무구분(용역/물품/공사)별로 오퍼레이션이 나뉜다.
const BASE = 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService';
const OPS = [
  { id: '용역', op: 'getBidPblancListInfoServcPPSSrch' },
  { id: '물품', op: 'getBidPblancListInfoThngPPSSrch' },
  { id: '공사', op: 'getBidPblancListInfoCnstwkPPSSrch' },
];

// 낙찰 결과 — 수주 업체가 두 번째 영업 대상이 된다.
//   발주처(지자체)에는 시스템을 제안하고,
//   과업을 수주한 업체에는 "관리 시스템 연계"를 제안할 수 있다.
//   (업체 입장에선 납품 후 운영·보고 도구가 필요하고, 우리는 그 지역 시설물 데이터에 접점이 생긴다)
// 낙찰정보서비스는 입찰공고(/ad/)와 달리 /as/ 경로다. (별도 활용신청 필요)
const SCSBID_BASE = 'https://apis.data.go.kr/1230000/as/ScsbidInfoService';
const SCSBID_OPS = [
  { id: '용역', op: 'getScsbidListSttusServcPPSSrch' },
  { id: '물품', op: 'getScsbidListSttusThngPPSSrch' },
  { id: '공사', op: 'getScsbidListSttusCnstwkPPSSrch' },
];
// 게이트웨이 경로가 바뀐 이력이 있어 실패 시 아래 순서로 폴백한다.
const BASE_FALLBACKS = [
  'https://apis.data.go.kr/1230000/ad/BidPublicInfoService',
  'https://apis.data.go.kr/1230000/BidPublicInfoService04',
  'https://apis.data.go.kr/1230000/BidPublicInfoService',
];

// ── 검색 키워드 ──────────────────────────────────────────────────────
// 전체 공고를 훑으면 7일에 2,800건이 넘고 대부분 무관하다(축제·연구용역·급식 등).
// API가 공고명 부분검색(bidNtceNm)을 지원하므로, 우리 사업과 맞는 키워드로만 직접 조회한다.
// → 호출 수도 줄고(일 1,000건 제한 대응) 정확도도 훨씬 높다.
const SEARCH_KW = [
  // 도로조명 — 신규 구좌 발생 예고
  { kw:'가로등',       cat:'light' },
  { kw:'보안등',       cat:'light' },
  { kw:'도로조명',     cat:'light' },
  { kw:'등기구',       cat:'light' },
  // 수목관리
  { kw:'수목',         cat:'tree' },
  { kw:'가로수',       cat:'tree' },
  { kw:'전정',         cat:'tree' },
  { kw:'병해충',       cat:'tree' },
  // 빗물받이·배수
  { kw:'빗물받이',     cat:'rain' },
  { kw:'우수받이',     cat:'rain' },
  // 전자고지·청구서 — 경쟁 입찰이자 계약 만료 시점 노출
  { kw:'전자고지',     cat:'billing' },
  { kw:'고지서',       cat:'billing' },
  { kw:'모바일고지',   cat:'billing' },
  { kw:'전자문서중계', cat:'billing' },
  // 시설물 통합관리
  { kw:'시설물관리시스템', cat:'facility' },
  // 건물에너지
  { kw:'그린리모델링', cat:'energy' },
  { kw:'건물에너지',   cat:'energy' },
];

const CAT_LABEL = {
  light:'도로조명(가로등·보안등)', tree:'수목관리', rain:'빗물받이·배수',
  billing:'전자고지·청구서', facility:'시설물 통합관리', energy:'건물에너지',
};

// 검색어로 받아온 공고를 한 번 더 걸러낸다(부분일치라 무관한 건이 섞여 들어온다).
// 예: '전정' 검색에 '유전정보', '수목' 검색에 '한국수목원정원관리원 백서 발간'
const CONFIRM = {
  light:   /가로등|보안등|도로조명|등기구|가로조명|LED등/,
  tree:    /가로수|수목|전정|병해충|방제|조경수|풀베기|임목/,
  rain:    /빗물받이|우수받이|측구|배수구/,
  billing: /전자고지|고지서|청구서|우편발송|납부고지|전자문서 중계|전자문서중계/,
  facility:/시설물|자산관리|스마트도시|디지털트윈/,
  energy:  /그린리모델링|녹색건축|건물에너지|에너지 진단|에너지진단/,
};
// 명백한 오탐 제외 — 연구/발간/교육 등 우리 영업과 무관한 성격
const EXCLUDE = /유전정보|백서|학술|논문|연구용역|세미나|공모전|캠프|축제 조명|무대 조명|조명장비/;

function confirmCat(name, cat) {
  if (EXCLUDE.test(name)) return false;
  const re = CONFIRM[cat];
  return re ? re.test(name) : true;
}

// 확정된 1차 분류(cat) 외에 다른 분야에도 걸리면 함께 표시한다
function classify(name, primary) {
  const cats = [primary];
  Object.keys(CONFIRM).forEach(function (c) {
    if (c !== primary && CONFIRM[c].test(name || '')) cats.push(c);
  });
  return cats;
}

// ── 지자체명 추출 (수요기관명 → 시·군·구) ────────────────────────────
const NOT_REGION = /^(지역|선거|사업|공업|주거|상업|보호|본부|중앙|해당|관할|푸른도시|미래도시|스마트도시|도시|신도시)/;
function extractRegion(org) {
  const s = String(org || '');
  const re = /([가-힣]{2,5}(?:특별자치시|특별자치도|광역시|특별시|시|군|구))/g;
  const out = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    const v = m[1];
    if (NOT_REGION.test(v) || v.length < 3) continue;
    // 뒤에 조직 접미사가 붙으면 행정구역이 아니라 부서·기관명이다.
    //   '부산광역시 푸른도시국' → '푸른도시'(X)  ·  '○○구조대' → '○○구'(X)
    const after = s.slice(m.index + v.length, m.index + v.length + 2);
    if (/^(국|과|단|대|청|소|처|원|부|팀|실|본|센|사업|공사|공단|조합)/.test(after)) continue;
    out.push(v);
  }
  // '서울특별시 마포구' → 마지막(=가장 구체적인) 행정구역을 지역 키로 쓴다
  return out.length ? out[out.length - 1] : '';
}

// ── 유틸 ─────────────────────────────────────────────────────────────
function stamp(d) {
  const p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes());
}
function toDate(s) {
  // '2026-07-23 10:00:00' 또는 '202607231000' 모두 대응
  const t = String(s || '').replace(/[^0-9]/g, '');
  if (t.length < 8) return '';
  return t.slice(0, 4) + '-' + t.slice(4, 6) + '-' + t.slice(6, 8);
}
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

function buildUrl(base, op, params) {
  const qs = Object.keys(params)
    .map(function (k) { return k + '=' + encodeURIComponent(params[k]); })
    .join('&');
  // serviceKey 는 이미 인코딩된 값일 수 있어 별도로 이어붙인다(이중 인코딩 방지)
  return base + '/' + op + '?serviceKey=' + SERVICE_KEY + '&' + qs;
}

async function callApi(base, op, params) {
  const url = buildUrl(base, op, params);
  const res = await fetch(url, { headers: { 'User-Agent': 'hanbil-g2b-collector/1.0' } });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status + ' ' + text.slice(0, 120));
    err.status = res.status;
    throw err;
  }
  // 정상 응답이어도 본문에 에러코드가 담겨 오는 경우가 있다
  if (/SERVICE_KEY_IS_NOT_REGISTERED|SERVICE ERROR|LIMITED_NUMBER_OF_SERVICE/.test(text)) {
    throw new Error('API 에러 응답: ' + text.replace(/\s+/g, ' ').slice(0, 180));
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('JSON 파싱 실패(‘type=json’ 미지원일 수 있음): ' + text.slice(0, 160));
  }
}

function pickItems(json) {
  const body = json && json.response && json.response.body;
  if (!body) return [];
  const items = body.items;
  if (!items) return [];
  if (Array.isArray(items)) return items;
  if (Array.isArray(items.item)) return items.item;
  if (items.item) return [items.item];
  return [];
}

// ── 공고 1건 → 레코드 ────────────────────────────────────────────────
function toRecord(it, kind, cat) {
  const name = it.bidNtceNm || it.ntceNm || '';
  if (!confirmCat(name, cat)) return null;             // 부분일치 오탐 제거
  const cats = classify(name, cat);
  const org = it.dminsttNm || it.ntceInsttNm || '';    // 수요기관 우선(발주 주체)
  return {
    kind: kind,                                        // 용역/물품/공사
    cats: cats,
    title: name,
    org: org,
    ntceInstt: it.ntceInsttNm || '',
    region: extractRegion(org || it.ntceInsttNm || ''),
    bidNo: (it.bidNtceNo || '') + (it.bidNtceOrd ? '-' + it.bidNtceOrd : ''),
    date: toDate(it.bidNtceDt),                        // 공고일
    closeDate: toDate(it.bidClseDt || it.opengDt),     // 입찰마감
    amount: Number(String(it.presmptPrce || it.asignBdgtAmt || '').replace(/[^0-9]/g, '')) || 0,
    url: it.bidNtceDtlUrl || it.bidNtceUrl || '',
    charge: it.ntceInsttOfclNm || '',                  // 공고 담당자
    chargeTel: it.ntceInsttOfclTelNo || '',
  };
}

// 낙찰 결과 1건 → 레코드 (수주 업체 = 2차 영업 대상)
function toWinRecord(it, kind, cat) {
  const name = it.bidNtceNm || '';
  if (!confirmCat(name, cat)) return null;
  const cats = classify(name, cat);
  const org = it.dminsttNm || it.ntceInsttNm || '';
  return {
    type: 'win',
    kind: kind,
    cats: cats,
    title: name,
    org: org,
    region: extractRegion(org || it.ntceInsttNm || ''),
    bidNo: (it.bidNtceNo || '') + (it.bidNtceOrd ? '-' + it.bidNtceOrd : ''),
    date: toDate(it.rlOpengDt || it.opengDt),          // 개찰일
    winner: it.bidwinnrNm || it.scsbidCorpNm || '',    // 낙찰업체명
    winnerCeo: it.bidwinnrCeoNm || '',
    winnerTel: it.bidwinnrTelNo || '',
    winnerAddr: it.bidwinnrAdrs || '',
    amount: Number(String(it.sucsfbidAmt || '').replace(/[^0-9]/g, '')) || 0,
    url: it.bidNtceDtlUrl || '',
  };
}

// ── 수집 ─────────────────────────────────────────────────────────────
async function collect() {
  const end = new Date();
  const bgn = new Date(Date.now() - LOOKBACK_DAYS * 86400000);
  const out = [];
  let workingBase = null;

  // 키워드 × 업무구분(용역/물품/공사) 조합으로 공고명 검색
  for (const s of SEARCH_KW) {
    let found = 0;
    for (const o of OPS) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const params = {
          pageNo: page, numOfRows: ROWS, type: 'json',
          inqryDiv: 1,                                 // 1 = 공고게시일시 기준
          inqryBgnDt: stamp(bgn), inqryEndDt: stamp(end),
          bidNtceNm: s.kw,                             // 공고명 부분검색
        };
        let json = null;
        const bases = workingBase ? [workingBase] : BASE_FALLBACKS;
        let lastErr = null;
        for (const b of bases) {
          try { json = await callApi(b, o.op, params); workingBase = b; break; }
          catch (e) { lastErr = e; }
        }
        if (!json) {
          console.warn('  [' + s.kw + '·' + o.id + '] 실패: ' + (lastErr && lastErr.message || '').slice(0, 110));
          break;
        }
        const items = pickItems(json);
        const recs = items.map(function (it) { return toRecord(it, o.id, s.cat); }).filter(Boolean);
        out.push(...recs);
        found += recs.length;
        if (items.length < ROWS) break;                // 마지막 페이지
        await sleep(300);
      }
    }
    console.log('  [' + s.kw.padEnd(8) + '] → ' + found + '건');
    await sleep(200);
  }

  // ── 낙찰 결과 (수주 업체 = 2차 영업 대상) ──
  // 별도 API(ScsbidInfoService)라 활용신청이 따로 필요하다. 미신청이면 조용히 건너뛴다.
  console.log('낙찰 결과 수집 (수주 업체 대상)');
  let winFail = 0, winOk = 0;
  for (const s of SEARCH_KW) {
    for (const o of SCSBID_OPS) {
      try {
        const json = await callApi(SCSBID_BASE, o.op, {
          pageNo: 1, numOfRows: ROWS, type: 'json', inqryDiv: 1,
          inqryBgnDt: stamp(bgn), inqryEndDt: stamp(end),
          bidNtceNm: s.kw,
        });
        const items = pickItems(json);
        const recs = items.map(function (it) { return toWinRecord(it, o.id, s.cat); }).filter(Boolean);
        out.push(...recs);
        winOk += recs.length;
      } catch (e) {
        winFail++;
        if (winFail === 1) console.warn('  낙찰 API 오류(계속): ' + String(e.message).slice(0, 110));
      }
      await sleep(250);
    }
    if (winFail >= 6 && winOk === 0) {                 // 초반부터 계속 실패
      console.warn('  ⚠ 낙찰정보 API 응답 없음 — 「조달청_나라장터 낙찰정보서비스」 활용신청 승인이');
      console.warn('    아직 게이트웨이에 반영되지 않았을 수 있습니다(승인 후 최대 1시간). (공고 수집은 정상 진행)');
      break;
    }
  }
  if (winOk) console.log('  낙찰 ' + winOk + '건 수집');
  return out;
}

// ── 누적 병합 ────────────────────────────────────────────────────────
function loadArchive() {
  try {
    const j = JSON.parse(fs.readFileSync(ARCHIVE_PATH, 'utf8'));
    return Array.isArray(j) ? j : (j.records || []);
  } catch (e) { return []; }
}
// 공고와 낙찰결과는 같은 bidNo 를 쓰므로 type 을 붙여 별도 레코드로 유지한다
function keyOf(r) { return (r.type || 'bid') + '|' + (r.bidNo || (r.title + '|' + r.date)); }

function merge(existing, fresh) {
  const map = new Map();
  existing.forEach(function (r) { map.set(keyOf(r), r); });
  let added = 0;
  fresh.forEach(function (r) {
    const k = keyOf(r);
    if (!map.has(k)) added++;
    map.set(k, r);                                     // 재공고/정정 반영 위해 최신으로 덮어씀
  });
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  const all = [...map.values()]
    .filter(function (r) { return (r.date || '') >= cutoff; })
    .sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); })
    .slice(0, MAX_ITEMS);
  return { all: all, added: added };
}

// ── 진단 모드 ────────────────────────────────────────────────────────
async function probe() {
  console.log('인증키 길이: ' + SERVICE_KEY.length + '자 · 앞 8자: ' + SERVICE_KEY.slice(0, 8) + '…');
  console.log('키에 URL 인코딩 문자(%) 포함 여부: ' + (SERVICE_KEY.indexOf('%') >= 0 ? '있음(Encoding 키로 보임)' : '없음'));
  const end = new Date(), bgn = new Date(Date.now() - 2 * 86400000);
  for (const b of BASE_FALLBACKS) {
    try {
      const json = await callApi(b, OPS[0].op, {
        pageNo: 1, numOfRows: 1, type: 'json', inqryDiv: 1,
        inqryBgnDt: stamp(bgn), inqryEndDt: stamp(end),
      });
      const n = (json.response && json.response.body && json.response.body.totalCount);
      console.log('✅ 성공: ' + b + '  (totalCount=' + n + ')');
      return true;
    } catch (e) {
      console.log('❌ ' + b + ' → ' + (e.message || '').slice(0, 150));
    }
  }
  console.log('\n모든 엔드포인트 실패. 확인할 것:');
  console.log('  1) 해당 API에 개별 [활용신청]을 했는지 (포털 계정이 있어도 API마다 신청이 필요)');
  console.log('  2) 신청 직후면 20분~1시간 대기 후 재시도');
  console.log('  3) 마이페이지 > 오픈API > 개발계정 에서 「일반 인증키(Decoding)」 값을 사용');
  return false;
}

// ── 메인 ─────────────────────────────────────────────────────────────
(async function main() {
  if (!SERVICE_KEY) {
    console.error('환경변수 G2B_SERVICE_KEY 가 없습니다.');
    console.error("  로컬: G2B_SERVICE_KEY='발급키' node collectors/g2b_collector.js");
    console.error('  CI  : 저장소 Secrets 에 G2B_SERVICE_KEY 등록');
    process.exit(1);
  }
  if (PROBE) { await probe(); return; }

  console.log('나라장터 입찰공고 수집 (최근 ' + LOOKBACK_DAYS + '일)');
  const fresh = await collect();
  if (!fresh.length) {
    console.warn('수집 0건 — 인증키/엔드포인트를 확인하세요: node collectors/g2b_collector.js --probe');
  }
  const merged = merge(loadArchive(), fresh);
  const byCat = {};
  merged.all.forEach(function (r) { (r.cats || []).forEach(function (c) { byCat[c] = (byCat[c] || 0) + 1; }); });

  fs.writeFileSync(ARCHIVE_PATH, JSON.stringify({
    updated_at: new Date().toISOString(),
    source: '조달청_나라장터 입찰공고정보서비스 (공공데이터포털)',
    count: merged.all.length,
    records: merged.all,
  }, null, 2) + '\n', 'utf8');

  console.log('\ng2b_archive.json 갱신 완료 — 총 ' + merged.all.length + '건 (신규 +' + merged.added + ')');
  console.log('  분야별: ' + JSON.stringify(byCat));
  console.log('  지역 추출: ' + merged.all.filter(function (r) { return r.region; }).length + '건');
})().catch(function (e) {
  console.error('수집 실패:', e);
  process.exit(1);
});
