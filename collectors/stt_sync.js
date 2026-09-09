/**
 * stt_sync.js
 * jemma-jem/stt 파이프라인이 만든 stt_analysis.json 을 받아
 * 라이브 대시보드 ax-admin-v2.html 의 STT_RAW / ANALYSIS_INDEX '블록만' 교체한다.
 *
 * ★ 전체 파일을 덮어쓰지 않는다 → 레인저(sec-radar)·로그인·지도·DB 등 라이브 전용 코드는 그대로 보존.
 *
 * 데이터 소스: 환경변수 STT_ANALYSIS_URL (없으면 jemma-jem/stt 기본 raw URL).
 * 실행: node collectors/stt_sync.js
 */
const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, '..', 'ax-admin-v2.html');
const URL = process.env.STT_ANALYSIS_URL
  || 'https://raw.githubusercontent.com/jemma-jem/stt/main/stt_analysis.json';

const sMap = { '만족': 1, '불만': -1, '중립': 0 };
const aMap = { '좋음': 1, '개선필요': -1, '보통': 0 };

function buildBlocks(data) {
  const sttRaw = data.filter(r => r.date && r.category).map(r => ({
    d: r.date, c: r.category,
    s: sMap[r.sentiment] !== undefined ? sMap[r.sentiment] : 0,
    r: r.resolved ? 1 : 0,
    a: aMap[r.agentScript] !== undefined ? aMap[r.agentScript] : 0,
  })).sort((a, b) => a.d.localeCompare(b.d));

  const total = data.length;
  const HANJA_FIX = { '详细': '상세', '迅速': '신속' };
  const cleanHanja = s => { if (!s) return s; let o = s; Object.entries(HANJA_FIX).forEach(([h, k]) => o = o.split(h).join(k)); return /[一-鿿]/.test(o) ? null : o; };
  const sentCount = { 만족: 0, 중립: 0, 불만: 0 };
  data.forEach(r => { if (sentCount[r.sentiment] !== undefined) sentCount[r.sentiment]++; });
  const resolved = data.filter(r => r.resolved).length;
  const unresolved = total - resolved;
  const scriptGood = data.filter(r => r.agentScript === '좋음').length;
  const scriptOk = data.filter(r => r.agentScript === '보통').length;
  const scriptImprove = data.filter(r => r.agentScript === '개선필요').length;
  const catMap = {};
  data.forEach(r => { const c = r.category || 'Z1'; if (!catMap[c]) catMap[c] = { cnt: 0, resolved: 0, unresolved: 0, issues: [] }; catMap[c].cnt++; r.resolved ? catMap[c].resolved++ : catMap[c].unresolved++; });
  const topCats = Object.entries(catMap).sort((a, b) => b[1].cnt - a[1].cnt).slice(0, 8).map(([code, v]) => ({ code, ...v }));
  const allCats = Object.fromEntries(Object.entries(catMap).map(([code, v]) => [code, v.cnt]));
  const issueMap = {};
  data.forEach(r => { if (r.coreIssue) issueMap[r.coreIssue] = (issueMap[r.coreIssue] || 0) + 1; });
  const topIssues = Object.entries(issueMap).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([issue, cnt]) => ({ issue, cnt }));
  const improvements = [...new Set(data.filter(r => r.improvement).map(r => cleanHanja(r.improvement)).filter(Boolean))].slice(0, 6);
  const bestPhrases = data.filter(r => r.bestPhrase && r.bestPhrase.length > 5).slice(0, 5).map(r => ({ phrase: r.bestPhrase, cat: r.categoryLabel || r.category, sentiment: r.sentiment }));
  const negIssues = data.filter(r => r.sentiment === '불만' && r.coreIssue).map(r => r.coreIssue).slice(0, 5);
  const ANALYSIS_INDEX = {
    generatedAt: new Date().toISOString().slice(0, 16),
    total,
    resolvedRate: Math.round(resolved / total * 100),
    unresolvedRate: Math.round(unresolved / total * 100),
    resolved, unresolved,
    sentiment: { pos: sentCount.만족, neu: sentCount.중립, neg: sentCount.불만, posRate: Math.round(sentCount.만족 / total * 100), negRate: Math.round(sentCount.불만 / total * 100) },
    agentQuality: { good: scriptGood, ok: scriptOk, improve: scriptImprove, goodRate: Math.round(scriptGood / total * 100), improveRate: Math.round(scriptImprove / total * 100) },
    topCats, allCats, topIssues, improvements, bestPhrases, negIssues,
  };
  return { sttRaw, ANALYSIS_INDEX };
}

// 문자열 리터럴 내부 괄호를 무시하고 블록 끝(매칭 닫는 괄호)을 찾는다.
function findJsonEnd(html, start) {
  const open = html[start], close = open === '[' ? ']' : '}';
  let depth = 0, inStr = false, esc = false;
  for (let k = start; k < html.length; k++) {
    const ch = html[k];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true; else if (ch === open) depth++; else if (ch === close) { depth--; if (depth === 0) return k + 1; }
  }
  return -1;
}
// const/var/let 어느 선언이든 'VARNAME = <값>' 값 부분만 교체 (선언 키워드 보존)
function replaceBlock(html, varName, newContent) {
  const re = new RegExp('(const|var|let)\\s+' + varName + '\\s*=\\s*');
  const m = re.exec(html);
  if (!m) { throw new Error('블록 못 찾음: ' + varName); }
  const valStart = m.index + m[0].length;
  const j = findJsonEnd(html, valStart);
  if (j === -1) { throw new Error('블록 종료 못 찾음: ' + varName); }
  return html.slice(0, m.index) + m[1] + ' ' + varName + '=' + newContent + html.slice(j);
}

(async () => {
  process.stdout.write('stt_analysis.json 다운로드: ' + URL + ' ... ');
  const res = await fetch(URL);
  if (!res.ok) throw new Error('다운로드 실패 ' + res.status);
  const data = await res.json();
  if (!Array.isArray(data) || !data.length) throw new Error('분석 데이터 비어있음');
  console.log(data.length + '건');

  const { sttRaw, ANALYSIS_INDEX } = buildBlocks(data);

  let html = fs.readFileSync(HTML, 'utf8');
  html = replaceBlock(html, 'STT_RAW', JSON.stringify(sttRaw));
  html = replaceBlock(html, 'ANALYSIS_INDEX', JSON.stringify(ANALYSIS_INDEX));
  fs.writeFileSync(HTML, html, 'utf8');

  const months = {};
  sttRaw.forEach(r => { const k = r.d.slice(0, 7); months[k] = (months[k] || 0) + 1; });
  console.log('✅ STT 블록 교체 완료 —', sttRaw.length, '건 / 월별', JSON.stringify(months));
  console.log('   해결률', ANALYSIS_INDEX.resolvedRate + '% · 만족', ANALYSIS_INDEX.sentiment.posRate + '% · 우수응대', ANALYSIS_INDEX.agentQuality.goodRate + '%');
})().catch(e => { console.error('❌', e.message); process.exit(1); });
