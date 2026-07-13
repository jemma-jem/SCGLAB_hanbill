#!/usr/bin/env node
/**
 * news_collector.js — 한빌 뉴스 자동 수집기
 * --------------------------------------------------------------------
 * 구글 뉴스 RSS에서 한전·전기요금·전자청구서·에너지정책 관련 기사를 수집해
 * news_archive.json 에 누적(URL 기준 중복 제거 · 최근 N일 유지)한다.
 *
 * 동작 흐름:
 *   .github/workflows/news-collect.yml (매일 크론)
 *     → node news_collector.js        (RSS 수집 → news_archive.json 갱신·커밋)
 *     → GitHub Pages 가 news_archive.json 서빙
 *     → ax-admin-v2.html 의 fetchLiveNews() 가 자동 반영 (실패 시 NEWS_DATA 폴백)
 *
 * 로컬 실행: `node news_collector.js`  (Node 18+ · 내장 fetch 사용, 외부 의존성 없음)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ARCHIVE_PATH = path.join(__dirname, 'news_archive.json');

// 지자체 뉴스 확장 키워드 (요청 반영) — 검색어 확장 + 카테고리 매핑에 공통 사용
const JICHE_KW = [
  '가로등','보안등','구좌분리','전수조사','시설물관리','도로조명','도로과','전수표찰',
  '에너지 마일리지','포인트','에너지 절감 정책','탄소중립','탄소절감활동','마일리지',
  '건물에너지관리솔루션','종이고지서','우리집 에너지 컨설팅','탄소중립포인트',
  '빗물받이 관리 솔루션','수목관리솔루션','전자문서중계사업자','모바일 고지서'
];

// 수집 대상 검색어 (구글 뉴스). when:Nd = 최근 N일 기사만
// 기본 키워드 + 지자체 확장 키워드 일부를 OR로 포함해 수집 범위를 넓힘
const BASE_KW = ['전기요금','한전','전자청구서','에너지바우처','에너지정책','도시가스',
  '가로등','보안등','시설물관리','도로조명','탄소중립포인트','에너지 마일리지',
  '종이고지서','모바일 고지서','건물에너지관리솔루션','전자문서중계사업자'];
// 기본 키워드 + 지자체 확장 키워드(JICHE_KW) 포함. 단, 검색 노이즈가 매우 큰 초일반 단어
// (포인트·마일리지·전수조사·탄소중립 등)는 '검색'에서 제외한다(분류(LOCAL_KW)에는 계속 사용).
const SEARCH_NOISE_KW = ['포인트','마일리지','전수조사','탄소중립','탄소절감활동'];
const SEARCH_KW = Array.from(new Set(BASE_KW.concat(JICHE_KW)))
  .filter(function(k){ return SEARCH_NOISE_KW.indexOf(k) < 0; });
const QUERY = SEARCH_KW.map(function(k){ return '"' + k + '"'; }).join(' OR ') + ' when:3d';
const RSS_URL = 'https://news.google.com/rss/search?q='
  + encodeURIComponent(QUERY) + '&hl=ko&gl=KR&ceid=KR:ko';

// ── 도메인 관련성 필터: 제목에 아래 핵심어가 하나도 없으면 일반 뉴스로 보고 제외 ──
// (삼성전자·증시 등 무관 기사 노이즈 차단)
const CORE_KW = ['한전','한국전력','한전KDN','한전MCS','전기요금','전력요금','전자청구','전자고지',
  '청구서','빌링','납부','자동이체','도시가스','가스요금','에너지바우처','에너지 바우처','에너지정책','전력수급',
  '가로등','보안등','구좌분리','시설물관리','도로조명','도로과','전수표찰',
  '에너지 마일리지','에너지 절감','건물에너지관리','종이고지서','우리집 에너지','탄소중립포인트',
  '빗물받이','수목관리','전자문서중계','모바일 고지서'];
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

async function fetchRss() {
  const res = await fetch(RSS_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; hanbil-news-collector/1.0)' }
  });
  if (!res.ok) throw new Error('RSS HTTP ' + res.status);
  return await res.text();
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

(async function main() {
  try {
    const xml = await fetchRss();
    const fresh = parseItems(xml);
    console.log('RSS 수집: ' + fresh.length + '건');
    const existing = loadArchive();
    const { all, added } = merge(existing, fresh);
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
