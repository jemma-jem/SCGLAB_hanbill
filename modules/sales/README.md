# 🗺️ 영업지원 (Sales Support)

## 목적
전국 250개 지자체 대상 한전 전기요금 전자청구 대행 서비스 **한빌**의
빌링 영업 현황을 지도 기반으로 시각화하고, 미개척 지역 공략 전략을 지원한다.

## 핵심 기능
- **전국 지자체 지도**: 시군구별 빌링사(한빌/누리빌/한전산업개발) 점유 현황 색상 표시 (252개 경로)
- **빌링 통계**: 대표 빌링 건수(G열), 세부 부서 수, 한빌 점유율(80/250=32%), 미개척 170개소
- **지도 클릭 → 영업 전략 제안**: 한빌 지역=유지 전략 / 타사·미선점=진입 제안 (Claude 연동)
- **점유율 도넛·시장 분석 차트**

## 데이터 출처 (Google Drive: AX 폴더)
| 데이터 | 파일 |
|--------|------|
| 지도 경로 | `korea-map.json`, `korea-map-slim.json`, `map-paths.js`, `prerender_map.js` |
| 빌링사 매핑 | `_company_map.json`, `_company_map_block.txt` |
| 빌링 건수(G열) | 원천: Google Sheets `174gXTU…` |
| 대시보드 집계 | `dashboard_data.json`, `dashboard_compact.js` |

## 사용법
`index.html`을 브라우저로 열면 영업지원(대시보드) 화면으로 진입.
