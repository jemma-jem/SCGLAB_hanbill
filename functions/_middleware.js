/**
 * Cloudflare Pages Functions — 전 페이지 ID/PW 로그인 게이트
 * ────────────────────────────────────────────────────────────────────────
 * 이 파일은 Cloudflare Pages 로 배포했을 때만 동작한다(모든 요청 앞단에서 실행).
 *   - 세션 쿠키가 유효하면 그대로 통과(정적 파일 서빙)
 *   - 없으면 /login 으로 보내 ID/PW 입력을 요구
 *   - 로그인 성공 시 HMAC 서명된 세션 쿠키(HttpOnly)를 발급
 * ⚠️ GitHub Pages 로 열면 이 함수가 무시되어 게이트가 걸리지 않는다.
 *    실제 접근 통제를 위해서는 반드시 Cloudflare Pages 로 서빙해야 한다.
 *
 * 필수 환경변수 (Cloudflare Pages → Settings → Environment variables):
 *   AUTH_USERS     : 계정 JSON. 예) {"gangsb":"비번1","partner01":"비번2"}
 *                    (아이디는 이메일이든 사번이든 자유. 값은 비밀번호)
 *   SESSION_SECRET : 세션 쿠키 서명용 임의의 긴 랜덤 문자열
 * 선택 환경변수:
 *   SESSION_HOURS  : 로그인 유지 시간(기본 12시간)
 */

const COOKIE = 'hb_session';
const UI_COOKIE = 'hb_user';   // 표시용(비보안) — 포털 헤더에 사용자명 노출용

// 로그인 없이 누구나 볼 수 있는 공개 경로(화이트리스트).
// 여기에 넣은 페이지는 세션이 없어도 그대로 서빙된다.
//   예) 한전ON 가이드는 대외 안내용이라 공개.
const PUBLIC_PATHS = new Set([
  '/hanjeon-on-guide.html',
]);

const enc = new TextEncoder();

function b64urlEncode(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  return decodeURIComponent(escape(atob(str)));
}
function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function makeToken(user, secret, hours) {
  const payload = user + '|' + (Date.now() + hours * 3600 * 1000);
  return b64urlEncode(payload) + '.' + (await hmacHex(secret, payload));
}
async function verifyToken(token, secret) {
  if (!token || !secret) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = b64urlDecode(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!timingSafeEqual(sig, await hmacHex(secret, payload))) return null;
  const bar = payload.lastIndexOf('|');
  const user = payload.slice(0, bar);
  const exp = Number(payload.slice(bar + 1));
  if (!exp || Date.now() > exp) return null;
  return user;
}
function getCookie(request, name) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? m[1] : '';
}
function safePath(p) {
  p = (p || '').toString();
  if (!p.startsWith('/') || p.startsWith('//')) return '/';
  return p;
}

function loginHTML(error, next) {
  const err = error
    ? '<div class="err">' + error + '</div>'
    : '';
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>로그인 · SCGLAB 한빌</title>
<style>
:root{--sky:#0EA5E9;--sky-dark:#075985;--bg:#0b1220}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  font-family:'Malgun Gothic',system-ui,sans-serif;
  background:radial-gradient(1200px 600px at 50% -10%,#123 0,#0b1220 60%)}
.card{width:340px;max-width:92vw;background:#fff;border-radius:16px;padding:30px 26px;
  box-shadow:0 20px 60px rgba(0,0,0,.45)}
.brand{font-size:12px;letter-spacing:1px;color:var(--sky);font-weight:700;text-align:center}
h1{font-size:19px;color:#0f172a;margin:6px 0 2px;text-align:center}
.sub{font-size:12px;color:#64748b;text-align:center;margin-bottom:20px}
label{display:block;font-size:12px;color:#475569;font-weight:600;margin:12px 0 5px}
input{width:100%;padding:11px 12px;border:1px solid #cbd5e1;border-radius:9px;font-size:14px;font-family:inherit}
input:focus{outline:none;border-color:var(--sky);box-shadow:0 0 0 3px rgba(14,165,233,.15)}
button{width:100%;margin-top:18px;padding:12px;border:none;border-radius:9px;cursor:pointer;
  background:var(--sky-dark);color:#fff;font-size:14px;font-weight:700;font-family:inherit}
button:hover{background:#0c4a6e}
.err{background:#FEE2E2;color:#991B1B;font-size:12px;padding:9px 12px;border-radius:8px;margin-bottom:8px;text-align:center}
.foot{margin-top:16px;font-size:11px;color:#94a3b8;text-align:center;line-height:1.6}
</style></head><body>
<form class="card" method="POST" action="/login" autocomplete="off">
  <div class="brand">SCGLAB · 한빌 영업 AI</div>
  <h1>로그인</h1>
  <div class="sub">허가된 계정만 접근할 수 있습니다</div>
  ${err}
  <input type="hidden" name="next" value="${(next || '/').replace(/"/g, '&quot;')}">
  <label for="id">아이디</label>
  <input id="id" name="id" type="text" required autofocus>
  <label for="pw">비밀번호</label>
  <input id="pw" name="pw" type="password" required>
  <button type="submit">로그인</button>
  <div class="foot">문의: 영업기획팀 · hanbill@scglab.com</div>
</form></body></html>`;
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const secret = env.SESSION_SECRET || '';
  const hours = Number(env.SESSION_HOURS || 12);

  // ── 공개 경로: 로그인 없이 그대로 통과 ──
  if (PUBLIC_PATHS.has(url.pathname)) {
    return next();
  }

  // ── 로그아웃 ──
  if (url.pathname === '/logout') {
    const h = new Headers({ Location: '/login' });
    h.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    h.append('Set-Cookie', `${UI_COOKIE}=; Path=/; Secure; SameSite=Lax; Max-Age=0`);
    return new Response(null, { status: 302, headers: h });
  }

  // ── 로그인 페이지 / 처리 ──
  if (url.pathname === '/login') {
    if (request.method === 'POST') {
      const form = await request.formData();
      const id = (form.get('id') || '').toString();
      const pw = (form.get('pw') || '').toString();
      const nextPath = safePath(form.get('next'));
      let users = {};
      try { users = JSON.parse(env.AUTH_USERS || '{}'); } catch (e) { users = {}; }
      const stored = Object.prototype.hasOwnProperty.call(users, id) ? String(users[id]) : null;
      const ok = !!secret && stored !== null && pw.length > 0 && timingSafeEqual(pw, stored);
      if (ok) {
        const token = await makeToken(id, secret, hours);
        const h = new Headers({ Location: nextPath });
        const base = `Path=/; Secure; SameSite=Lax; Max-Age=${hours * 3600}`;
        h.append('Set-Cookie', `${COOKIE}=${token}; HttpOnly; ${base}`);
        h.append('Set-Cookie', `${UI_COOKIE}=${encodeURIComponent(id)}; ${base}`);
        return new Response(null, { status: 302, headers: h });
      }
      return new Response(loginHTML('아이디 또는 비밀번호가 올바르지 않습니다.', nextPath),
        { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    // GET
    const nextPath = safePath(url.searchParams.get('next'));
    const user = await verifyToken(getCookie(request, COOKIE), secret);
    if (user) return Response.redirect(url.origin + nextPath, 302);
    return new Response(loginHTML('', nextPath),
      { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  // ── 그 외 모든 경로: 인증 필요 ──
  const user = await verifyToken(getCookie(request, COOKIE), secret);
  if (!user) {
    const target = '/login?next=' + encodeURIComponent(url.pathname + url.search);
    return Response.redirect(url.origin + target, 302);
  }
  return next();
}
