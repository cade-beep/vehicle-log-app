# 💳 차량 사용일지 작성 앱 빌링 및 서브스크립션 관리 계획서 (Billing & Subscription Management Plan)

## 1. 개요 (Overview)
본 문서는 **차량 사용일지 작성 앱 (Vehicle Usage Log App)**의 서비스 운영 비용 최적화, 결제 보안 및 구글/클라우드플레어 서브스크립션 쿼터 관리 방침을 정의합니다. 본 프로젝트는 **월 0원($0.00/month)**의 영구 무료 플랜(Free-Tier Serverless Architecture)을 목표로 설계되었습니다.

---

## 2. 서비스별 빌링 및 서브스크립션 명세 (Subscription & Billing Specifications)

| 서비스 구분 | 적용 요금제 (Tier) | 무료 쿼터 한도 (Free Quota) | 주 월간 예상 비용 | 비고 / 쿼터 초과 대비 |
| :--- | :--- | :--- | :--- | :--- |
| **Cloudflare Pages** | Pages Free Plan | - 무제한 대역폭 (Unlimited Bandwidth)<br>- 무제한 정적 요청<br>- 무료 SSL/TLS 인증서 | **$0.00** | 정적 자산(HTML, CSS, JS) 호스팅 |
| **Google Apps Script** | Consumer Free Tier | - 일일 20,000회 URL Fetch/GET/POST<br>- 일일 90분 총 실행 시간<br>- 동시 실행 30개 | **$0.00** | Web App REST API 백엔드 역할 |
| **Google Sheets API** | Google Drive Free (15GB) | - 15GB 저장공간 (운행일지 10만 건당 약 15MB 소요) | **$0.00** | 데이터베이스(DB) 저장소 |
| **Cloudflare DNS & WAF** | Free Plan | - 무료 DDoS 방어 및 기본 WAF 규칙 | **$0.00** | 보안 헤더(`_headers`) 및 트래픽 보호 |

---

## 3. 리소스 쿼터 보호 및 과금 방지 장치 (Quota Safeguards & Cost Control)

### 3.1. 스마트 폴링 인터벌 제어 (`config.js`)
- Apps Script 요청 폭주로 인한 쿼터 고갈을 방지하기 위해 클라이언트 목록 자동 갱신 주기를 **30,000ms (30초)**로 고정 설정.
- 단일 활성 사용자 기준 일일 최대 요청 수: 약 2,880회 (구글 무료 쿼터 20,000회의 14.4% 수준 유지).

### 3.2. 페이로드 크기 및 실행 시간 제한 (`Code.gs`)
- `MAX_PAYLOAD_BYTES`: 요청 1건당 최대 **8KB (8,192 Bytes)**로 제한하여 악성 대용량 데이터로 인한 Apps Script Execution Time 고갈 차단.
- `LOCK_TIMEOUT_MS`: Script Lock 타임아웃을 **10초**로 설정하여 동시성 제어 및 데드락 방지.

### 3.3. 유효성 검증을 통한 무효 요청 차단
- 허용 차량 번호 화이트리스트(`['0704', '8318', '1213', '5486']`), 음수 주행거리 및 무효 입력값 서버측 Pre-validation 수행으로 불필요한 시트 Write 연산 최소화.

---

## 4. 결제 보안 및 과금 위험 준수 (Payment & Compliance Security)

1. **Zero Paid-API Architecture**:
   - 유료 외부 API(예: Google Maps API, 유료 결제 모듈, 외부 SMS/알림톡 API)를 직접 호출하지 않으며, 결제 수단(신용카드) 등록 없이 동작 가능하도록 설계.
2. **신용카드 정보 탈취 위험 차단**:
   - 앱 내에서 직접적인 결제 수단 입력을 받지 않으며, 사용자 카드 정보 저장/보관 로직이 존재하지 않음 (PCI-DSS 해당 사항 없음).
3. **DDoS 트래픽으로 인한 과금 공격 차단**:
   - Cloudflare 글로벌 Anycast 네트워크 및 HTTP/2-HTTP/3 TLS 암호화 적용으로 백엔드(Google Apps Script) 직접 노출 최소화.

---

## 5. 모니터링 및 쿼터 경보 프로토콜 (Quota Monitoring Protocol)

1. **Google Apps Script 대시보드 모니터링**:
   - [script.google.com](https://script.google.com) 대시보드의 '대시보드(Executions)' 메뉴를 통해 일일 실패율 및 실행 시간 추적.
   - 오류 발생 시 텔레그램/이메일 자동 알림 함수 구성을 권장.
2. **Cloudflare Web Analytics**:
   - Cloudflare Dashboard 내 무료 Web Analytics를 활용하여 정적 자산 트래픽 이상 징후(DDoS 등) 감시.

---

## 6. 업그레이드 트랜지션 기준 (Upgrade Triggers)

사용자 규모 및 운행일지 등록 트래픽 증가 시 아래 기준에 맞춰 유료 서브스크립션 전환을 검토합니다.

- **Google Workspace Business Starter** (월 $6/사용자):
  - 일일 운행일지 등록 건수가 15,000건을 초과하여 Apps Script Daily Execution limits에 도달할 경우.
  - Apps Script 실행 시간이 일일 90분을 초과할 경우 (Business 계정은 6시간/일 제공).
- **Cloudflare Workers/Pages Paid Plan** ($5/월):
  - 정적 자산 구축 및 Serverless Workers 기능 확장이 필요한 경우.

---

## 7. 긴급 차단 매뉴얼 (Emergency Billing Kill-Switch Runbook)

비정상 트래픽이나 무한 루프로 인한 구글 쿼터 차단 발생 시:
1. `config.js`의 `APPS_SCRIPT_URL`을 일시적으로 빈 값으로 변경하여 클라이언트 요청 중단.
2. 구글 Apps Script 편집기에서 '웹 앱 배포 관리' -> '배포 비활성화(Disable)' 처리.
3. 시트 접근 권한을 '나에게만 공개'로 재설정하여 API 트래픽 수신 차단.
