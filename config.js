/**
 * 배포 설정
 *
 * APPS_SCRIPT_URL 에 Apps Script 웹앱 주소를 넣으세요.
 * (Apps Script 편집기 → 배포 → 새 배포 → 웹 앱 → 배포 후 나오는 주소, /exec 로 끝납니다)
 *
 * 주의: 이 주소는 비밀번호가 아닙니다. 웹앱이 '모든 사용자' 공개로 배포되므로
 * 브라우저 소스에 그대로 노출됩니다. 그래서 이 파일은 git에 포함해 배포합니다
 * (.gitignore 에 넣으면 Cloudflare Pages 배포본에 파일이 빠져 앱이 동작하지 않습니다).
 * 외부인 접근 차단은 Cloudflare Access 로 처리합니다.
 */
window.APP_CONFIG = {
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbxSkD_25p8F5QcyicX4scyschjPm0CdP9-ZmxZtnH0lvPaWqTYdHPpvt5C1Xzg-PRe_dg/exec',

  // 목록 자동 갱신 주기(밀리초). 다른 직원이 입력한 기록이 보이기까지의 시간입니다.
  // 본인이 저장한 기록은 이 주기와 무관하게 즉시 반영됩니다.
  POLLING_INTERVAL_MS: 10000,
};
