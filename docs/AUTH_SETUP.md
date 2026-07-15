# 로그인(ID/PW) 게이트 설정 가이드

이 저장소는 **Cloudflare Pages Functions**(`functions/_middleware.js`)로 전 페이지에
ID/PW 로그인 게이트를 겁니다. 로그인하지 않으면 HTML 자체가 내려가지 않아
소스보기로도 우회할 수 없는 **실제 접근 통제**입니다.

> ⚠️ **GitHub Pages 로 열면 게이트가 동작하지 않습니다.**
> Pages Functions 는 Cloudflare Pages 에서만 실행됩니다. 실제 차단을 위해서는
> 반드시 **Cloudflare Pages** 로 서빙하세요(아래 1단계). 민감 데이터가 있으므로
> 전환 후에는 GitHub Pages 공개를 꺼두는 것을 권장합니다.

---

## 1. Cloudflare Pages 로 배포 (약 10분, 무료)

1. <https://dash.cloudflare.com> 가입/로그인 → **Workers & Pages → Create → Pages → Connect to Git**
2. 저장소 **`jemma-jem/SCGLAB_hanbill`** 선택
3. Build 설정
   - Framework preset: **None**
   - Build command: **(비움)**
   - Build output directory: **`/`** (루트)
4. **Save and Deploy** → `https://<프로젝트>.pages.dev` URL 생성
   - 포털: `https://<프로젝트>.pages.dev/`
   - 대시보드: `https://<프로젝트>.pages.dev/ax-admin-v2.html`

이후 GitHub 에 push 하면 Cloudflare Pages 가 자동 재배포합니다(기존 GitHub Actions 뉴스 수집도 그대로 동작).

---

## 2. 환경변수(계정·세션) 설정 — **필수**

Cloudflare Pages 프로젝트 → **Settings → Environment variables → Production**(및 Preview) 에 추가:

| 변수 | 필수 | 값 | 설명 |
|---|:---:|---|---|
| `AUTH_USERS` | ✅ | JSON 문자열 | 로그인 계정 목록(아이디:비밀번호) |
| `SESSION_SECRET` | ✅ | 긴 랜덤 문자열 | 세션 쿠키 서명 키(외부 노출 금지) |
| `SESSION_HOURS` | ⬜ | 숫자(기본 12) | 로그인 유지 시간 |

- **보안(Secret)으로 등록**하세요(값 암호화 저장). 저장소에는 어떤 비밀번호도 넣지 않습니다.
- 변수 저장 후에는 **재배포(Retry deployment)** 해야 반영됩니다.

### `AUTH_USERS` 형식 (JSON)
아이디는 이메일·사번·닉네임 등 자유롭게 지정할 수 있습니다.

```json
{"gangsb":"강한비번!23","jem":"또다른비번#7","partner01":"외부용비번%9"}
```

- 공동작업자·외부 사용자마다 **아이디/비밀번호 한 쌍**을 만들어 개별 전달하세요
  (누가 언제 쓸지 관리·회수가 쉬움).
- **계정 추가/삭제/비밀번호 변경** = 이 JSON 을 수정하고 저장 → 재배포. 그게 전부입니다.

### `SESSION_SECRET` 생성 예
아무 방법이나 무방(길고 무작위면 됨):
```bash
# 터미널에서
openssl rand -hex 32
```

---

## 3. 사용 흐름

1. 사용자가 사이트 접속 → 로그인 화면(`/login`)으로 이동
2. 전달받은 **아이디/비밀번호** 입력 → 통과 시 세션 쿠키 발급(기본 12시간 유지)
3. 포털(`/`)에서 대시보드 등 각 화면으로 이동
4. 우측 상단 **로그아웃** → 세션 종료(`/logout`)

허가되지 않은 아이디/비번은 통과할 수 없고, 로그인 전에는 어떤 페이지의 HTML 도 받을 수 없습니다.

---

## 4. 확장 방법

- 새 화면(HTML)을 저장소에 추가하면 **자동으로 같은 게이트로 보호**됩니다.
- 포털(`index.html`)의 카드 목록에 링크만 추가하면 메뉴에 노출됩니다.

---

## 5. 참고 / 한계

- 게이트는 **Cloudflare Pages 에서만** 동작합니다(GitHub Pages ❌).
- 비밀번호는 Cloudflare 환경변수(암호화 Secret)에만 저장되며 클라이언트로 내려가지 않습니다.
- 여러 사람이 같은 아이디를 공유해도 되지만, **1인 1계정**이 회수·감사에 유리합니다.
- 더 강한 보안이 필요하면(2단계 인증, 접속 로그, SSO) Cloudflare Access(이메일 OTP/구글 로그인)를
  추가로 얹을 수 있습니다.
