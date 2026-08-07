# 🛡️ 차량 사용일지 앱 보안 위험성 진단 및 대응 계획서 (Security Assessment & Architecture Plan)

## 1. 개요 (Overview)
본 프로젝트 **차량 사용일지 작성 앱 (Vehicle Usage Log App)**은 운행 기록, 주행거리, 목적, 사용자 정보 등을 관리하는 애플리케이션입니다. 깃허브 오픈소스 공유 및 실제 사용 시 발생할 수 있는 보안 위험 요소를 사전 점검하고 이를 철저하게 차단하는 아키텍처로 설계되었습니다.

---

## 2. 보안 위험 요소 진단 (Security Threats Risk Matrix)

| 위험 요소 | 위험도 | 발생 가능한 문제 | 대응 및 방어 대책 |
| :--- | :---: | :--- | :--- |
| **민감 정보 노출** | 🔴 High | API Key, Secret Key, DB 접근 비밀번호가 Git 커밋 이력에 포함되어 깃허브에 노출 | `.gitignore`에 `.env` 및 Key 파일 철저 분리, `.env.example` 템플릿 제공 |
| **XSS (Cross-Site Scripting)** | 🔴 High | 운행 목적, 사용자 이름, 차량 번호 등에 악성 `<script>` 삽입 시 브라우저 세션 탈취 | DOM 바인딩 시 `textContent` / Sanitization 함수를 통해 HTML 이스케이프 처리 |
| **무분별한 데이터 위변조** | 🟡 Medium | 출발 주행거리 > 도착 주행거리 역전, 음수 거리 입력으로 통계 데이터 왜곡 | strict Input Validation (도착 계기판 >= 출발 계기판 검증) 및 예외 처리 |
| **Local Storage 탈취** | 🟡 Medium | XSS나 브라우저 취약점을 통해 저장된 운행 기록 일괄 누출 | 저장 데이터 인코딩/체크섬 검증 구조 마련 |
| **CSRF & Injection** | 🟢 Low | 외부 입력 폼을 통한 인젝션 공격 | Client-side 렌더링 시 파싱 안전성 확보 및 정형 데이터 포맷(JSON) 엄격 유지 |

---

## 3. 세부 대응 개발 계획

### 3.1. 깃허브 보안 관리
- **추적 금지 파일**: `.env`, `node_modules/`, `*.pem`, `*.key`, `google-services.json` 등
- **안전한 대체 파일 제공**: `.env.example`을 제공하여 실제 비밀키 노출 없이 타 개발자가 다운로드하여 사용할 수 있도록 유도

### 3.2. 입력값 검증 및 Sanitization (XSS 방지)
```javascript
// HTML Escape 함수 적용으로 악성 스크립트 실행 방지
function escapeHTML(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
```

### 3.3. 주행 거리 데이터 정밀 검증
- 출발 계기판 거리(Km) $\le$ 도착 계기판 거리(Km)
- 주행거리 = 도착 계기판 거리 - 출발 계기판 거리 (자동 정밀 계산)
- 날짜 및 유효성 범위 체크

---

## 4. 결론
본 앱은 클라이언트 및 깃허브 배포 전 과정에서 **Zero-Trust 보안 관점**을 적용하여 민감한 개인 정보나 API Key 노출을 근본적으로 차단합니다.
