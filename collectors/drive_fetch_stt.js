/**
 * drive_fetch_stt.js
 * Google Drive에서 stt_analysis.json 을 찾아 로컬로 내려받는다.
 * (jemma-jem/stt 파이프라인은 분석 결과를 Drive에만 저장하므로, 라이브 동기화 전에 이 스크립트로 받아온다.)
 *
 * 필요 환경변수: GOOGLE_SERVICE_ACCOUNT_JSON (파이프라인과 동일 시크릿)
 * 선택 환경변수: STT_DRIVE_FILE_NAME (기본 stt_analysis.json)
 * 사용: node drive_fetch_stt.js <저장경로>
 *   - googleapis 는 파이프라인 워크스페이스(node_modules)에서 해석됨 (NODE_PATH 권장)
 */
const fs = require('fs');
const { google } = require('googleapis');

const OUT = process.argv[2] || 'stt_analysis.json';
const NAME = process.env.STT_DRIVE_FILE_NAME || 'stt_analysis.json';

(async () => {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  const drive = google.drive({ version: 'v3', auth });

  // 이름으로 검색 (공유 드라이브 포함), 가장 최근 수정본 선택
  const res = await drive.files.list({
    q: `name='${NAME}' and trashed=false`,
    fields: 'files(id,name,modifiedTime,size)',
    orderBy: 'modifiedTime desc',
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const file = (res.data.files || [])[0];
  if (!file) throw new Error(`Drive에서 '${NAME}' 를 찾지 못함 (서비스계정 공유 여부 확인)`);

  const dl = await drive.files.get(
    { fileId: file.id, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' }
  );
  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(OUT);
    dl.data.pipe(w).on('finish', resolve).on('error', reject);
  });
  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log(`✅ Drive에서 다운로드: ${file.name} (${kb}KB, 수정 ${file.modifiedTime}) → ${OUT}`);
})().catch(e => { console.error('❌ Drive 다운로드 실패:', e.message); process.exit(1); });
