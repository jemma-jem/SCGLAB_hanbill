# 🤖 영업비서 (Sales Assistant · 한빌이)

## 목적
내부 고객 DB(CUST_DB)와 상담 이력, STT 분석 데이터를 Claude/Groq AI와 결합하여
영업 담당자의 질문에 논리적이고 영업 지향적인 답변을 제공하는 AI 어시스턴트.

## 핵심 기능
- **묻고 답하기**: 고객번호·질문 입력 → 고객 이력 + AI 분석 답변
- **Claude(Anthropic) 연동**: 내부 데이터 + Claude 일반지능 결합, 스트리밍 응답
- **Groq 폴백**: 무료 API 대체 경로
- **영업 특화 시스템 프롬프트**: 지자체 시장·경쟁사·영업 전략 컨텍스트 내장
- **지도 전략 연동**: 지역별 유지/진입 전략 초안 3단계 액션플랜

## 데이터 출처 (Google Drive: AX 폴더)
| 데이터 | 파일 |
|--------|------|
| 고객 DB | `customer_index.js` (CUST_DB) |
| 상담·녹취 | `recording_index.js`, `stt_index.js` |

## API 키 설정
챗봇 헤더 ⚙️ → Claude API 키(`sk-ant-…`) 또는 Groq 키 입력 시 AI 자유질의 활성화.
(키는 브라우저 localStorage에만 저장, 외부 전송 없음)

## 사용법
`index.html`을 열면 영업비서 챗봇이 자동으로 열림.
