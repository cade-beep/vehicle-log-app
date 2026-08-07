# 🚗 스마트 차량 사용일지 작성 앱 (Vehicle Usage Log App)

보안(Security-First) 아키텍처와 모던 Web UI/UX가 적용된 스마트 차량 운행일지 관리 시스템입니다.

![App Screenshot](https://img.shields.io/badge/Security-Protected-10b981?style=for-the-badge&logo=shields.io) ![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)

---

## 🌟 주요 기능
1. **스마트 운행일지 등록**
   - 운행일자, 운전자 성명, 차량번호, 운행구분(업무용, 출퇴근, 비업무용, 정비 등), 출발/도착지 입력
   - 출발/도착 계기판(km) 입력 시 **주행거리 자동 계산** 및 유효성 검증
2. **실시간 스마트 대시보드 통계**
   - 총 누적 주행거리, 총 운행 건수, 업무용 운행 비율, 건당 평균 주행거리 실시간 집계
3. **실시간 검색 & 필터링**
   - 운전자명, 차량번호, 목적지 등 키워드 필터링
4. **엑셀 호환 CSV 내보내기**
   - UTF-8 BOM 지원으로 한글 깨짐 없이 Excel에서 바로 열리는 데이터 내보내기
5. **Security-First 설계**
   - `.env` 및 민감 정보의 Git 추적 자동 차단
   - DOM XSS 공격 방지를 위한 HTML Escape Sanitization

---

## 🔐 보안 및 개발 환경 설정 가이드

본 프로젝트는 보안 유출 방지를 위해 `.env` 파일을 깃허브에 공유하지 않습니다. 다운로드 또는 Clone 후 아래 절차에 따라 환경 변수를 설정하세요.

### 1. 프로젝트 다운로드 (Clone)
```bash
git clone https://github.com/cade-beep/vehicle-log-app.git
cd vehicle-log-app
```

### 2. `.env` 환경 설정 파일 준비
깃허브에 업로드되어 있는 `.env.example` 템플릿 파일을 복사하여 `.env` 파일로 생성합니다.

**Windows (PowerShell):**
```powershell
Copy-Item .env.example .env
```
**Mac / Linux:**
```bash
cp .env.example .env
```

### 3. `.env` 파일 수정
생성된 `.env` 파일을 열어 자신의 환경에 맞는 비밀키나 API Key를 입력하세요. (`.env` 파일은 `.gitignore`에 등록되어 깃허브에 커밋되지 않습니다.)

---

## 📂 프로젝트 구조

```
vehicle-log-app/
├── .gitignore          # Git 추적 제외 (민감한 파일 .env 보호)
├── .env.example        # 환경 변수 안내용 대체 템플릿 (깃허브 공유)
├── .env                # 로컬 전용 설정 파일 (Git 커밋 금지)
├── index.html          # 메인 대시보드 및 입력 UI
├── style.css           # Glassmorphic Dark UI Design System
├── app.js              # 데이터 처리, XSS 방지, CSV Export, LocalStorage
├── SECURITY_PLAN.md    # 보안 위험성 진단 및 아키텍처 문서
├── BILLING_PLAN.md     # 빌링, 서브스크립션 및 리소스 쿼터 보호 계획서
└── README.md           # 프로젝트 가이드
```

---

## 💳 빌링 및 쿼터 관리 방침
자세한 빌링 명세, 쿼터 제어 및 비용 최적화 정책은 [`BILLING_PLAN.md`](./BILLING_PLAN.md) 문서를 참고하세요.
- Cloudflare Pages & Google Apps Script 영구 무료 요금제 ($0/월) 운용
- 요청 과금 방지를 위한 폴링 주기(30초) 및 페이로드 크기(8KB) 제한
- Zero Paid API 수신 구조로 예기치 않은 과금 전면 차단
- 쿼터 모니터링 및 비상 시 긴급 차단 매뉴얼(Kill-Switch Runbook) 수립

---

## 🛡️ 보안 방침
자세한 보안 진단 및 대책은 [`SECURITY_PLAN.md`](./SECURITY_PLAN.md) 문서를 참고하세요.
- XSS (Cross-Site Scripting) 방어
- 주행거리 역전 입력 차단
- LocalStorage 및 구글 시트 샌드박싱
