## Goal Description
차량 사용일지 앱(Vehicle Usage Log App)의 UI/UX가 데스크톱(PC)과 모바일 환경에서 완벽하게 동작하고 렌더링되는지 제가 **직접** 크롬 브라우저를 띄워 10가지 이상의 환경/시나리오에서 검증합니다. 

이를 위해 Node.js 환경에서 크롬 브라우저를 제어하는 `Puppeteer` 라이브러리를 사용하여, 다양한 기기(아이폰, 갤럭시, 태블릿, 데스크톱)와 상태(라이트/다크 모드, 입력 폼 활성화 등)를 시뮬레이션하고 스크린샷을 촬영합니다. 촬영된 10장 이상의 스크린샷을 제가 직접 시각적으로 분석(vision)하여 레이아웃 깨짐, 글자 겹침, 여백 문제 등을 찾아내고 보고합니다.

## User Review Required
> [!IMPORTANT]
> 이 테스트를 수행하기 위해 프로젝트 폴더 내에 일시적으로 크롬 제어용 라이브러리인 `puppeteer`를 설치(`npm install puppeteer --no-save`)하고, 로컬 서버(`npx serve`)를 백그라운드에서 실행해야 합니다. 파일 원본은 수정되지 않습니다. 계획에 동의하시면 진행(Proceed) 버튼을 눌러주세요.

## Open Questions
- 특별히 UI가 깨질까봐 걱정되는 특정 모바일 기기(예: 화면이 매우 작은 iPhone SE 등)가 있다면 말씀해 주세요. 테스트 시나리오에 우선적으로 반영하겠습니다.

## Proposed Changes
UI 테스트를 자동화하기 위한 스크립트 파일을 작성합니다.

### Automated Testing Script
#### [NEW] `tests/visual_audit.js`
크롬(Chrome)을 Headless(화면 없는) 모드로 10번 이상 실행하여 다음 시나리오들을 테스트하고 스크린샷을 저장하는 스크립트입니다.
1. Desktop 1080p (Light Mode) - 기본 레이아웃
2. Desktop 1080p (Dark Mode) - 다크모드 색상 대비 검증
3. iPhone SE (가장 작은 모바일 화면) - 컴팩트 레이아웃 붕괴 확인
4. iPhone 14 Pro Max (대화면 모바일) 
5. iPad Mini (태블릿 세로 모드)
6. Galaxy Z Fold (특이 비율 모바일)
7. 폼 입력 중 상태 (입력창 포커스 시 모바일 키보드 및 여백 확보 확인용 시뮬레이션)
8. 유효성 검사 에러 표시 상태 (필수값 누락 후 저장 버튼 클릭 시)
9. 운행일지 데이터가 10건 이상 누적된 테이블 스크롤 상태 (PC)
10. 운행일지 데이터가 10건 이상 누적된 테이블 스크롤 상태 (Mobile)

## Verification Plan

### Automated Tests
1. **서버 실행**: `npx serve -p 8080 .` 명령어로 백그라운드 로컬 서버 실행.
2. **의존성 설치**: `npm install puppeteer --no-save` 실행.
3. **오딧 실행**: `node tests/visual_audit.js` 명령어를 실행하여 10개 이상의 스크린샷을 `tests/screenshots/` 폴더에 생성.

### Manual Verification
1. 스크립트가 생성한 스크린샷 파일들을 제 비전(Vision) 분석 기능을 통해 하나씩 직접 열어봅니다.
2. PC, 모바일, 태블릿 환경에서 버튼의 크기, 글자 짤림, 여백(Margin/Padding), 다크모드 색상 반전 오류 등이 없는지 확인합니다.
3. 최종적으로 검증된 내용과 발견된 UI/UX 결함을 `walkthrough.md` 보고서로 종합하여 사용자에게 제출합니다.
