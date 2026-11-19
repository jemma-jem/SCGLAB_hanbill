/**
 * Cloudflare Pages Function — 제안서 '바로 보기' 추적 리다이렉트
 * ────────────────────────────────────────────────────────────────────────
 * 경로: /p?r=<지자체명>
 *   1) Apps Script(action=click)를 서버사이드로 호출해 '제안서클릭로그' 시트에 1건 기록
 *      (fire-and-forget: waitUntil 로 응답을 기다리지 않아 리다이렉트가 지연되지 않음)
 *   2) 즉시 302 → 드라이브 PDF(/view)
 *
 * 효과: 수신자는 '중간 페이지/로그인 요구 없이' 클릭 한 번에 PDF가 바로 열리고,
 *       대시보드의 '제안서 열람(클릭)' 수치는 기존과 동일하게 집계된다.
 *
 * ※ 이 경로는 외부 수신자(지자체)가 로그인 없이 접근해야 하므로
 *   _middleware.js 의 공개 경로(PUBLIC_PATHS)에 '/p' 를 등록해 두었다.
 */

// 표준 제안서 PDF (Apps Script CONFIG.PROPOSAL_PDF_ID 와 동일)
const PDF_URL = 'https://drive.google.com/file/d/1XGJYhdaKbckUEl0aQT5-GO8x4KsM0UIh/view';

// Apps Script 웹앱 /exec (action=click 이 클릭 1건을 로깅). 공개 배포 URL.
const APPS_SCRIPT_EXEC =
  'https://script.google.com/macros/s/AKfycbzL-VwRDcNCxBZ2ftrrGZQVQA91poYEVd-l56w20OQZ9habN4Fsh2LFogVcN3nLHWlW/exec';

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const region = url.searchParams.get('r') || '';

  // 클릭 로깅 — 응답을 기다리지 않고 백그라운드로(리다이렉트 지연 0).
  try {
    const logUrl = APPS_SCRIPT_EXEC + '?action=click&r=' + encodeURIComponent(region);
    context.waitUntil(fetch(logUrl, { method: 'GET' }).catch(() => {}));
  } catch (_) { /* 로깅 실패해도 PDF는 열리게 둔다 */ }

  // 바로 PDF 로 이동 (top-level 302 → 샌드박스/로그인 문제 없음).
  return Response.redirect(PDF_URL, 302);
}
