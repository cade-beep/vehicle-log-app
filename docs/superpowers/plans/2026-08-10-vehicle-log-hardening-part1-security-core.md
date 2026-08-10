# 차량 사용일지 하드닝 — 1부: 보안·스키마·핵심 CRUD 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 무인증 상태의 운행일지 앱에 공용 암호 기반 인증·인가를 붙이고, 스키마를 20열로 확장해 수정·소프트삭제·복구·서버측 거리계산까지 안전하게 동작시킨다.

**Architecture:** Apps Script가 HMAC 서명 세션 토큰을 발급하고, 모든 요청은 `POST` 본문에 토큰을 실어 보낸다(헤더를 쓰면 CORS preflight가 발생하는데 Apps Script는 `OPTIONS`에 응답할 수 없다). 암호는 Script Properties에만 존재하며 저장소·프론트·시트 어디에도 없다. 시트 접근은 헤더 **이름** 기반 매핑이라 기존 열을 옮기지 않고 뒤에 7열만 추가한다.

**Tech Stack:** Google Apps Script (V8), Google Sheets, 바닐라 HTML/CSS/ES6+, Cloudflare Pages (정적, 빌드 없음), Node.js (테스트 하네스 전용 — 런타임 의존성 아님)

## Global Constraints

스펙 `docs/superpowers/specs/2026-08-10-vehicle-log-hardening-design.md`에서 그대로 옮긴 값이다. 모든 태스크에 암묵적으로 적용된다.

- 프레임워크·번들러·npm 런타임 의존성 없음. 정적 사이트 유지. 빌드 단계 없음.
- 목표 운영비 **$0/월**. 유료 서비스·새 인프라 추가 금지.
- 요청은 전부 `POST`, `Content-Type: text/plain;charset=utf-8`. **토큰은 헤더가 아니라 JSON 본문에** 넣는다.
- 암호는 **Script Properties에만** 둔다. 저장소·프론트엔드·시트에 절대 쓰지 않는다.
- 권한 판단은 **토큰의 `r` 필드에서만** 읽는다. 클라이언트가 보낸 값은 권한 판단에 쓰지 않는다.
- `LockService.tryLock(10000)`을 제거하지 않는다. 모든 쓰기(`create`/`update`/`delete`/`restore`)에 적용한다.
- 행 탐색은 인덱스가 아니라 `id`로 한다.
- **`status`가 공란이면 `ACTIVE`로 취급한다.** legacy 행이 목록에서 사라지면 안 된다.
- 폴링 주기 30초를 바꾸지 않는다. `MAX_PAYLOAD_BYTES: 8192`, `LOCK_TIMEOUT_MS: 10000` 유지.
- 타임존 `Asia/Seoul`. 날짜는 `yyyy-MM-dd`, 시간은 `HH:MM` 문자열.
- 사용자에게 스택 트레이스를 노출하지 않는다.
- 감사 로그에 **암호·토큰을 절대 기록하지 않는다.**
- 기존 UI의 시각적 정체성·레이아웃·반응형 동작을 유지한다. CSS 전면 교체 금지.
- 기존 `escapeHTML`, `AbortController` 타임아웃, `visibilitychange` 폴링 중단, `isRefreshing` 중복 방지, 렌더 시그니처 비교를 제거하지 않는다.

---

## 파일 구조

### 신규

| 파일 | 책임 |
|---|---|
| `apps-script/Auth.gs` | 암호 해시, 토큰 발급·검증, 속도 제한, `setPasscodes()`. 보안 표면 전체 |
| `apps-script/Audit.gs` | 감사 로그 기록·조회 |
| `auth.js` | 프론트 로그인 화면, 토큰 보관, 세션 상태. `window.Session` 노출 |
| `tests/harness.js` | Apps Script 전역 API를 메모리로 흉내 내는 Node 스텁 |
| `tests/run.js` | assert 기반 테스트 러너 |

### 수정

| 파일 | 변경 성격 |
|---|---|
| `apps-script/Code.gs` | 라우팅·시트 접근·검증. 인증 코드는 `Auth.gs`로 분리 |
| `app.js` | 모든 API 호출에 토큰 부착, 수정/삭제/복구 UI, 계기판 2칸 |
| `index.html` | 로그인 화면, 출발계기판 필드, 수정/복구 버튼 |
| `style.css` | 로그인 화면 스타일만 추가. 기존 규칙 수정 금지 |
| `config.js` | P11에서 새 배포 URL로 교체 (이 계획 범위 밖) |

### `.gs` 파일을 나누는 이유

Apps Script는 모든 `.gs` 파일을 하나의 전역 스코프로 합치므로 분리에 런타임 비용이 없다. `Code.gs`는 인증 추가 후 700줄을 넘게 되는데, **보안 표면은 따로 읽을 수 있어야 한다.** 기존 함수를 이동시키는 것이 아니라 신규 코드만 새 파일에 넣으므로 회귀 위험이 없다.

Apps Script 편집기에서 `Auth.gs`, `Audit.gs`를 **파일 + → 스크립트**로 각각 한 번 만들어야 한다(확장자는 자동).

---

## Task 1: 베이스라인 커밋과 테스트 하네스

지금 저장소에 테스트 인프라가 전혀 없다. 이후 모든 태스크가 이 하네스 위에서 검증된다.

**Files:**
- Create: `tests/harness.js`
- Create: `tests/run.js`
- Modify: `.gitignore` (마지막 줄에 추가)

**Interfaces:**
- Produces: `require('./harness').load(files)` → `{ sandbox, call(action, body), sheets, props, cache, reset() }`
- Produces: `assertEq(actual, expected, label)`, `assertThrows(fn, contains, label)`, `test(name, fn)`, `runAll()`

- [ ] **Step 1: 미커밋 작업분을 베이스라인으로 커밋**

앞으로 수정할 바로 그 파일들이다. 지금 상태를 못 박아야 회귀 시 되돌아올 지점이 생긴다.

```bash
cd "C:/Users/김규호/vehicle-log-app"
git add app.js index.html style.css
git commit -m "chore: baseline before production hardening

하드닝 착수 전 작업 중이던 변경분을 고정한다. 이후 태스크가 회귀 시
되돌아올 기준점."
git log --oneline -1
```

- [ ] **Step 2: 테스트 하네스 작성**

Apps Script 전역 API를 메모리로 흉내 낸다. `Utilities`의 암호 함수는 Node `crypto`로 실제 동작을 재현하므로, 여기서 통과한 서명·검증 로직은 실제 환경에서도 같게 동작한다.

`tests/harness.js`:

```javascript
/**
 * Apps Script 전역 API를 메모리로 흉내 내는 스텁.
 * 실제 스프레드시트 없이 Code.gs / Auth.gs / Audit.gs 를 실행해 검증한다.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function toBuf(v) {
  if (Buffer.isBuffer(v)) return v;
  if (Array.isArray(v)) return Buffer.from(v.map((b) => b & 0xff));
  return Buffer.from(String(v), 'utf8');
}

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const src = this.sheet.data[this.row - 1 + r] || [];
      const line = [];
      for (let c = 0; c < this.numCols; c++) {
        const v = src[this.col - 1 + c];
        line.push(v === undefined ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
  setValues(vals) {
    for (let r = 0; r < vals.length; r++) {
      const idx = this.row - 1 + r;
      while (this.sheet.data.length <= idx) this.sheet.data.push([]);
      for (let c = 0; c < vals[r].length; c++) {
        this.sheet.data[idx][this.col - 1 + c] = vals[r][c];
      }
    }
    return this;
  }
  setFontWeight() { return this; }
  setBackground() { return this; }
}

class FakeSheet {
  constructor(name) { this.name = name; this.data = []; }
  getRange(row, col, numRows, numCols) {
    return new FakeRange(this, row, col, numRows, numCols);
  }
  getLastRow() { return this.data.length; }
  getLastColumn() {
    return this.data.reduce((m, r) => Math.max(m, r.length), 0);
  }
  appendRow(arr) { this.data.push(arr.slice()); return this; }
  deleteRow(r) { this.data.splice(r - 1, 1); return this; }
  setFrozenRows() { return this; }
  autoResizeColumns() { return this; }
}

function buildSandbox(state) {
  return {
    console,
    JSON, Math, Date, Number, String, Array, Object, isFinite, isNaN, RegExp, Error,

    SpreadsheetApp: {
      openById: () => state.ss,
      getActiveSpreadsheet: () => state.ss,
      flush: () => {},
    },

    LockService: {
      getScriptLock: () => ({
        tryLock: () => { state.lockCount++; return state.lockAvailable; },
        releaseLock: () => { state.lockReleased++; },
      }),
    },

    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in state.props ? state.props[k] : null),
        setProperty: (k, v) => { state.props[k] = String(v); },
        setProperties: (o) => { Object.assign(state.props, o); },
        deleteProperty: (k) => { delete state.props[k]; },
      }),
    },

    CacheService: {
      getScriptCache: () => ({
        get: (k) => (k in state.cache ? state.cache[k] : null),
        put: (k, v) => { state.cache[k] = String(v); },
        remove: (k) => { delete state.cache[k]; },
      }),
    },

    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      getUuid: () => crypto.randomUUID(),
      sleep: (ms) => { state.slept += ms; },
      formatDate: (d, tz, fmt) => {
        const p = (n) => String(n).padStart(2, '0');
        const Y = d.getFullYear(), M = p(d.getMonth() + 1), D = p(d.getDate());
        const h = p(d.getHours()), m = p(d.getMinutes()), s = p(d.getSeconds());
        if (fmt === 'yyyy-MM-dd') return `${Y}-${M}-${D}`;
        return `${Y}-${M}-${D}T${h}:${m}:${s}+09:00`;
      },
      computeDigest: (algo, value) =>
        Array.from(crypto.createHash('sha256').update(toBuf(value)).digest()),
      computeHmacSha256Signature: (value, key) =>
        Array.from(crypto.createHmac('sha256', toBuf(key)).update(toBuf(value)).digest()),
      base64Encode: (v) => toBuf(v).toString('base64'),
      base64EncodeWebSafe: (v) =>
        toBuf(v).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      base64DecodeWebSafe: (s) =>
        Array.from(Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
      newBlob: (bytes) => ({ getDataAsString: () => toBuf(bytes).toString('utf8') }),
    },

    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({ _text: text, setMimeType() { return this; } }),
    },

    Logger: { log: () => {} },
  };
}

function load(files) {
  const dir = path.join(__dirname, '..', 'apps-script');
  const state = {
    sheets: new Map(),
    props: {},
    cache: {},
    lockAvailable: true,
    lockCount: 0,
    lockReleased: 0,
    slept: 0,
  };
  state.ss = {
    getSheetByName: (n) => state.sheets.get(n) || null,
    insertSheet: (n) => { const s = new FakeSheet(n); state.sheets.set(n, s); return s; },
  };

  const sandbox = buildSandbox(state);
  vm.createContext(sandbox);
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f });
  }

  // 실제 배포에서만 채우는 스프레드시트 ID를 테스트용으로 주입한다.
  vm.runInContext("CONFIG.SPREADSHEET_ID = 'test-sheet-id';", sandbox);

  return {
    sandbox,
    state,
    /** doPost를 통과시켜 실제 라우팅까지 검증한다. 파싱된 JSON을 반환. */
    call(body) {
      const out = vm.runInContext(
        'doPost(' + JSON.stringify({ postData: { contents: JSON.stringify(body) } }) + ')',
        sandbox
      );
      return JSON.parse(out._text);
    },
    get(name) { return vm.runInContext(name, sandbox); },
    run(expr) { return vm.runInContext(expr, sandbox); },
    sheet(name) { return state.sheets.get(name); },
  };
}

module.exports = { load, FakeSheet };
```

- [ ] **Step 3: 테스트 러너 작성**

`tests/run.js`:

```javascript
const { load } = require('./harness');

const cases = [];
let failed = 0;

function test(name, fn) { cases.push([name, fn]); }

function assertEq(actual, expected, label) {
  if (String(actual) !== String(expected)) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assertThrows(fn, contains, label) {
  try { fn(); } catch (e) {
    if (String(e.message).indexOf(contains) === -1) {
      throw new Error(`${label}: 다른 오류 — ${e.message}`);
    }
    return;
  }
  throw new Error(`${label}: 오류가 발생하지 않음`);
}

/** 응답이 실패이고 지정한 코드인지 확인 */
function assertError(res, code, label) {
  if (res.success !== false) throw new Error(`${label}: 성공 응답이 왔음`);
  assertEq(res.error.code, code, label);
}

function runAll() {
  for (const [name, fn] of cases) {
    try { fn(); console.log('  PASS  ' + name); }
    catch (e) { failed++; console.log('  FAIL  ' + name + '\n        ' + e.message); }
  }
  console.log(failed === 0 ? '\nALL TESTS PASSED' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

module.exports = { load, test, assertEq, assertThrows, assertError, runAll };

// 스모크 테스트: 하네스가 Code.gs를 로드할 수 있는가
test('harness가 Code.gs를 로드한다', () => {
  const app = load(['Code.gs']);
  assertEq(typeof app.get('doPost'), 'function', 'doPost 존재');
});

if (require.main === module) runAll();
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

```bash
cd "C:/Users/김규호/vehicle-log-app"
node tests/run.js
```

Expected: `PASS  harness가 Code.gs를 로드한다` 그리고 `ALL TESTS PASSED`

만약 `CONFIG is not defined` 오류가 나면 `Code.gs`의 `const CONFIG`가 `vm` 컨텍스트에서 재할당 불가여서다. 이 경우 harness의 주입 줄을 지우고, 대신 Task 2에서 `CONFIG.SPREADSHEET_ID` 검사를 `getSheet_()` 안에서만 하도록 유지한다(이미 그렇다). 테스트는 시트를 미리 만들어 두고 진행한다.

- [ ] **Step 5: `.gitignore`에 Node 산출물 추가**

`.gitignore` 파일 맨 끝에 다음 3줄을 덧붙인다(기존 내용은 그대로 둔다):

```
# 테스트 하네스 산출물
tests/tmp/
coverage/
```

- [ ] **Step 6: 커밋**

```bash
git add tests/harness.js tests/run.js .gitignore
git commit -m "test: add Apps Script harness and assert-based runner

실제 스프레드시트 없이 Code.gs를 실행해 검증한다. Utilities의 해시/HMAC은
Node crypto로 실제 동작을 재현하므로 서명 검증 로직이 배포 환경과 같게 동작한다."
```

---

## Task 2: 스키마 20열 확장과 부속 시트

**Files:**
- Modify: `apps-script/Code.gs` (`COLUMNS`, `setupSheet`, `getLogs_`, `createLogId_`)
- Modify: `tests/run.js` (테스트 추가)

**Interfaces:**
- Consumes: Task 1의 `load`, `test`, `assertEq`, `assertError`, `runAll`
- Produces:
  - `COLUMNS` — 20개 `{key, header, type}` 배열
  - `setupSheet()` — `운행일지`/`사용자`/`차량`/`감사로그` 시트와 헤더 생성
  - `getLogs_(includeDeleted)` → 레코드 배열. `includeDeleted`가 거짓이면 `status==='DELETED'` 제외
  - `listVehicles_()` → `[{vehicleNo, vehicleName}]` (사용여부 TRUE만)
  - `listUsers_()` → `[{name}]` (사용여부 TRUE만)
  - `isVehicleAllowed_(vehicleNo)` → boolean
  - `createLogId_()` → `Utilities.getUuid()`

- [ ] **Step 1: 실패하는 테스트를 먼저 쓴다**

`tests/run.js`의 스모크 테스트 아래에 붙인다. 파일 맨 끝의 `if (require.main === module) runAll();` 은 항상 마지막에 남긴다.

```javascript
function seeded() {
  const app = load(['Code.gs']);
  app.run('setupSheet()');
  return app;
}

test('setupSheet이 시트 4개를 만든다', () => {
  const app = seeded();
  for (const n of ['운행일지', '사용자', '차량', '감사로그']) {
    if (!app.sheet(n)) throw new Error(n + ' 시트 없음');
  }
});

test('운행일지 헤더가 20열이고 기존 13열 위치가 보존된다', () => {
  const app = seeded();
  const h = app.sheet('운행일지').data[0];
  assertEq(h.length, 20, '열 개수');
  assertEq(h[0], '기록ID', 'A열');
  assertEq(h[5], '도착계기판(km)', 'F열 — 기존 계기판 자리');
  assertEq(h[12], '작성시각', 'M열');
  assertEq(h[13], '출발계기판(km)', 'N열 — 신규는 뒤에 추가');
  assertEq(h[17], '상태', 'R열');
});

test('status 공란인 legacy 행은 ACTIVE로 취급된다', () => {
  const app = seeded();
  const sh = app.sheet('운행일지');
  const row = new Array(20).fill('');
  row[0] = 'legacy-1'; row[1] = '2026-08-01'; row[5] = 12000; row[6] = 30;
  row[11] = '0704';
  sh.appendRow(row);                       // status 열(R)이 공란
  const logs = app.run('getLogs_(false)');
  assertEq(logs.length, 1, 'legacy 행이 조회된다');
  assertEq(logs[0].status, 'ACTIVE', '공란 → ACTIVE');
});

test('DELETED 행은 기본 조회에서 빠지고 includeDeleted면 나온다', () => {
  const app = seeded();
  const sh = app.sheet('운행일지');
  const row = new Array(20).fill('');
  row[0] = 'del-1'; row[1] = '2026-08-02'; row[17] = 'DELETED';
  sh.appendRow(row);
  assertEq(app.run('getLogs_(false)').length, 0, '기본 조회에서 제외');
  assertEq(app.run('getLogs_(true)').length, 1, 'includeDeleted면 포함');
});

test('차량 목록이 시트에서 오고 사용여부 FALSE는 빠진다', () => {
  const app = seeded();
  const veh = app.sheet('차량');
  veh.appendRow(['9999', '폐차 예정', false]);
  const list = app.run('listVehicles_()');
  const nums = list.map((v) => v.vehicleNo);
  assertEq(nums.indexOf('0704') >= 0, true, '0704 포함');
  assertEq(nums.indexOf('9999'), -1, '비활성 차량 제외');
  assertEq(app.run("isVehicleAllowed_('0704')"), true, '허용 차량');
  assertEq(app.run("isVehicleAllowed_('9999')"), false, '비활성 차량 거부');
  assertEq(app.run("isVehicleAllowed_('0000')"), false, '없는 차량 거부');
});

test('기록 ID가 UUID다', () => {
  const app = seeded();
  const id = app.run('createLogId_()');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(id)) throw new Error('UUID 아님: ' + id);
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

```bash
node tests/run.js
```

Expected: `FAIL  setupSheet이 시트 4개를 만든다` 등. `사용자 시트 없음` 또는 `listVehicles_ is not defined` 계열 메시지.

- [ ] **Step 3: `Code.gs`의 `COLUMNS` 교체**

`apps-script/Code.gs`의 기존 `ALLOWED_VEHICLES` 상수(30행)를 **삭제**하고, `COLUMNS`(32~46행)를 아래로 교체한다.

```javascript
// 시트 이름
const REC_SHEET = '운행일지';
const USER_SHEET = '사용자';
const VEH_SHEET = '차량';
const AUDIT_SHEET = '감사로그';

/**
 * 열 정의. getHeaderIndex_가 위치가 아니라 헤더 '이름'으로 매핑하므로
 * 배열 순서와 시트의 물리적 열 순서는 무관하다. 아래 순서는 기존 시트의
 * A~M열을 그대로 두고 N~T열을 뒤에 붙이기 위한 것이다.
 */
const COLUMNS = [
  { key: 'id',             header: '기록ID',          type: 'text'   }, // A
  { key: 'date',           header: '운행일',          type: 'text'   }, // B
  { key: 'departTime',     header: '출발시간',        type: 'text'   }, // C
  { key: 'arriveTime',     header: '도착시간',        type: 'text'   }, // D
  { key: 'driver',         header: '운전자',          type: 'text'   }, // E
  { key: 'endOdometer',    header: '도착계기판(km)',  type: 'number' }, // F ← 기존 '계기판(km)'
  { key: 'distance',       header: '운행거리(km)',    type: 'number' }, // G
  { key: 'destination',    header: '목적지',          type: 'text'   }, // H
  { key: 'purpose',        header: '운행사유',        type: 'text'   }, // I
  { key: 'passengerCount', header: '인원',            type: 'number' }, // J
  { key: 'fuelCost',       header: '단가/주유금액',   type: 'number' }, // K
  { key: 'vehicleNo',      header: '차량선택',        type: 'text'   }, // L
  { key: 'createdAt',      header: '작성시각',        type: 'text'   }, // M
  { key: 'startOdometer',  header: '출발계기판(km)',  type: 'number' }, // N ← 신규
  { key: 'updatedAt',      header: '수정시각',        type: 'text'   }, // O
  { key: 'createdBy',      header: '작성자',          type: 'text'   }, // P
  { key: 'updatedBy',      header: '수정자',          type: 'text'   }, // Q
  { key: 'status',         header: '상태',            type: 'text'   }, // R
  { key: 'deletedAt',      header: '삭제시각',        type: 'text'   }, // S
  { key: 'deletedBy',      header: '삭제자',          type: 'text'   }, // T
];

const STATUS_ACTIVE = 'ACTIVE';
const STATUS_DELETED = 'DELETED';
```

- [ ] **Step 4: `setupSheet` 교체**

기존 `setupSheet`(374~389행)를 아래로 교체한다. 부속 시트 3개를 함께 만들고, F열 헤더만 갈아끼운다.

```javascript
function sheetNamed_(ss, name, headers, seedRows) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length)
    .setValues([headers]).setFontWeight('bold').setBackground('#f1f5f9');
  sh.setFrozenRows(1);
  if (seedRows && sh.getLastRow() < 2) {
    seedRows.forEach(function (r) { sh.appendRow(r); });
  }
  return sh;
}

/**
 * 시트 4개를 준비한다. 여러 번 실행해도 안전하다.
 * 운행일지는 기존 A~M열 셀 값을 건드리지 않고 헤더 문자열만 덮어쓴다.
 * F열이 '계기판(km)' → '도착계기판(km)'으로 바뀌는데, 지금까지 적어온 값은
 * 운행을 마치고 본 숫자이므로 의미상 맞다.
 */
function setupSheet() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);

  sheetNamed_(ss, REC_SHEET, COLUMNS.map(function (c) { return c.header; }));
  sheetNamed_(ss, USER_SHEET, ['이름', '권한', '사용여부'], [['관리자', 'ADMIN', true]]);
  sheetNamed_(ss, VEH_SHEET, ['차량번호', '차량명', '사용여부'], [
    ['0704', '', true], ['8318', '', true], ['1213', '', true], ['5486', '', true],
  ]);
  sheetNamed_(ss, AUDIT_SHEET, ['시각', '동작', '기록ID', '사용자', '권한', '상세']);

  SpreadsheetApp.flush();
  console.log('시트 4개 준비 완료.');
}
```

- [ ] **Step 5: `getLogs_`, `createLogId_`, 부속 조회 함수 교체**

기존 `getLogs_`(215~238행)와 `createLogId_`(345~348행)를 아래로 교체하고, 부속 조회 함수 3개를 그 아래에 추가한다.

```javascript
/** includeDeleted가 거짓이면 status가 DELETED인 행을 제외한다. */
function getLogs_(includeDeleted) {
  const sheet = getSheet_(REC_SHEET);
  const index = getHeaderIndex_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const logs = [];

  values.forEach(function (row) {
    const blank = row.every(function (cell) { return cell === '' || cell === null; });
    if (blank) return;

    const log = {};
    COLUMNS.forEach(function (col) {
      log[col.key] = normalizeCell_(row[index[col.key]], col.type);
    });
    if (!log.id) return;

    // 공란은 ACTIVE로 본다. 이 기본값이 없으면 소프트 삭제 도입 시
    // 기존 행이 전부 목록에서 사라진다.
    log.status = (log.status === STATUS_DELETED) ? STATUS_DELETED : STATUS_ACTIVE;
    if (!includeDeleted && log.status === STATUS_DELETED) return;

    logs.push(log);
  });

  return logs;
}

function createLogId_() {
  return Utilities.getUuid();
}

/** 이름/사용여부 2~3열 구조의 부속 시트를 읽는다. 사용여부가 FALSE면 제외. */
function activeRows_(sheetName, width) {
  const sh = getSheet_(sheetName);
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, width).getValues()
    .filter(function (r) { return String(r[0]).trim() !== '' && r[width - 1] !== false; });
}

function listVehicles_() {
  return activeRows_(VEH_SHEET, 3).map(function (r) {
    return { vehicleNo: String(r[0]).trim(), vehicleName: String(r[1]) };
  });
}

function listUsers_() {
  return activeRows_(USER_SHEET, 3).map(function (r) {
    return { name: String(r[0]).trim() };
  });
}

function isVehicleAllowed_(vehicleNo) {
  const target = String(vehicleNo).trim();
  return listVehicles_().some(function (v) { return v.vehicleNo === target; });
}

function isUserAllowed_(name) {
  const target = String(name).trim();
  return listUsers_().some(function (u) { return u.name === target; });
}
```

- [ ] **Step 6: `getSheet_`가 시트 이름을 인자로 받도록 수정**

기존 `getSheet_()`(176~192행)는 `CONFIG.SHEET_NAME` 고정이다. 부속 시트를 읽어야 하므로 인자를 받게 바꾼다.

```javascript
function getSheet_(name) {
  if (!CONFIG.SPREADSHEET_ID || CONFIG.SPREADSHEET_ID === 'YOUR_SPREADSHEET_ID') {
    throw makeError_('CONFIG_ERROR', '스프레드시트 ID가 설정되지 않았습니다.');
  }
  let ss;
  try {
    ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  } catch (err) {
    console.error('openById failed: ' + err);
    throw makeError_('CONFIG_ERROR', '스프레드시트를 열 수 없습니다. 설정을 확인하세요.');
  }
  const sheet = ss.getSheetByName(name);
  if (!sheet) {
    throw makeError_('CONFIG_ERROR', "'" + name + "' 시트를 찾을 수 없습니다. setupSheet()을 실행하세요.");
  }
  return sheet;
}
```

그리고 기존 호출부 3곳을 `getSheet_(REC_SHEET)`로 바꾼다: `handleCreate_` 안(111행), `handleDelete_` 안(148행), `getLogs_` 안(Step 5에서 이미 반영됨).

`CONFIG.SHEET_NAME` 항목은 더 이상 쓰이지 않으므로 `CONFIG`에서 삭제한다.

- [ ] **Step 7: 테스트 실행 — 통과 확인**

```bash
node tests/run.js
```

Expected: 스모크 1개 + 신규 6개 전부 PASS, `ALL TESTS PASSED`

- [ ] **Step 8: 커밋**

```bash
git add apps-script/Code.gs tests/run.js
git commit -m "feat(schema): expand to 20 columns with soft-delete and audit fields

기존 A~M열을 옮기지 않고 N~T열을 뒤에 추가한다. getHeaderIndex_가 헤더
이름으로 매핑하므로 열 순서는 코드에 영향이 없고, 기존 셀 값이 물리적으로
이동하지 않아 마이그레이션 중 데이터가 어긋날 여지가 없다.

status 공란은 ACTIVE로 취급해 legacy 행이 목록에서 사라지지 않게 한다.
차량 화이트리스트를 하드코딩에서 시트로 옮기고 ID를 UUID로 교체한다."
```

---

## Task 3: 토큰 발급·검증 코어

**Files:**
- Create: `apps-script/Auth.gs`
- Modify: `tests/run.js`

**Interfaces:**
- Consumes: Task 2의 `isUserAllowed_(name)`, `makeError_(code, userMessage)`
- Produces:
  - `setPasscodes(staffPw, adminPw)` — 편집기에서 수동 실행. Script Properties에 해시·솔트·서명키 저장
  - `hashPasscode_(plain, salt)` → base64 문자열
  - `issueToken_(name, role)` → `"payloadB64.sigB64"`
  - `verifyToken_(token)` → `{name, role}`. 실패 시 `makeError_('UNAUTHORIZED', ...)` throw
  - `safeEquals_(a, b)` → boolean (상수시간)
  - `ROLE_USER = 'USER'`, `ROLE_ADMIN = 'ADMIN'`

- [ ] **Step 1: 실패하는 테스트를 먼저 쓴다**

`tests/run.js`에 추가한다.

```javascript
function authed() {
  const app = load(['Code.gs', 'Auth.gs']);
  app.run('setupSheet()');
  app.run("setPasscodes('staff-pw-1234', 'admin-pw-5678')");
  return app;
}

test('setPasscodes가 평문을 저장하지 않는다', () => {
  const app = authed();
  const dump = JSON.stringify(app.state.props);
  if (dump.indexOf('staff-pw-1234') >= 0) throw new Error('직원 암호 평문 노출');
  if (dump.indexOf('admin-pw-5678') >= 0) throw new Error('관리자 암호 평문 노출');
  for (const k of ['PASSCODE_SALT', 'STAFF_PASSCODE_HASH', 'ADMIN_PASSCODE_HASH',
                   'TOKEN_SECRET', 'TOKEN_VERSION']) {
    if (!app.state.props[k]) throw new Error(k + ' 미설정');
  }
});

test('정상 토큰이 검증을 통과하고 한글 이름이 보존된다', () => {
  const app = authed();
  const t = app.run("issueToken_('홍길동', 'USER')");
  const s = app.run("verifyToken_(" + JSON.stringify(t) + ")");
  assertEq(s.name, '홍길동', '한글 이름 왕복');
  assertEq(s.role, 'USER', '권한');
});

test('서명이 조작된 토큰은 거부된다', () => {
  const app = authed();
  const t = app.run("issueToken_('홍길동', 'USER')");
  const bad = t.slice(0, -4) + 'AAAA';
  assertThrows(() => app.run("verifyToken_(" + JSON.stringify(bad) + ")"),
    '인증', '서명 조작');
});

test('페이로드를 갈아끼워 권한을 올릴 수 없다', () => {
  const app = authed();
  const t = app.run("issueToken_('홍길동', 'USER')");
  const sig = t.split('.')[1];
  const forgedPayload = Buffer.from(JSON.stringify({ n: '홍길동', r: 'ADMIN', e: 9e9, v: 1 }))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  assertThrows(() => app.run("verifyToken_(" + JSON.stringify(forgedPayload + '.' + sig) + ")"),
    '인증', '권한 상승 위조');
});

test('만료된 토큰은 거부된다', () => {
  const app = authed();
  const expired = app.run("issueTokenForTest_('홍길동', 'USER', 1000)");
  assertThrows(() => app.run("verifyToken_(" + JSON.stringify(expired) + ")"),
    '만료', '만료 토큰');
});

test('TOKEN_VERSION을 올리면 기존 토큰이 전부 무효화된다', () => {
  const app = authed();
  const t = app.run("issueToken_('홍길동', 'USER')");
  app.run("PropertiesService.getScriptProperties().setProperty('TOKEN_VERSION', '2')");
  assertThrows(() => app.run("verifyToken_(" + JSON.stringify(t) + ")"),
    '다시 로그인', '버전 무효화');
});

test('형식이 깨진 토큰은 거부된다', () => {
  const app = authed();
  for (const bad of ['', 'abc', 'a.b.c', '.', 'null']) {
    assertThrows(() => app.run("verifyToken_(" + JSON.stringify(bad) + ")"),
      '인증', '형식 오류: ' + JSON.stringify(bad));
  }
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

```bash
node tests/run.js
```

Expected: `Cannot find module` 이 아니라, `ENOENT ... Auth.gs` 로 하네스가 파일을 못 찾는다.

- [ ] **Step 3: `Auth.gs` 작성**

```javascript
/**
 * 인증. 이 파일이 보안 표면 전체다.
 *
 * 암호는 Script Properties에만 존재한다. 저장소·프론트엔드·시트 어디에도 없다.
 * 세션은 서버에 저장하지 않는다 — HMAC 서명된 자기검증 토큰을 쓴다.
 * CacheService를 쓰지 않는 이유: 최대 TTL이 6시간이고 예고 없이 축출되어
 * 사용자가 갑자기 튕긴다.
 */

const ROLE_USER = 'USER';
const ROLE_ADMIN = 'ADMIN';

const SESSION_TTL_SEC = 43200;   // 12시간
const HASH_ITERATIONS = 10000;

const PROP_SALT    = 'PASSCODE_SALT';
const PROP_STAFF   = 'STAFF_PASSCODE_HASH';
const PROP_ADMIN   = 'ADMIN_PASSCODE_HASH';
const PROP_SECRET  = 'TOKEN_SECRET';
const PROP_VERSION = 'TOKEN_VERSION';

function props_() { return PropertiesService.getScriptProperties(); }

function randomB64_(byteLength) {
  // Apps Script에는 CSPRNG API가 없다. UUID(v4)를 이어붙여 엔트로피를 만든다.
  let s = '';
  while (s.length < byteLength * 2) s += Utilities.getUuid().replace(/-/g, '');
  return Utilities.base64EncodeWebSafe(s.slice(0, byteLength * 2));
}

/**
 * 관리자가 Apps Script 편집기에서 한 번 실행한다.
 *   setPasscodes('직원암호', '관리자암호')
 * 실행 후 이 호출부의 평문을 편집기에서 지운다.
 */
function setPasscodes(staffPw, adminPw) {
  if (!staffPw || String(staffPw).length < 8) {
    throw new Error('직원 암호는 8자 이상이어야 합니다.');
  }
  if (!adminPw || String(adminPw).length < 8) {
    throw new Error('관리자 암호는 8자 이상이어야 합니다.');
  }
  if (String(staffPw) === String(adminPw)) {
    throw new Error('직원 암호와 관리자 암호가 같으면 권한 구분이 무의미합니다.');
  }

  const p = props_();
  const salt = p.getProperty(PROP_SALT) || randomB64_(16);

  p.setProperties({
    [PROP_SALT]: salt,
    [PROP_STAFF]: hashPasscode_(String(staffPw), salt),
    [PROP_ADMIN]: hashPasscode_(String(adminPw), salt),
    [PROP_SECRET]: p.getProperty(PROP_SECRET) || randomB64_(32),
    [PROP_VERSION]: p.getProperty(PROP_VERSION) || '1',
  });

  // 평문을 로그에 남기지 않는다.
  console.log('암호 설정 완료. 편집기에서 이 호출부의 평문을 지우세요.');
}

/** 전 세션 즉시 무효화. 암호 유출이 의심될 때 편집기에서 실행한다. */
function revokeAllSessions() {
  const p = props_();
  const next = String(Number(p.getProperty(PROP_VERSION) || '1') + 1);
  p.setProperty(PROP_VERSION, next);
  console.log('전 세션 무효화. TOKEN_VERSION = ' + next);
}

function hashPasscode_(plain, salt) {
  let bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + plain);
  for (let i = 1; i < HASH_ITERATIONS; i++) {
    bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes);
  }
  return Utilities.base64Encode(bytes);
}

/** 길이가 같을 때 조기 반환하지 않는다. */
function safeEquals_(a, b) {
  const s1 = String(a), s2 = String(b);
  if (s1.length !== s2.length) return false;
  let diff = 0;
  for (let i = 0; i < s1.length; i++) diff |= s1.charCodeAt(i) ^ s2.charCodeAt(i);
  return diff === 0;
}

function signPayload_(payloadB64) {
  const secret = props_().getProperty(PROP_SECRET);
  if (!secret) throw makeError_('CONFIG_ERROR', '서버 설정이 완료되지 않았습니다. 관리자에게 문의하세요.');
  return Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(payloadB64, secret)
  );
}

function issueTokenForTest_(name, role, expEpochSec) {
  const payload = {
    n: name || '',
    r: role,
    e: expEpochSec,
    v: Number(props_().getProperty(PROP_VERSION) || '1'),
  };
  const b64 = Utilities.base64EncodeWebSafe(JSON.stringify(payload));
  return b64 + '.' + signPayload_(b64);
}

function issueToken_(name, role) {
  return issueTokenForTest_(name, role, Math.floor(Date.now() / 1000) + SESSION_TTL_SEC);
}

/** 성공 시 {name, role}. 실패 시 UNAUTHORIZED throw. */
function verifyToken_(token) {
  const raw = (token === null || token === undefined) ? '' : String(token);
  const dot = raw.indexOf('.');
  if (dot <= 0 || raw.indexOf('.', dot + 1) !== -1) {
    throw makeError_('UNAUTHORIZED', '인증이 필요합니다. 다시 로그인해 주세요.');
  }

  const payloadB64 = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!safeEquals_(sig, signPayload_(payloadB64))) {
    throw makeError_('UNAUTHORIZED', '인증 정보가 올바르지 않습니다. 다시 로그인해 주세요.');
  }

  let payload;
  try {
    // base64 → 바이트 → UTF-8. 한글 이름이 깨지지 않으려면 newBlob을 거쳐야 한다.
    const bytes = Utilities.base64DecodeWebSafe(payloadB64);
    payload = JSON.parse(Utilities.newBlob(bytes).getDataAsString());
  } catch (err) {
    throw makeError_('UNAUTHORIZED', '인증이 필요합니다. 다시 로그인해 주세요.');
  }
  if (!payload || typeof payload !== 'object') {
    throw makeError_('UNAUTHORIZED', '인증이 필요합니다. 다시 로그인해 주세요.');
  }

  if (Number(payload.v) !== Number(props_().getProperty(PROP_VERSION) || '1')) {
    throw makeError_('UNAUTHORIZED', '세션이 만료되었습니다. 다시 로그인해 주세요.');
  }
  if (!isFinite(Number(payload.e)) || Number(payload.e) < Math.floor(Date.now() / 1000)) {
    throw makeError_('UNAUTHORIZED', '세션이 만료되었습니다. 다시 로그인해 주세요.');
  }
  if (payload.r !== ROLE_USER && payload.r !== ROLE_ADMIN) {
    throw makeError_('UNAUTHORIZED', '인증이 필요합니다. 다시 로그인해 주세요.');
  }

  return { name: String(payload.n || ''), role: payload.r };
}
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

```bash
node tests/run.js
```

Expected: 신규 7개 포함 전부 PASS, `ALL TESTS PASSED`

- [ ] **Step 5: 실제 Apps Script에서 해시 소요 시간 측정**

`HASH_ITERATIONS = 10000`이 Apps Script에서 느릴 수 있다. 편집기에 아래 함수를 임시로 붙여 실행하고 실행 로그를 본다.

```javascript
function measureHashCost() {
  const t0 = Date.now();
  hashPasscode_('measurement-only', 'salt');
  console.log('해시 1회: ' + (Date.now() - t0) + 'ms');
}
```

**2000ms를 넘으면** `HASH_ITERATIONS`를 2000으로 낮춘다. 로그인은 12시간에 한 번이라 지연이 크게 문제되진 않지만 사용자가 멈춘 줄 안다.

반복 횟수가 보안에 결정적이지 않은 이유: Script Properties가 유출되면 공격자는 `TOKEN_SECRET`도 함께 얻어 토큰을 직접 위조할 수 있다. 해시는 편집기 접근자가 암호를 눈으로 읽는 것을 막는 용도다.

측정 후 `measureHashCost`는 삭제한다.

- [ ] **Step 6: 커밋**

```bash
git add apps-script/Auth.gs tests/run.js
git commit -m "feat(auth): HMAC-signed stateless session tokens

암호는 Script Properties에만 저장하고 salt + SHA-256 반복 해시로 보관한다.
세션은 서버에 저장하지 않고 HMAC 서명 토큰으로 자기검증한다. CacheService는
최대 TTL 6시간에 예고 없는 축출이 있어 쓰지 않았다.

TOKEN_VERSION을 올리면 전 세션이 즉시 무효화된다."
```

---

## Task 4: `login` / `bind` 와 속도 제한, `doGet` 차단

**Files:**
- Modify: `apps-script/Auth.gs` (로그인 핸들러 추가)
- Modify: `apps-script/Code.gs` (`doGet`, `doPost` 라우팅)
- Modify: `tests/run.js`

**Interfaces:**
- Consumes: Task 2의 `listUsers_()`, `listVehicles_()`, `isUserAllowed_(name)`; Task 3의 `issueToken_`, `verifyToken_`, `hashPasscode_`, `safeEquals_`, `ROLE_USER`, `ROLE_ADMIN`
- Produces:
  - `handleLogin_(payload)` → `{success, data:{token, role, users, vehicles}}`
  - `handleBind_(payload)` → `{success, data:{token, name, role}}`
  - `requireSession_(payload)` → `{name, role}`. 이름 없는 토큰이면 UNAUTHORIZED
  - `requireAdmin_(payload)` → `{name, role}`. USER면 FORBIDDEN

- [ ] **Step 1: 실패하는 테스트를 먼저 쓴다**

```javascript
test('doGet은 데이터를 반환하지 않는다', () => {
  const app = authed();
  const out = app.run('doGet({})');
  const res = JSON.parse(out._text);
  assertError(res, 'UNAUTHORIZED', 'doGet 차단');
  if (JSON.stringify(res).indexOf('data') >= 0 && res.data) {
    throw new Error('doGet이 data를 반환함');
  }
});

test('올바른 직원 암호로 로그인하면 USER 토큰과 목록을 받는다', () => {
  const app = authed();
  const res = app.call({ action: 'login', passcode: 'staff-pw-1234' });
  assertEq(res.success, true, '로그인 성공');
  assertEq(res.data.role, 'USER', '직원 권한');
  assertEq(res.data.users.length >= 1, true, '사용자 목록 포함');
  assertEq(res.data.vehicles.length, 4, '차량 4대');
});

test('관리자 암호로 로그인하면 ADMIN 토큰을 받는다', () => {
  const app = authed();
  const res = app.call({ action: 'login', passcode: 'admin-pw-5678' });
  assertEq(res.data.role, 'ADMIN', '관리자 권한');
});

test('틀린 암호는 거부되고 지연이 걸린다', () => {
  const app = authed();
  const before = app.state.slept;
  assertError(app.call({ action: 'login', passcode: 'wrong' }), 'UNAUTHORIZED', '틀린 암호');
  if (app.state.slept <= before) throw new Error('지연이 걸리지 않음');
});

test('로그인 응답에 이름 목록은 있어도 암호 관련 값은 없다', () => {
  const app = authed();
  const res = app.call({ action: 'login', passcode: 'staff-pw-1234' });
  const dump = JSON.stringify(res);
  for (const leak of ['staff-pw-1234', 'PASSCODE', 'SECRET', 'HASH']) {
    if (dump.indexOf(leak) >= 0) throw new Error('응답에 ' + leak + ' 노출');
  }
});

test('10분 내 10회 실패하면 RATE_LIMITED', () => {
  const app = authed();
  for (let i = 0; i < 10; i++) app.call({ action: 'login', passcode: 'wrong' });
  assertError(app.call({ action: 'login', passcode: 'wrong' }), 'RATE_LIMITED', '11회차');
  // 옳은 암호도 잠금 동안은 막힌다
  assertError(app.call({ action: 'login', passcode: 'staff-pw-1234' }), 'RATE_LIMITED', '잠금 중');
});

test('bind는 사용자 시트에 있는 이름만 받는다', () => {
  const app = authed();
  app.sheet('사용자').appendRow(['홍길동', 'USER', true]);
  const login = app.call({ action: 'login', passcode: 'staff-pw-1234' });

  const ok = app.call({ action: 'bind', token: login.data.token, name: '홍길동' });
  assertEq(ok.data.name, '홍길동', '정상 bind');

  assertError(app.call({ action: 'bind', token: login.data.token, name: '없는사람' }),
    'VALIDATION_ERROR', '미등록 이름');
});

test('이름 없는 토큰으로는 bind 외 아무것도 못 한다', () => {
  const app = authed();
  const login = app.call({ action: 'login', passcode: 'staff-pw-1234' });
  assertError(app.call({ action: 'list', token: login.data.token }),
    'UNAUTHORIZED', 'bind 전 list');
});

test('토큰 없이 모든 action이 거부된다', () => {
  const app = authed();
  for (const a of ['list', 'create', 'update', 'delete', 'restore', 'audit']) {
    assertError(app.call({ action: a }), 'UNAUTHORIZED', '토큰 없는 ' + a);
  }
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

```bash
node tests/run.js
```

Expected: `doGet 차단: 성공 응답이 왔음` — 현재 `doGet`이 전 기록을 반환하므로.

- [ ] **Step 3: `Auth.gs`에 로그인 핸들러 추가**

`Auth.gs` 맨 끝에 붙인다.

```javascript
// ---------------------------------------------------------------------------
// 로그인
// ---------------------------------------------------------------------------

const LOGIN_FAIL_LIMIT = 10;
const LOGIN_LOCK_SEC = 600;
const LOGIN_FAIL_DELAY_MS = 500;
const FAIL_CACHE_KEY = 'login_fail_count';

function loginFailCount_() {
  return Number(CacheService.getScriptCache().get(FAIL_CACHE_KEY) || '0');
}

function bumpLoginFail_() {
  const cache = CacheService.getScriptCache();
  cache.put(FAIL_CACHE_KEY, String(loginFailCount_() + 1), LOGIN_LOCK_SEC);
}

/**
 * { passcode } → 이름 없는 토큰 + 이름/차량 목록.
 * 이름 목록을 미인증 상태로 내주면 직원 명단이 유출되므로 로그인 이후에 준다.
 */
function handleLogin_(payload) {
  if (loginFailCount_() >= LOGIN_FAIL_LIMIT) {
    return errorResponse_('RATE_LIMITED',
      '로그인 시도가 너무 많습니다. 10분 후 다시 시도해 주세요.', 429);
  }

  const plain = payload.passcode ? String(payload.passcode) : '';
  const p = props_();
  const salt = p.getProperty(PROP_SALT);
  if (!salt) {
    return errorResponse_('CONFIG_ERROR',
      '서버 설정이 완료되지 않았습니다. 관리자에게 문의하세요.', 500);
  }

  const attempted = hashPasscode_(plain, salt);
  let role = null;
  if (safeEquals_(attempted, p.getProperty(PROP_ADMIN))) role = ROLE_ADMIN;
  else if (safeEquals_(attempted, p.getProperty(PROP_STAFF))) role = ROLE_USER;

  if (!role) {
    bumpLoginFail_();
    Utilities.sleep(LOGIN_FAIL_DELAY_MS);   // 초당 2회 상한
    writeAudit_('LOGIN_FAIL', '', { name: '', role: '' }, '암호 불일치');
    return errorResponse_('UNAUTHORIZED', '암호가 올바르지 않습니다.', 401);
  }

  CacheService.getScriptCache().remove(FAIL_CACHE_KEY);

  return jsonResponse_({
    success: true,
    data: {
      token: issueToken_('', role),   // 이름은 bind에서 붙인다
      role: role,
      users: listUsers_(),
      vehicles: listVehicles_(),
    },
  });
}

/** { token, name } → 이름이 들어간 토큰 */
function handleBind_(payload) {
  const session = verifyToken_(payload.token);   // 이름 없는 토큰도 여기선 통과
  const name = payload.name ? String(payload.name).trim() : '';
  if (!name) {
    return errorResponse_('VALIDATION_ERROR', '이름을 선택해 주세요.', 400);
  }
  if (!isUserAllowed_(name)) {
    return errorResponse_('VALIDATION_ERROR',
      '등록되지 않은 이름입니다. 관리자에게 문의하세요.', 400);
  }
  return jsonResponse_({
    success: true,
    data: { token: issueToken_(name, session.role), name: name, role: session.role },
  });
}

/**
 * bind를 마친 세션만 통과시킨다.
 * 이름 없는 토큰을 통과시키면 감사 로그의 사용자 칸이 비어버린다.
 */
function requireSession_(payload) {
  const session = verifyToken_(payload.token);
  if (!session.name) {
    throw makeError_('UNAUTHORIZED', '이름 선택이 완료되지 않았습니다. 다시 로그인해 주세요.');
  }
  return session;
}

function requireAdmin_(payload) {
  const session = requireSession_(payload);
  if (session.role !== ROLE_ADMIN) {
    throw makeError_('FORBIDDEN', '관리자만 사용할 수 있는 기능입니다.');
  }
  return session;
}
```

- [ ] **Step 4: `Code.gs`의 `doGet` / `doPost` 교체**

기존 `doGet`(52~64행)과 `doPost`(66~94행)를 아래로 교체한다.

```javascript
/**
 * 조회는 POST { action:'list', token } 으로만 가능하다.
 * 예전에는 여기서 무인증으로 전 기록을 반환했다. 데이터를 반환하지 않는다.
 */
function doGet() {
  return errorResponse_('UNAUTHORIZED',
    '인증이 필요합니다. 앱에서 로그인해 주세요.', 401);
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return errorResponse_('BAD_REQUEST', '요청 본문이 비어 있습니다.', 400);
    }
    if (e.postData.contents.length > CONFIG.MAX_PAYLOAD_BYTES) {
      return errorResponse_('PAYLOAD_TOO_LARGE', '요청 크기가 너무 큽니다.', 413);
    }

    let payload;
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return errorResponse_('BAD_JSON', '요청 형식이 올바르지 않습니다.', 400);
    }

    switch (payload.action) {
      // 인증 불필요
      case 'login':   return handleLogin_(payload);
      case 'bind':    return handleBind_(payload);

      // 인증 필요
      case 'list':    return handleList_(payload);
      case 'create':  return handleCreate_(payload);
      case 'update':  return handleUpdate_(payload);
      case 'delete':  return handleDelete_(payload);

      // 관리자 전용
      case 'restore': return handleRestore_(payload);
      case 'audit':   return handleAudit_(payload);

      default:
        return errorResponse_('UNKNOWN_ACTION', '알 수 없는 요청입니다.', 400);
    }
  } catch (err) {
    console.error('doPost failed: ' + (err && err.stack ? err.stack : err));
    // 스택 트레이스를 사용자에게 노출하지 않는다.
    return errorResponse_(
      err.code || 'SERVER_ERROR',
      err.userMessage || '처리 중 오류가 발생했습니다.',
      err.code === 'UNAUTHORIZED' ? 401 : (err.code === 'FORBIDDEN' ? 403 : 500)
    );
  }
}
```

기존 `doPost`는 `payload.action`이 없으면 `'create'`로 기본 처리했다. **그 기본값을 없앤다** — action을 빼먹은 요청이 조용히 쓰기로 처리되는 것을 막는다.

- [ ] **Step 5: `handleList_` 추가와 `handleCreate_` 인증 적용**

`Code.gs`의 `handleCreate_` 바로 위에 `handleList_`를 추가하고, `handleCreate_` 첫 줄에 세션 확인을 넣는다.

```javascript
function handleList_(payload) {
  const session = requireSession_(payload);
  // includeDeleted는 관리자만. USER가 요청하면 조용히 무시한다(에러 아님).
  const includeDeleted = (session.role === ROLE_ADMIN) && payload.includeDeleted === true;
  const logs = getLogs_(includeDeleted);
  return jsonResponse_({ success: true, data: logs, count: logs.length });
}
```

`handleCreate_`(100행) 맨 첫 줄에 추가:

```javascript
function handleCreate_(payload) {
  const session = requireSession_(payload);
  // ... 기존 본문 유지 ...
```

`handleDelete_`(137행) 맨 첫 줄에도 동일하게 `const session = requireSession_(payload);`를 추가한다. (`handleUpdate_`, `handleRestore_`, `handleAudit_`는 Task 9·10·계획 2에서 만든다. 지금은 존재하지 않아 `doPost`의 `switch`에서 `ReferenceError`가 나므로, **이 태스크에서는 임시 스텁을 넣는다**:)

```javascript
function handleUpdate_(payload)  { requireSession_(payload); return errorResponse_('UNKNOWN_ACTION', '준비 중입니다.', 400); }
function handleRestore_(payload) { requireAdmin_(payload);   return errorResponse_('UNKNOWN_ACTION', '준비 중입니다.', 400); }
function handleAudit_(payload)   { requireAdmin_(payload);   return errorResponse_('UNKNOWN_ACTION', '준비 중입니다.', 400); }
```

- [ ] **Step 6: 감사 로그 임시 스텁 추가**

`handleLogin_`이 `writeAudit_`를 부르는데 아직 없다. `Auth.gs` 맨 위에 임시로 넣고 Task 5에서 진짜 구현으로 교체한다.

```javascript
// Task 5에서 Audit.gs의 실제 구현으로 대체된다.
if (typeof writeAudit_ !== 'function') {
  var writeAudit_ = function () {};
}
```

- [ ] **Step 7: 테스트 실행 — 통과 확인**

```bash
node tests/run.js
```

Expected: 신규 9개 포함 전부 PASS, `ALL TESTS PASSED`

- [ ] **Step 8: 커밋**

```bash
git add apps-script/Auth.gs apps-script/Code.gs tests/run.js
git commit -m "feat(auth): gate every action behind login/bind

doGet이 더 이상 데이터를 반환하지 않는다. 조회는 POST list + 토큰으로만 가능하다.
로그인은 2단계다 — 이름 목록을 미인증 상태로 내주면 직원 명단이 유출되므로
암호 확인 후에 목록을 준다. 이름 없는 토큰은 bind 외 모든 action에서 거부된다.

action 기본값 'create'를 제거했다. action을 빠뜨린 요청이 조용히 쓰기로
처리되면 안 된다."
```

---

## Task 5: 감사 로그 기록

**Files:**
- Create: `apps-script/Audit.gs`
- Modify: `apps-script/Auth.gs` (Task 4 Step 6의 임시 스텁 제거)
- Modify: `apps-script/Code.gs` (`handleCreate_`, `handleDelete_`에서 호출)
- Modify: `tests/run.js`

**Interfaces:**
- Consumes: Task 2의 `getSheet_(name)`, `AUDIT_SHEET`; Task 3의 세션 객체 `{name, role}`
- Produces: `writeAudit_(action, recordId, session, detail)` — 반환값 없음. **호출자의 락 안에서 실행된다**

- [ ] **Step 1: 실패하는 테스트를 먼저 쓴다**

```javascript
function boundSession(app, name) {
  app.sheet('사용자').appendRow([name, 'USER', true]);
  const login = app.call({ action: 'login', passcode: 'staff-pw-1234' });
  return app.call({ action: 'bind', token: login.data.token, name: name }).data.token;
}

function validLog(extra) {
  return Object.assign({
    action: 'create',
    date: '2026-08-10', departTime: '09:00', arriveTime: '11:30',
    driver: '홍길동', startOdometer: 12000, endOdometer: 12045,
    destination: '광양시청', purpose: '회의 참석',
    passengerCount: 2, fuelCost: 50000, vehicleNo: '0704',
  }, extra || {});
}

test('CREATE가 감사 로그에 남는다', () => {
  const app = authed();
  const token = boundSession(app, '홍길동');
  const res = app.call(validLog({ token: token }));
  assertEq(res.success, true, '생성 성공');

  const rows = app.sheet('감사로그').data.slice(1);
  const created = rows.filter((r) => r[1] === 'CREATE');
  assertEq(created.length, 1, 'CREATE 1건');
  assertEq(created[0][2], res.data.id, '기록ID 일치');
  assertEq(created[0][3], '홍길동', '사용자');
  assertEq(created[0][4], 'USER', '권한');
});

test('LOGIN_FAIL이 남되 암호는 기록되지 않는다', () => {
  const app = authed();
  app.call({ action: 'login', passcode: 'super-secret-wrong' });
  const rows = app.sheet('감사로그').data.slice(1);
  const fails = rows.filter((r) => r[1] === 'LOGIN_FAIL');
  assertEq(fails.length, 1, 'LOGIN_FAIL 1건');
  if (JSON.stringify(rows).indexOf('super-secret-wrong') >= 0) {
    throw new Error('감사 로그에 암호 평문이 기록됨');
  }
});

test('감사 로그에 토큰이 기록되지 않는다', () => {
  const app = authed();
  const token = boundSession(app, '홍길동');
  app.call(validLog({ token: token }));
  const dump = JSON.stringify(app.sheet('감사로그').data);
  if (dump.indexOf(token.slice(0, 20)) >= 0) throw new Error('감사 로그에 토큰 조각이 기록됨');
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

```bash
node tests/run.js
```

Expected: `CREATE 1건: expected 1, got 0` — `writeAudit_`가 아직 빈 함수라서.

- [ ] **Step 3: `Audit.gs` 작성**

```javascript
/**
 * 감사 로그.
 *
 * 반드시 호출자의 LockService 구간 안에서 호출한다. 별도 락을 잡으면
 * 기록만 남고 데이터는 안 바뀌는(또는 그 반대) 불일치가 생긴다.
 *
 * 암호·토큰은 절대 기록하지 않는다.
 */

const AUDIT_ACTIONS = ['CREATE', 'UPDATE', 'DELETE', 'RESTORE', 'LOGIN_FAIL'];

function writeAudit_(action, recordId, session, detail) {
  try {
    if (AUDIT_ACTIONS.indexOf(action) === -1) return;
    const sheet = getSheet_(AUDIT_SHEET);
    sheet.appendRow([
      Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX"),
      action,
      recordId ? String(recordId) : '',
      (session && session.name) ? String(session.name) : '',
      (session && session.role) ? String(session.role) : '',
      detail ? String(detail).slice(0, 500) : '',
    ]);
  } catch (err) {
    // 감사 기록 실패가 본 작업을 되돌리게 두지 않는다. 로그만 남긴다.
    console.error('writeAudit_ failed: ' + err);
  }
}

/** 변경 전후 요약. 값이 바뀐 필드만 나열한다. */
function diffSummary_(before, after, keys) {
  const parts = [];
  keys.forEach(function (k) {
    const b = (before && before[k] !== undefined) ? String(before[k]) : '';
    const a = (after && after[k] !== undefined) ? String(after[k]) : '';
    if (b !== a) parts.push(k + ': ' + b + ' → ' + a);
  });
  return parts.join(', ');
}
```

- [ ] **Step 4: `Auth.gs`의 임시 스텁 제거**

Task 4 Step 6에서 넣은 아래 블록을 삭제한다.

```javascript
// 삭제 대상
if (typeof writeAudit_ !== 'function') {
  var writeAudit_ = function () {};
}
```

`tests/run.js`의 `authed()`와 `seeded()`가 로드하는 파일 목록에 `'Audit.gs'`를 추가한다.

```javascript
function authed() {
  const app = load(['Code.gs', 'Auth.gs', 'Audit.gs']);
  app.run('setupSheet()');
  app.run("setPasscodes('staff-pw-1234', 'admin-pw-5678')");
  return app;
}
```

`seeded()`는 `load(['Code.gs', 'Audit.gs'])`로 바꾼다 (`Audit.gs`가 `getSheet_`를 쓰므로 `Code.gs`가 먼저 와야 한다).

- [ ] **Step 5: `handleCreate_`와 `handleDelete_`에서 호출**

`handleCreate_`의 `sheet.appendRow(row);` **바로 다음 줄**(락 안이다):

```javascript
    sheet.appendRow(row);
    writeAudit_('CREATE', record.id, session,
      record.date + ' ' + record.vehicleNo + ' ' + record.distance + 'km');
```

`handleDelete_`의 `sheet.deleteRow(i + 2);` 자리는 Task 10에서 소프트 삭제로 바뀐다. 지금은 그 줄 다음에 추가한다:

```javascript
        sheet.deleteRow(i + 2);
        writeAudit_('DELETE', id, session, '하드 삭제 (Task 10에서 소프트 삭제로 교체 예정)');
```

- [ ] **Step 6: 테스트 실행 — 통과 확인**

```bash
node tests/run.js
```

Expected: 신규 3개 포함 전부 PASS, `ALL TESTS PASSED`

- [ ] **Step 7: 커밋**

```bash
git add apps-script/Audit.gs apps-script/Auth.gs apps-script/Code.gs tests/run.js
git commit -m "feat(audit): record mutations inside the caller's lock

감사 기록을 뮤테이션과 같은 락 구간에서 쓴다. 별도 락을 잡으면 기록만 남고
데이터는 안 바뀌는 불일치가 생긴다.

기록 실패가 본 작업을 되돌리지는 않는다 — 운행 저장이 감사 시트 문제로
실패하면 안 되기 때문이다."
```

---

## Task 6: 프론트엔드 로그인 화면

여기까지 백엔드는 잠겼지만 프론트는 아직 토큰을 모른다. 이 태스크 전까지 앱은 동작하지 않는다.

**Files:**
- Create: `auth.js`
- Modify: `index.html` (로그인 화면 마크업, `auth.js` 로드)
- Modify: `app.js` (`apiRequest`에 토큰 부착, 초기화 흐름)
- Modify: `style.css` (로그인 화면 스타일 **추가만**)

**Interfaces:**
- Consumes: Task 4의 `login` / `bind` action
- Produces: `window.Session` —
  - `Session.token()` → string | ''
  - `Session.name()` → string
  - `Session.role()` → `'USER' | 'ADMIN'` | ''
  - `Session.isAdmin()` → boolean
  - `Session.users()` / `Session.vehicles()` → 로그인 시 받은 목록
  - `Session.clear()` — 토큰 삭제 후 로그인 화면 표시
  - `Session.start(onReady)` — 저장된 토큰이 있으면 즉시 `onReady()`, 없으면 로그인 화면

- [ ] **Step 1: `index.html`에 로그인 화면 추가**

`<body>` 바로 다음, `<div class="app">` 바로 앞에 넣는다.

```html
    <div id="loginScreen" class="login-screen">
      <form id="loginForm" class="login-card" novalidate>
        <h1 class="login-title">차량 사용일지</h1>

        <div id="loginStep1">
          <label for="passcodeInput">암호</label>
          <input type="password" id="passcodeInput" autocomplete="current-password"
                 inputmode="text" required>
        </div>

        <div id="loginStep2" class="hidden">
          <label for="nameSelect">이름</label>
          <select id="nameSelect" required></select>
        </div>

        <div id="loginAlert" class="alert-box hidden" role="status" aria-live="polite"></div>

        <button type="submit" class="btn-primary" id="loginSubmit">확인</button>
      </form>
    </div>
```

`<div class="app">`에 `hidden` 클래스를 추가해 로그인 전에는 감춘다:

```html
    <div class="app hidden" id="appRoot">
```

헤더의 `<h1 class="mark">` 블록 다음에 현재 사용자 표시와 로그아웃 버튼을 넣는다:

```html
            <div class="session-bar">
                <span id="sessionName"></span>
                <button type="button" id="logoutButton" class="ghost-btn">로그아웃</button>
            </div>
```

스크립트 태그를 `config.js` 다음, `app.js` **앞**으로 넣는다:

```html
    <script src="config.js"></script>
    <script src="auth.js"></script>
    <script src="app.js"></script>
```

- [ ] **Step 2: `auth.js` 작성**

```javascript
/**
 * 세션 관리와 로그인 화면.
 * app.js보다 먼저 로드되어 window.Session을 노출한다.
 *
 * 토큰은 로그인 후 서버가 발급한 세션 자격증명이다. 소스에 박힌 비밀이 아니다.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'vehicleLog.session';
  var API_URL = String((window.APP_CONFIG || {}).APPS_SCRIPT_URL || '').trim();
  var REQUEST_TIMEOUT_MS = 15000;

  var state = { token: '', name: '', role: '', users: [], vehicles: [] };
  var onReadyCallback = null;

  function load() {
    try {
      var saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && saved.token) state = saved;
    } catch (e) { /* 손상된 값은 무시하고 로그인부터 다시 */ }
  }

  function save() {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (e) { /* 사파리 프라이빗 모드 등. 이번 세션만 메모리로 동작 */ }
  }

  function wipe() {
    state = { token: '', name: '', role: '', users: [], vehicles: [] };
    try { window.localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  }

  /** 로그인 전용 요청. app.js의 apiRequest는 토큰을 요구하므로 여기선 따로 부른다. */
  function post(body) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);

    return fetch(API_URL, {
      method: 'POST',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
    }).then(function (res) {
      if (!res.ok) throw new Error('서버에 연결하지 못했습니다. (오류 ' + res.status + ')');
      return res.json();
    }).then(function (result) {
      if (!result || result.success !== true) {
        throw new Error((result && result.error && result.error.message) || '서버가 오류를 반환했습니다.');
      }
      return result.data;
    }).catch(function (err) {
      if (err.name === 'AbortError') {
        throw new Error('서버 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.');
      }
      throw err;
    }).finally(function () { clearTimeout(timer); });
  }

  // -------------------------------------------------------------------------
  // 화면
  // -------------------------------------------------------------------------
  var el = {};

  function showLogin() {
    el.loginScreen.classList.remove('hidden');
    el.appRoot.classList.add('hidden');
    el.step2.classList.add('hidden');
    el.step1.classList.remove('hidden');
    el.passcode.value = '';
    el.submit.textContent = '확인';
    el.submit.disabled = false;
    hideAlert();
    el.passcode.focus();
  }

  function showApp() {
    el.loginScreen.classList.add('hidden');
    el.appRoot.classList.remove('hidden');
    el.sessionName.textContent =
      state.name + (state.role === 'ADMIN' ? ' (관리자)' : '');
    if (onReadyCallback) onReadyCallback();
  }

  function showAlert(msg) {
    el.alert.textContent = msg;
    el.alert.className = 'alert-box danger';
  }

  function hideAlert() { el.alert.className = 'alert-box hidden'; }

  function busy(on, label) {
    el.submit.disabled = on;
    el.submit.textContent = on ? label : '확인';
  }

  function submitPasscode() {
    busy(true, '확인 중...');
    post({ action: 'login', passcode: el.passcode.value })
      .then(function (data) {
        state.token = data.token;
        state.role = data.role;
        state.users = data.users || [];
        state.vehicles = data.vehicles || [];
        el.passcode.value = '';

        el.nameSelect.innerHTML = state.users.map(function (u) {
          return '<option value="' + escapeAttr(u.name) + '">' + escapeText(u.name) + '</option>';
        }).join('');

        el.step1.classList.add('hidden');
        el.step2.classList.remove('hidden');
        hideAlert();
        busy(false);
        el.nameSelect.focus();
      })
      .catch(function (err) { busy(false); showAlert(err.message); });
  }

  function submitName() {
    busy(true, '확인 중...');
    post({ action: 'bind', token: state.token, name: el.nameSelect.value })
      .then(function (data) {
        state.token = data.token;
        state.name = data.name;
        state.role = data.role;
        save();
        busy(false);
        showApp();
      })
      .catch(function (err) { busy(false); showAlert(err.message); });
  }

  function escapeText(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeAttr(s) { return escapeText(s).replace(/"/g, '&quot;'); }

  // -------------------------------------------------------------------------
  // 공개 API
  // -------------------------------------------------------------------------
  window.Session = {
    token: function () { return state.token; },
    name: function () { return state.name; },
    role: function () { return state.role; },
    isAdmin: function () { return state.role === 'ADMIN'; },
    users: function () { return state.users.slice(); },
    vehicles: function () { return state.vehicles.slice(); },

    /** 만료·위조 응답을 받으면 app.js가 부른다. */
    clear: function () { wipe(); showLogin(); },

    start: function (onReady) {
      onReadyCallback = onReady;
      el = {
        loginScreen: document.getElementById('loginScreen'),
        appRoot:     document.getElementById('appRoot'),
        form:        document.getElementById('loginForm'),
        step1:       document.getElementById('loginStep1'),
        step2:       document.getElementById('loginStep2'),
        passcode:    document.getElementById('passcodeInput'),
        nameSelect:  document.getElementById('nameSelect'),
        alert:       document.getElementById('loginAlert'),
        submit:      document.getElementById('loginSubmit'),
        sessionName: document.getElementById('sessionName'),
      };

      el.form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        if (el.step2.classList.contains('hidden')) submitPasscode();
        else submitName();
      });

      document.getElementById('logoutButton').addEventListener('click', function () {
        wipe();
        showLogin();
      });

      if (!API_URL) {
        showLogin();
        showAlert('config.js에 Apps Script 주소가 설정되지 않았습니다.');
        el.submit.disabled = true;
        return;
      }

      load();
      if (state.token && state.name) showApp();
      else showLogin();
    },
  };
})();
```

- [ ] **Step 3: `app.js`를 세션에 맞게 수정**

**3-a.** `apiRequest`를 토큰 부착 + 401 처리로 바꾼다. 기존 함수(137~179행)에서 아래 두 곳만 고친다.

`options.body` 설정 부분:

```javascript
            const options = { method: 'POST', cache: 'no-store', signal: controller.signal };
            options.headers = { 'Content-Type': 'text/plain;charset=utf-8' };
            options.body = JSON.stringify(Object.assign({}, body, { token: window.Session.token() }));
```

`result.success !== true` 처리 부분을 아래로 교체한다:

```javascript
        if (!result || result.success !== true) {
            const err = result && result.error;
            const code = err && err.code;
            if (code === 'UNAUTHORIZED') {
                stopPolling();
                window.Session.clear();
                throw new Error('세션이 만료되었습니다. 다시 로그인해 주세요.');
            }
            throw new Error((err && err.message) || '서버가 오류를 반환했습니다.');
        }
```

**3-b.** `apiRequest(method, body)` 시그니처에서 `method`를 제거한다. GET이 더 이상 없다.

- `fetchLogs`: `const result = await apiRequest('GET');` → `const result = await apiRequest({ action: 'list' });`
- `createLog`: `apiRequest('POST', Object.assign({action:'create'}, logData))` → `apiRequest(Object.assign({ action: 'create' }, logData))`
- `deleteLogById`: `apiRequest('POST', {action:'delete', id})` → `apiRequest({ action: 'delete', id })`

**3-c.** 차량 드롭다운을 세션 목록으로 채우고 `ALLOWED_VEHICLES` 하드코딩을 제거한다.
`const ALLOWED_VEHICLES = [...]` (71행)을 **삭제**하고, 대신 아래 함수를 추가한다.

```javascript
    function fillVehicleOptions() {
        const list = window.Session.vehicles();
        vehicleNoSelect.innerHTML = '<option value="">선택</option>' + list.map(v =>
            `<option value="${escapeHTML(v.vehicleNo)}">${escapeHTML(v.vehicleNo)}` +
            `${v.vehicleName ? ' (' + escapeHTML(v.vehicleName) + ')' : ''}</option>`
        ).join('');
    }
```

폼 제출 검증에서 화이트리스트 검사(281~284행)를 아래로 바꾼다. 서버가 시트로 검증하므로 클라이언트는 선택 여부만 본다.

```javascript
        if (!vehicleNo) {
            showAlert('차량을 선택해 주세요.', 'danger');
            return;
        }
```

**3-d.** 초기화 블록(448~455행)을 아래로 교체한다.

```javascript
    window.Session.start(function onSessionReady() {
        fillVehicleOptions();
        refreshLogs({ showLoading: true });
        startPolling();
    });
```

`index.html`의 `<select id="vehicleNo">` 안에 하드코딩된 `<option>` 4개(37~40행)를 지우고 `<option value="">선택</option>` 하나만 남긴다.

- [ ] **Step 4: `style.css`에 로그인 화면 스타일 추가**

**기존 규칙을 수정하지 않는다.** 파일 맨 끝에 덧붙인다. 기존 `--` 변수와 `.alert-box`, `.btn-primary`, `.hidden`을 재사용한다.

```css
/* ── 로그인 ─────────────────────────────────────────────────── */
.login-screen {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
}
.login-card {
  width: 100%;
  max-width: 340px;
  background: var(--card, #fff);
  border: 1px solid var(--line, #dfe3e8);
  border-radius: 12px;
  padding: 28px 24px;
}
.login-title {
  margin: 0 0 20px;
  font-size: 20px;
  text-align: center;
}
.login-card label {
  display: block;
  font-size: 13px;
  margin-bottom: 6px;
}
.login-card input,
.login-card select {
  width: 100%;
  padding: 12px;
  font-size: 16px;          /* iOS 자동 확대 방지 */
  border: 1px solid var(--line, #dfe3e8);
  border-radius: 8px;
  font-family: inherit;
}
.session-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.ghost-btn {
  padding: 5px 10px;
  border: 1px solid var(--line, #dfe3e8);
  border-radius: 6px;
  background: transparent;
  font-size: 13px;
  font-family: inherit;
  color: inherit;
  cursor: pointer;
}
@media (max-width: 480px) {
  .topbar { flex-wrap: wrap; gap: 8px; }
}
```

- [ ] **Step 5: 정적 검사**

```bash
node --check auth.js && node --check app.js && echo "OK"
node tests/run.js
```

Expected: `OK` 그리고 `ALL TESTS PASSED`

- [ ] **Step 6: 실제 배포에 올려 손으로 확인**

Apps Script 편집기에 `Auth.gs`, `Audit.gs`를 새로 만들고 `Code.gs`를 갱신한 뒤, `setPasscodes('직원암호8자이상', '관리자암호8자이상')`을 한 번 실행하고 **편집기에서 그 호출부의 평문을 지운다.** 이어 `setupSheet()`을 실행한다.

배포 → 배포 관리 → 기존 배포 ✏️ → 버전 **새 버전** → 배포.
(「새 배포」를 만들면 URL이 바뀐다. 배포 URL 교체는 계획 2의 P11에서 의도적으로 한다.)

확인 항목:
1. 앱을 열면 **로그인 화면만** 보이고 운행 기록이 보이지 않는다
2. 틀린 암호 → "암호가 올바르지 않습니다", 약 0.5초 지연
3. 직원 암호 → 이름 선택 단계로 넘어가고 `사용자` 시트의 이름이 뜬다
4. 이름 선택 → 앱 화면, 헤더에 본인 이름 표시
5. 새로고침 → 로그인 유지 (localStorage)
6. 로그아웃 → 로그인 화면, 새로고침해도 로그인 화면
7. 차량 드롭다운이 `차량` 시트 4대로 채워진다
8. 저장이 정상 동작하고 `작성자` 열에 본인 이름이 들어간다
9. 브라우저 주소창에 `/exec` URL을 직접 입력 → JSON `UNAUTHORIZED`, 데이터 없음
10. 개발자 도구에서 `localStorage.clear()` 후 새로고침 → 로그인 화면

- [ ] **Step 7: 커밋**

```bash
git add auth.js index.html app.js style.css
git commit -m "feat(ui): two-step login screen and token-bearing requests

세션 로직을 auth.js로 분리했다. app.js에 섞으면 인증 표면을 따로 읽을 수 없다.

토큰은 헤더가 아니라 JSON 본문에 넣는다 — Authorization 헤더는 CORS preflight를
유발하는데 Apps Script는 OPTIONS에 응답할 수 없다.

UNAUTHORIZED 응답을 받으면 폴링을 멈추고 로그인 화면으로 돌아간다. 만료된
토큰으로 30초마다 실패 요청을 보내지 않기 위함이다.

차량 드롭다운 하드코딩을 제거하고 로그인 응답의 목록으로 채운다."
```

---

## Task 7: 출발/도착 계기판과 서버측 거리 계산

**Files:**
- Modify: `apps-script/Code.gs` (`validateLogInput_`)
- Modify: `index.html` (출발계기판 필드 추가, 운행거리 입력 → 표시로 변경)
- Modify: `app.js` (거리 실시간 계산, 이어쓰기 자동입력)
- Modify: `tests/run.js`

**Interfaces:**
- Consumes: Task 2의 `isVehicleAllowed_`; Task 4의 `requireSession_`
- Produces: `validateLogInput_(payload)` → `{valid, errors, clean}`. `clean.distance`는 **항상 서버 계산값**

- [ ] **Step 1: 실패하는 테스트를 먼저 쓴다**

```javascript
test('distance는 서버가 계산하고 클라이언트 값은 무시된다', () => {
  const app = authed();
  const token = boundSession(app, '홍길동');
  const res = app.call(validLog({
    token: token, startOdometer: 12000, endOdometer: 12045, distance: 99999,
  }));
  assertEq(res.data.distance, 45, '서버 재계산');
});

test('도착 < 출발이면 거부된다', () => {
  const app = authed();
  const token = boundSession(app, '홍길동');
  assertError(app.call(validLog({ token: token, startOdometer: 12045, endOdometer: 12000 })),
    'VALIDATION_ERROR', '역전 입력');
});

test('거리 0이면 거부된다', () => {
  const app = authed();
  const token = boundSession(app, '홍길동');
  assertError(app.call(validLog({ token: token, startOdometer: 12000, endOdometer: 12000 })),
    'VALIDATION_ERROR', '거리 0');
});

test('음수 계기판은 거부된다', () => {
  const app = authed();
  const token = boundSession(app, '홍길동');
  assertError(app.call(validLog({ token: token, startOdometer: -1, endOdometer: 100 })),
    'VALIDATION_ERROR', '음수 출발');
});

test('출발계기판 누락은 거부된다', () => {
  const app = authed();
  const token = boundSession(app, '홍길동');
  const body = validLog({ token: token });
  delete body.startOdometer;
  assertError(app.call(body), 'VALIDATION_ERROR', '출발 누락');
});

test('시트에 없는 차량번호는 거부된다', () => {
  const app = authed();
  const token = boundSession(app, '홍길동');
  assertError(app.call(validLog({ token: token, vehicleNo: '0000' })),
    'VALIDATION_ERROR', '미등록 차량');
});

test('1000km 초과도 서버는 저장한다 (경고는 클라이언트 몫)', () => {
  const app = authed();
  const token = boundSession(app, '홍길동');
  const res = app.call(validLog({ token: token, startOdometer: 0, endOdometer: 1500 }));
  assertEq(res.data.distance, 1500, '장거리 허용');
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

```bash
node tests/run.js
```

Expected: `서버 재계산: expected 45, got 99999`

- [ ] **Step 3: `validateLogInput_` 교체**

`Code.gs`의 기존 `validateLogInput_`(258~339행)을 아래로 교체한다.

```javascript
function validateLogInput_(payload) {
  const errors = [];
  const clean = {};
  const text = function (v) {
    return (v === null || v === undefined) ? '' : String(v).trim();
  };
  const missing = function (v) {
    return v === '' || v === null || v === undefined;
  };

  // 차량 — 하드코딩이 아니라 '차량' 시트로 검증한다.
  clean.vehicleNo = text(payload.vehicleNo);
  if (!isVehicleAllowed_(clean.vehicleNo)) {
    errors.push('허용되지 않은 차량번호입니다. 목록에서 선택해 주세요.');
  }

  clean.date = text(payload.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean.date)) {
    errors.push('운행일자를 YYYY-MM-DD 형식으로 입력해 주세요.');
  }

  clean.departTime = text(payload.departTime);
  clean.arriveTime = text(payload.arriveTime);
  if (!/^\d{2}:\d{2}$/.test(clean.departTime) || !/^\d{2}:\d{2}$/.test(clean.arriveTime)) {
    errors.push('출발/도착 시간을 HH:MM 형식으로 입력해 주세요.');
  }

  clean.driver = text(payload.driver);
  if (!clean.driver) errors.push('운전자 성명을 입력해 주세요.');

  // 계기판 2칸 — distance는 받지 않는다. 항상 여기서 계산한다.
  const start = Number(payload.startOdometer);
  const end = Number(payload.endOdometer);
  if (missing(payload.startOdometer) || !isFinite(start) || start < 0) {
    errors.push('출발 계기판 거리를 0 이상의 숫자로 입력해 주세요.');
  } else if (missing(payload.endOdometer) || !isFinite(end) || end < 0) {
    errors.push('도착 계기판 거리를 0 이상의 숫자로 입력해 주세요.');
  } else if (end < start) {
    errors.push('도착 계기판 거리가 출발 계기판 거리보다 작습니다.');
  } else if (end - start === 0) {
    errors.push('운행거리가 0km입니다. 계기판 값을 확인해 주세요.');
  } else {
    clean.startOdometer = start;
    clean.endOdometer = end;
    clean.distance = end - start;
  }

  clean.destination = text(payload.destination);
  if (!clean.destination) errors.push('목적지를 입력해 주세요.');

  clean.purpose = text(payload.purpose);
  if (!clean.purpose) errors.push('운행사유를 입력해 주세요.');

  const passengerCount = Number(payload.passengerCount);
  if (!isFinite(passengerCount) || passengerCount < 1 ||
      Math.floor(passengerCount) !== passengerCount) {
    errors.push('인원수는 1명 이상의 정수로 입력해 주세요.');
  } else {
    clean.passengerCount = passengerCount;
  }

  if (!missing(payload.fuelCost)) {
    const fuelCost = Number(payload.fuelCost);
    if (!isFinite(fuelCost) || fuelCost < 0) {
      errors.push('단가/주유금액은 0 이상의 숫자로 입력해 주세요.');
    } else {
      clean.fuelCost = fuelCost;
    }
  } else {
    clean.fuelCost = '';
  }

  return { valid: errors.length === 0, errors: errors, clean: clean };
}
```

`handleCreate_`에서 `record.createdBy`를 채우도록 `record.createdAt` 설정 다음 줄에 추가한다:

```javascript
    record.createdBy = session.name;
    record.updatedAt = '';
    record.updatedBy = '';
    record.status = STATUS_ACTIVE;
    record.deletedAt = '';
    record.deletedBy = '';
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

```bash
node tests/run.js
```

Expected: 신규 7개 포함 전부 PASS

- [ ] **Step 5: `index.html`의 계기판 영역 교체**

기존 계기판/운행거리 `form-row`(78~93행)를 아래로 교체한다. 운행거리는 **입력 필드가 아니라 표시 영역**이 된다.

```html
                    <div class="form-row">
                        <div class="field">
                            <label for="startOdometer">출발 계기판</label>
                            <div class="field-unit">
                                <input type="number" id="startOdometer" class="num"
                                       placeholder="12000" min="0" step="1" required>
                                <span class="unit">km</span>
                            </div>
                            <p class="hint" id="odometerHint"></p>
                        </div>
                        <div class="field">
                            <label for="endOdometer">도착 계기판</label>
                            <div class="field-unit">
                                <input type="number" id="endOdometer" class="num"
                                       placeholder="12045" min="0" step="1" required>
                                <span class="unit">km</span>
                            </div>
                        </div>
                    </div>

                    <p class="distance-readout" id="distanceReadout">운행거리 — km</p>
```

테이블 헤더(132~144행)의 `<th scope="col">계기판</th>`를 아래 두 개로 바꾼다:

```html
                                <th scope="col">계기판</th>
                                <th scope="col">운행거리</th>
```

기존에 `계기판` / `운행거리` 두 개가 이미 있으므로 **헤더는 그대로 두고** `app.js`의 렌더에서 표시 내용만 `출발→도착`으로 바꾼다(Step 6).

- [ ] **Step 6: `app.js` 수정**

**6-a.** DOM 참조(27~28행)를 교체한다.

```javascript
    const startOdometerInput = document.getElementById('startOdometer');
    const endOdometerInput = document.getElementById('endOdometer');
    const distanceReadout = document.getElementById('distanceReadout');
    const odometerHint = document.getElementById('odometerHint');
```

`const odometerInput` / `const distanceInput` 참조를 전부 제거한다.

**6-b.** 거리 실시간 표시와 이어쓰기를 추가한다.

```javascript
    /** 표시 전용. 서버가 다시 계산하므로 전송하지 않는다. */
    function updateDistanceReadout() {
        const s = Number(startOdometerInput.value);
        const e = Number(endOdometerInput.value);
        if (startOdometerInput.value === '' || endOdometerInput.value === ''
            || !isFinite(s) || !isFinite(e)) {
            distanceReadout.textContent = '운행거리 — km';
            distanceReadout.className = 'distance-readout';
            return;
        }
        if (e < s) {
            distanceReadout.textContent = '도착 계기판이 출발보다 작습니다';
            distanceReadout.className = 'distance-readout warn';
            return;
        }
        const d = e - s;
        distanceReadout.textContent = '운행거리 ' + d.toLocaleString() + ' km'
            + (d > 1000 ? ' — 1,000km를 넘습니다. 계기판 값을 확인해 주세요.' : '');
        distanceReadout.className = 'distance-readout' + (d > 1000 ? ' warn' : '');
    }

    /** 선택한 차량의 가장 최근 도착 계기판을 출발 칸에 채운다.
     *  records가 이미 메모리에 있으므로 추가 API 호출이 없다. */
    function prefillStartOdometer() {
        const vehicleNo = vehicleNoSelect.value;
        if (!vehicleNo) { odometerHint.textContent = ''; return; }

        const mine = records.filter(r => r.vehicleNo === vehicleNo && r.endOdometer !== '');
        if (mine.length === 0) {
            odometerHint.textContent = '이 차량의 첫 기록입니다.';
            return;
        }
        const last = mine[0];   // records는 최신순 정렬
        startOdometerInput.value = last.endOdometer;
        odometerHint.textContent =
            '직전 기록의 도착 계기판(' + Number(last.endOdometer).toLocaleString()
            + 'km)을 채웠습니다. 실제와 다르면 고치세요.';
        updateDistanceReadout();
    }

    startOdometerInput.addEventListener('input', updateDistanceReadout);
    endOdometerInput.addEventListener('input', updateDistanceReadout);
    vehicleNoSelect.addEventListener('change', prefillStartOdometer);
```

**6-c.** `normalizeRecord`에 신규 필드를 추가한다.

```javascript
            startOdometer:  numOrEmpty(r.startOdometer),
            endOdometer:    numOrEmpty(r.endOdometer),
            createdBy:      str(r.createdBy),
            updatedAt:      str(r.updatedAt),
            updatedBy:      str(r.updatedBy),
            status:         str(r.status) || 'ACTIVE',
```

`odometer: num(r.odometer),` 줄은 제거한다.

**6-d.** 폼 제출 payload를 바꾼다. `distance`를 **보내지 않는다.**

```javascript
        const payload = {
            vehicleNo,
            date,
            departTime,
            arriveTime,
            driver,
            passengerCount: passengerCountNum,
            startOdometer: Number(startOdometerInput.value),
            endOdometer: Number(endOdometerInput.value),
            destination,
            purpose,
            fuelCost
        };
```

기존 검증 6·7번(계기판/운행거리, 305~314행)을 아래로 교체한다.

```javascript
        // 6. 계기판 — 서버가 최종 판정하지만 왕복을 줄이기 위해 여기서도 본다
        const startNum = Number(startOdometerInput.value);
        const endNum = Number(endOdometerInput.value);
        if (startOdometerInput.value === '' || !isFinite(startNum) || startNum < 0) {
            showAlert('출발 계기판 거리를 0 이상의 숫자로 입력해 주세요.', 'danger');
            return;
        }
        if (endOdometerInput.value === '' || !isFinite(endNum) || endNum < 0) {
            showAlert('도착 계기판 거리를 0 이상의 숫자로 입력해 주세요.', 'danger');
            return;
        }
        if (endNum < startNum) {
            showAlert('도착 계기판 거리가 출발보다 작습니다.', 'danger');
            return;
        }
        if (endNum === startNum) {
            showAlert('운행거리가 0km입니다. 계기판 값을 확인해 주세요.', 'danger');
            return;
        }
```

**6-e.** 저장 성공 후 폼 초기화 뒤에 이어쓰기를 다시 채운다.

```javascript
            form.reset();
            driveDateInput.value = todayStr();
            await refreshLogs();
            prefillStartOdometer();
```

**6-f.** 테이블 렌더의 계기판 칸(411행)을 교체한다.

```javascript
                <td data-label="계기판">${r.startOdometer === '' ? '-' : Number(r.startOdometer).toLocaleString()} → ${r.endOdometer === '' ? '-' : Number(r.endOdometer).toLocaleString()}</td>
```

**6-g.** `style.css` 맨 끝에 추가한다.

```css
.distance-readout {
  margin: 4px 0 0;
  font-size: 15px;
  font-weight: 600;
}
.distance-readout.warn { color: var(--danger, #dc2626); }
```

- [ ] **Step 7: 정적 검사와 수동 확인**

```bash
node --check app.js && node tests/run.js
```

배포 갱신 후 확인:
1. 차량 선택 → 출발 계기판이 직전 기록의 도착값으로 채워진다
2. 도착 계기판 입력 → 운행거리가 실시간 계산된다
3. 도착 < 출발 → 빨간 경고
4. 1,000km 초과 → 경고 문구가 뜨지만 저장은 된다
5. 개발자 도구 콘솔에서 위조 시도 — 저장된 행의 운행거리가 45km인지 확인:
   ```js
   fetch(window.APP_CONFIG.APPS_SCRIPT_URL, {method:'POST',
     headers:{'Content-Type':'text/plain;charset=utf-8'},
     body: JSON.stringify({action:'create', token: JSON.parse(localStorage['vehicleLog.session']).token,
       date:'2026-08-10', departTime:'09:00', arriveTime:'10:00', driver:'테스트',
       startOdometer:1000, endOdometer:1045, distance:99999,
       destination:'테스트', purpose:'검증', passengerCount:1, vehicleNo:'0704'})
   }).then(r=>r.json()).then(console.log)
   ```

- [ ] **Step 8: 커밋**

```bash
git add apps-script/Code.gs index.html app.js style.css tests/run.js
git commit -m "feat(odometer): split start/end and compute distance server-side

클라이언트가 보낸 distance는 받지도 않고 버린다. 서버가 항상 다시 계산한다.
운행거리 입력 필드를 표시 영역으로 바꿔 위조 경로 자체를 없앴다.

차량 선택 시 직전 기록의 도착 계기판을 출발 칸에 채운다. records가 이미
메모리에 있어 추가 API 호출이 없다."
```

---

## Task 8: 수정 기능

**Files:**
- Modify: `apps-script/Code.gs` (`handleUpdate_` 실구현)
- Modify: `app.js` (수정 버튼, 폼 채우기, 취소)
- Modify: `index.html` (수정 취소 버튼)
- Modify: `tests/run.js`

**Interfaces:**
- Consumes: Task 7의 `validateLogInput_`; Task 5의 `writeAudit_`, `diffSummary_`
- Produces: `handleUpdate_(payload)` — `{token, id, ...필드}` → 갱신된 레코드. `id`/`createdAt`/`createdBy` 불변

- [ ] **Step 1: 실패하는 테스트를 먼저 쓴다**

```javascript
function createOne(app, token, extra) {
  return app.call(validLog(Object.assign({ token: token }, extra || {}))).data;
}

test('수정이 같은 행을 갱신하고 행 수가 늘지 않는다', () => {
  const app = authed();
  const token = boundSession(app, '홍길동');
  const rec = createOne(app, token);
  const before = app.sheet('운행일지').data.length;

  const res = app.call({
    action: 'update', token: token, id: rec.id,
    date: rec.date, departTime: rec.departTime, arriveTime: rec.arriveTime,
    driver: '김철수', startOdometer: 12000, endOdometer: 12100,
    destination: rec.destination, purpose: rec.purpose,
    passengerCount: 3, fuelCost: 60000, vehicleNo: rec.vehicleNo,
  });

  assertEq(res.success, true, '수정 성공');
  assertEq(app.sheet('운행일지').data.length, before, '행 수 불변');
  assertEq(res.data.id, rec.id, 'id 불변');
  assertEq(res.data.createdAt, rec.createdAt, 'createdAt 불변');
  assertEq(res.data.createdBy, '홍길동', 'createdBy 불변');
  assertEq(res.data.driver, '김철수', '운전자 변경 반영');
  assertEq(res.data.distance, 100, '거리 재계산');
  assertEq(res.data.updatedBy, '홍길동', 'updatedBy 기록');
  if (!res.data.updatedAt) throw new Error('updatedAt 미기록');
});

test('없는 id를 수정하면 NOT_FOUND', () => {
  const app = authed();
  const token = boundSession(app, '홍길동');
  assertError(app.call({ action: 'update', token: token, id: 'no-such-id',
    date: '2026-08-10', departTime: '09:00', arriveTime: '10:00', driver: 'x',
    startOdometer: 1, endOdometer: 2, destination: 'x', purpose: 'x',
    passengerCount: 1, vehicleNo: '0704' }), 'NOT_FOUND', '없는 id');
});

test('검증 실패한 수정은 기존 행을 손상시키지 않는다', () => {
  const app = authed();
  const token = boundSession(app, '홍길동');
  const rec = createOne(app, token);

  assertError(app.call({ action: 'update', token: token, id: rec.id,
    date: rec.date, departTime: rec.departTime, arriveTime: rec.arriveTime,
    driver: rec.driver, startOdometer: 999, endOdometer: 1,
    destination: rec.destination, purpose: rec.purpose,
    passengerCount: 1, vehicleNo: rec.vehicleNo }), 'VALIDATION_ERROR', '역전 수정');

  const after = app.run('getLogs_(false)')[0];
  assertEq(after.distance, rec.distance, '원본 거리 유지');
  assertEq(after.driver, rec.driver, '원본 운전자 유지');
});

test('UPDATE가 감사 로그에 변경 요약과 함께 남는다', () => {
  const app = authed();
  const token = boundSession(app, '홍길동');
  const rec = createOne(app, token);
  app.call({ action: 'update', token: token, id: rec.id,
    date: rec.date, departTime: rec.departTime, arriveTime: rec.arriveTime,
    driver: '김철수', startOdometer: 12000, endOdometer: 12045,
    destination: rec.destination, purpose: rec.purpose,
    passengerCount: rec.passengerCount, vehicleNo: rec.vehicleNo });

  const rows = app.sheet('감사로그').data.slice(1).filter((r) => r[1] === 'UPDATE');
  assertEq(rows.length, 1, 'UPDATE 1건');
  if (String(rows[0][5]).indexOf('driver') === -1) {
    throw new Error('변경 요약에 driver 없음: ' + rows[0][5]);
  }
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

```bash
node tests/run.js
```

Expected: `수정 성공: 성공 응답이 왔음` 실패 — 현재 `handleUpdate_`가 "준비 중입니다" 스텁이므로.

- [ ] **Step 3: `handleUpdate_` 실구현**

Task 4 Step 5에서 넣은 `handleUpdate_` 스텁을 아래로 교체한다.

```javascript
/** 같은 행을 in-place 갱신한다. 삭제 후 재생성하지 않는다. */
function handleUpdate_(payload) {
  const session = requireSession_(payload);

  const id = payload.id ? String(payload.id).trim() : '';
  if (!id) return errorResponse_('VALIDATION_ERROR', '수정할 기록 ID가 없습니다.', 400);

  // 검증을 락 밖에서 먼저 한다. 잘못된 입력으로 락을 잡을 이유가 없다.
  const result = validateLogInput_(payload);
  if (!result.valid) return errorResponse_('VALIDATION_ERROR', result.errors[0], 400);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    return errorResponse_('BUSY', '다른 요청을 처리 중입니다. 잠시 후 다시 시도해 주세요.', 503);
  }
  try {
    const sheet = getSheet_(REC_SHEET);
    const index = getHeaderIndex_(sheet);
    const rowNum = findRowById_(sheet, index, id);
    if (rowNum === -1) {
      return errorResponse_('NOT_FOUND', '해당 기록을 찾을 수 없습니다.', 404);
    }

    const width = Math.max(sheet.getLastColumn(), COLUMNS.length);
    const rowValues = sheet.getRange(rowNum, 1, 1, width).getValues()[0];

    const before = {};
    COLUMNS.forEach(function (col) {
      before[col.key] = normalizeCell_(rowValues[index[col.key]], col.type);
    });

    if (before.status === STATUS_DELETED) {
      return errorResponse_('NOT_FOUND', '삭제된 기록은 수정할 수 없습니다.', 404);
    }

    // 불변 필드는 기존 값을 그대로 쓴다. 클라이언트가 보낸 값은 무시한다.
    const record = {
      id: before.id,
      createdAt: before.createdAt,
      createdBy: before.createdBy,
      status: STATUS_ACTIVE,
      deletedAt: '',
      deletedBy: '',
      updatedAt: Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX"),
      updatedBy: session.name,
    };
    ['date', 'departTime', 'arriveTime', 'driver', 'startOdometer', 'endOdometer',
     'distance', 'destination', 'purpose', 'passengerCount', 'fuelCost', 'vehicleNo']
      .forEach(function (k) { record[k] = result.clean[k]; });

    // 단일 setValues. 부분 실패로 행이 반쯤 갱신되는 상태가 없다.
    COLUMNS.forEach(function (col) { rowValues[index[col.key]] = record[col.key]; });
    sheet.getRange(rowNum, 1, 1, width).setValues([rowValues]);

    writeAudit_('UPDATE', id, session, diffSummary_(before, record,
      ['date', 'departTime', 'arriveTime', 'driver', 'startOdometer', 'endOdometer',
       'distance', 'destination', 'purpose', 'passengerCount', 'fuelCost', 'vehicleNo']));

    return jsonResponse_({ success: true, message: '운행일지가 수정되었습니다.', data: record });
  } finally {
    lock.releaseLock();
  }
}

/** id로 행 번호를 찾는다. 없으면 -1. 인덱스를 캐시하지 않는다. */
function findRowById_(sheet, index, id) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const ids = sheet.getRange(2, index.id + 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === id) return i + 2;
  }
  return -1;
}
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

```bash
node tests/run.js
```

Expected: 신규 4개 포함 전부 PASS

- [ ] **Step 5: `index.html`에 수정 취소 버튼 추가**

저장 버튼(118행) 다음에 넣는다.

```html
                    <button type="button" class="btn-primary hidden" id="cancelEditButton"
                            style="background:#9ca3af">수정 취소</button>
```

- [ ] **Step 6: `app.js`에 수정 UI 추가**

**6-a.** 상단에 상태 변수와 DOM 참조를 추가한다.

```javascript
    const cancelEditButton = document.getElementById('cancelEditButton');
    let editingId = '';
```

**6-b.** 폼 채우기·초기화 함수를 추가한다.

```javascript
    function enterEditMode(record) {
        editingId = record.id;
        vehicleNoSelect.value = record.vehicleNo;
        driveDateInput.value = record.date;
        departTimeInput.value = record.departTime;
        arriveTimeInput.value = record.arriveTime;
        driverNameInput.value = record.driver;
        passengerCountInput.value = record.passengerCount;
        startOdometerInput.value = record.startOdometer;
        endOdometerInput.value = record.endOdometer;
        destinationInput.value = record.destination;
        purposeInput.value = record.purpose;
        fuelCostInput.value = record.fuelCost === '' ? '' : record.fuelCost;

        odometerHint.textContent = '기존 기록을 수정하는 중입니다.';
        cancelEditButton.classList.remove('hidden');
        submitButton.textContent = '수정 저장';
        updateDistanceReadout();
        window.scrollTo(0, 0);
    }

    function exitEditMode() {
        editingId = '';
        form.reset();
        driveDateInput.value = todayStr();
        cancelEditButton.classList.add('hidden');
        submitButton.textContent = '운행일지 저장';
        odometerHint.textContent = '';
        hideAlert();
        updateDistanceReadout();
    }

    cancelEditButton.addEventListener('click', exitEditMode);
```

**6-c.** `createLog` 옆에 `updateLog`를 추가한다.

```javascript
    async function updateLog(id, logData) {
        const result = await apiRequest(Object.assign({ action: 'update', id }, logData));
        return normalizeRecord(result.data);
    }
```

**6-d.** 폼 제출의 `await createLog(payload);` 부분을 분기한다.

```javascript
        try {
            if (editingId) {
                await updateLog(editingId, payload);
                showAlert('운행일지가 수정되었습니다.', 'success');
                exitEditMode();
            } else {
                await createLog(payload);
                showAlert('운행일지가 성공적으로 등록되었습니다!', 'success');
                form.reset();
                driveDateInput.value = todayStr();
            }
            await refreshLogs();
            prefillStartOdometer();
        } catch (err) {
```

`submitButton.textContent = '저장 중...';` 은 그대로 두되, `finally` 블록의 `submitButton.innerHTML = originalLabel;`을 아래로 바꿔 수정 모드 레이블이 유지되게 한다.

```javascript
            submitButton.textContent = editingId ? '수정 저장' : '운행일지 저장';
```

**6-e.** 테이블 액션 칸(417~420행)에 수정 버튼을 추가한다.

```javascript
                <td class="col-actions">
                    <button class="btn-edit" data-id="${escapeHTML(r.id)}"
                            aria-label="${escapeHTML(r.date)} ${escapeHTML(r.vehicleNo)} 기록 수정">수정</button>
                    <button class="btn-delete" data-id="${escapeHTML(r.id)}"
                            aria-label="${escapeHTML(r.date)} ${escapeHTML(r.vehicleNo)} 기록 삭제">삭제</button>
                </td>
```

삭제 리스너 등록부(426행) 앞에 수정 리스너를 추가한다.

```javascript
        document.querySelectorAll('.btn-edit').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.currentTarget.getAttribute('data-id');
                const record = records.find(r => r.id === id);
                if (record) enterEditMode(record);
            });
        });
```

**6-f.** 수정 중 폴링이 폼을 방해하지 않게 한다. `refreshLogs`의 `renderTable()` 호출은 폼을 건드리지 않으므로 안전하지만, 수정 중 목록이 갱신되어 대상 행이 사라질 수 있다. `renderTable` 맨 앞에 추가한다.

```javascript
        // 수정 중인 기록이 목록에서 사라지면(다른 사람이 삭제) 편집을 중단한다.
        if (editingId && !records.some(r => r.id === editingId)) {
            exitEditMode();
            showAlert('수정 중이던 기록이 다른 사용자에 의해 삭제되었습니다.', 'danger');
        }
```

**6-g.** `style.css` 맨 끝에 추가한다. 기존 `.btn-delete` 규칙을 수정하지 않는다.

```css
.btn-edit {
  padding: 6px 10px;
  margin-right: 4px;
  border: 1px solid var(--line, #dfe3e8);
  border-radius: 6px;
  background: transparent;
  font-size: 13px;
  font-family: inherit;
  color: inherit;
  cursor: pointer;
}
.btn-edit:disabled { opacity: .5; cursor: progress; }
```

- [ ] **Step 7: 정적 검사와 수동 확인**

```bash
node --check app.js && node tests/run.js
```

배포 갱신 후 확인:
1. 「수정」 → 폼에 값이 채워지고 「수정 취소」 버튼이 나타난다
2. 값을 바꿔 저장 → **시트 행 수가 늘지 않고** 기존 행이 바뀐다
3. `작성시각`·`작성자`가 그대로이고 `수정시각`·`수정자`가 채워진다
4. 「수정 취소」 → 폼이 비고 저장 버튼 레이블이 돌아온다
5. 새로고침 → 수정 내용이 유지된다
6. 도착 < 출발로 수정 시도 → 거부되고 **원본이 그대로다** (시트에서 확인)

- [ ] **Step 8: 커밋**

```bash
git add apps-script/Code.gs index.html app.js style.css tests/run.js
git commit -m "feat(update): in-place record editing

삭제 후 재생성이 아니라 같은 행을 단일 setValues로 갱신한다. 부분 실패로
행이 반쯤 갱신되는 상태가 없다.

id/createdAt/createdBy는 클라이언트가 보낸 값을 무시하고 기존 값을 쓴다.
검증은 락을 잡기 전에 끝낸다."
```

---

## Task 9: 소프트 삭제와 복구

**Files:**
- Modify: `apps-script/Code.gs` (`handleDelete_` 교체, `handleRestore_` 실구현)
- Modify: `app.js` (삭제된 기록 보기 토글, 복구 버튼)
- Modify: `index.html` (관리자 토글)
- Modify: `tests/run.js`

**Interfaces:**
- Consumes: Task 8의 `findRowById_`; Task 5의 `writeAudit_`
- Produces:
  - `handleDelete_(payload)` — `status=DELETED` + `deletedAt`/`deletedBy`. **행을 지우지 않는다**
  - `handleRestore_(payload)` — ADMIN 전용. `status=ACTIVE` 복원

- [ ] **Step 1: 실패하는 테스트를 먼저 쓴다**

```javascript
function adminToken(app, name) {
  app.sheet('사용자').appendRow([name, 'ADMIN', true]);
  const login = app.call({ action: 'login', passcode: 'admin-pw-5678' });
  return app.call({ action: 'bind', token: login.data.token, name: name }).data.token;
}

test('삭제는 행을 지우지 않고 status만 바꾼다', () => {
  const app = authed();
  const token = boundSession(app, '홍길동');
  const rec = createOne(app, token);
  const before = app.sheet('운행일지').data.length;

  assertEq(app.call({ action: 'delete', token: token, id: rec.id }).success, true, '삭제 성공');
  assertEq(app.sheet('운행일지').data.length, before, '시트 행이 남아 있다');
  assertEq(app.run('getLogs_(false)').length, 0, '기본 목록에서 사라짐');

  const kept = app.run('getLogs_(true)')[0];
  assertEq(kept.status, 'DELETED', 'status');
  assertEq(kept.deletedBy, '홍길동', 'deletedBy');
  if (!kept.deletedAt) throw new Error('deletedAt 미기록');
});

test('USER는 삭제된 기록을 볼 수 없고 복구도 못 한다', () => {
  const app = authed();
  const token = boundSession(app, '홍길동');
  const rec = createOne(app, token);
  app.call({ action: 'delete', token: token, id: rec.id });

  // includeDeleted를 요청해도 조용히 무시된다 (에러 아님)
  const res = app.call({ action: 'list', token: token, includeDeleted: true });
  assertEq(res.success, true, 'list 성공');
  assertEq(res.count, 0, 'USER에게는 안 보임');

  assertError(app.call({ action: 'restore', token: token, id: rec.id }),
    'FORBIDDEN', 'USER 복구 시도');
});

test('ADMIN은 삭제된 기록을 보고 복구할 수 있다', () => {
  const app = authed();
  const userToken = boundSession(app, '홍길동');
  const rec = createOne(app, userToken);
  app.call({ action: 'delete', token: userToken, id: rec.id });

  const admin = adminToken(app, '관리자');
  assertEq(app.call({ action: 'list', token: admin, includeDeleted: true }).count, 1, 'ADMIN 조회');

  const res = app.call({ action: 'restore', token: admin, id: rec.id });
  assertEq(res.success, true, '복구 성공');
  assertEq(res.data.status, 'ACTIVE', '상태 복원');
  assertEq(app.call({ action: 'list', token: userToken }).count, 1, '일반 목록에 복귀');
});

test('이미 삭제된 기록을 다시 삭제하면 NOT_FOUND', () => {
  const app = authed();
  const token = boundSession(app, '홍길동');
  const rec = createOne(app, token);
  app.call({ action: 'delete', token: token, id: rec.id });
  assertError(app.call({ action: 'delete', token: token, id: rec.id }),
    'NOT_FOUND', '중복 삭제');
});

test('DELETE와 RESTORE가 감사 로그에 남는다', () => {
  const app = authed();
  const token = boundSession(app, '홍길동');
  const rec = createOne(app, token);
  app.call({ action: 'delete', token: token, id: rec.id });
  const admin = adminToken(app, '관리자');
  app.call({ action: 'restore', token: admin, id: rec.id });

  const rows = app.sheet('감사로그').data.slice(1);
  assertEq(rows.filter((r) => r[1] === 'DELETE').length, 1, 'DELETE 기록');
  const restored = rows.filter((r) => r[1] === 'RESTORE');
  assertEq(restored.length, 1, 'RESTORE 기록');
  assertEq(restored[0][4], 'ADMIN', '복구자 권한');
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

```bash
node tests/run.js
```

Expected: `시트 행이 남아 있다` 실패 — 현재 하드 삭제라 행이 사라진다.

- [ ] **Step 3: `handleDelete_` 교체와 `handleRestore_` 실구현**

기존 `handleDelete_` 전체와 Task 4의 `handleRestore_` 스텁을 아래로 교체한다.

```javascript
/** 상태 전이 공통부. 행을 물리적으로 지우지 않는다. */
function setRecordStatus_(payload, nextStatus, session, auditAction) {
  const id = payload.id ? String(payload.id).trim() : '';
  if (!id) {
    return errorResponse_('VALIDATION_ERROR', '대상 기록 ID가 없습니다.', 400);
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    return errorResponse_('BUSY', '다른 요청을 처리 중입니다. 잠시 후 다시 시도해 주세요.', 503);
  }
  try {
    const sheet = getSheet_(REC_SHEET);
    const index = getHeaderIndex_(sheet);
    const rowNum = findRowById_(sheet, index, id);
    if (rowNum === -1) {
      return errorResponse_('NOT_FOUND', '해당 기록을 찾을 수 없습니다.', 404);
    }

    const width = Math.max(sheet.getLastColumn(), COLUMNS.length);
    const rowValues = sheet.getRange(rowNum, 1, 1, width).getValues()[0];

    const record = {};
    COLUMNS.forEach(function (col) {
      record[col.key] = normalizeCell_(rowValues[index[col.key]], col.type);
    });
    // 공란은 ACTIVE로 본다.
    const current = (record.status === STATUS_DELETED) ? STATUS_DELETED : STATUS_ACTIVE;

    if (current === nextStatus) {
      return errorResponse_('NOT_FOUND',
        nextStatus === STATUS_DELETED
          ? '이미 삭제된 기록입니다.'
          : '삭제되지 않은 기록입니다.', 404);
    }

    const now = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
    record.status = nextStatus;
    if (nextStatus === STATUS_DELETED) {
      record.deletedAt = now;
      record.deletedBy = session.name;
    } else {
      record.deletedAt = '';
      record.deletedBy = '';
      record.updatedAt = now;
      record.updatedBy = session.name;
    }

    COLUMNS.forEach(function (col) { rowValues[index[col.key]] = record[col.key]; });
    sheet.getRange(rowNum, 1, 1, width).setValues([rowValues]);

    writeAudit_(auditAction, id, session,
      record.date + ' ' + record.vehicleNo + ' ' + record.distance + 'km');

    return jsonResponse_({
      success: true,
      message: nextStatus === STATUS_DELETED
        ? '운행일지가 삭제되었습니다.' : '운행일지가 복구되었습니다.',
      data: record,
    });
  } finally {
    lock.releaseLock();
  }
}

function handleDelete_(payload) {
  const session = requireSession_(payload);
  return setRecordStatus_(payload, STATUS_DELETED, session, 'DELETE');
}

function handleRestore_(payload) {
  const session = requireAdmin_(payload);
  return setRecordStatus_(payload, STATUS_ACTIVE, session, 'RESTORE');
}
```

`sheet.deleteRow(...)` 호출은 이제 코드 어디에도 남지 않는다. 확인:

```bash
grep -n "deleteRow" apps-script/*.gs
```

Expected: 출력 없음

- [ ] **Step 4: 테스트 실행 — 통과 확인**

```bash
node tests/run.js
```

Expected: 신규 5개 포함 전부 PASS

- [ ] **Step 5: `index.html`에 관리자 토글 추가**

원장 패널 헤더(124~127행)의 `lastUpdated` 옆에 넣는다.

```html
                    <label id="showDeletedWrap" class="show-deleted hidden">
                        <input type="checkbox" id="showDeleted"> 삭제된 기록 보기
                    </label>
                    <span id="lastUpdated" class="last-updated"></span>
```

- [ ] **Step 6: `app.js`에 복구 UI 추가**

**6-a.** DOM 참조와 상태를 추가한다.

```javascript
    const showDeletedWrap = document.getElementById('showDeletedWrap');
    const showDeletedCheckbox = document.getElementById('showDeleted');
    let includeDeleted = false;
```

**6-b.** `fetchLogs`가 토글을 반영하게 한다.

```javascript
    async function fetchLogs() {
        const result = await apiRequest({ action: 'list', includeDeleted });
        const list = Array.isArray(result.data) ? result.data : [];
        return sortByNewest(list.map(normalizeRecord));
    }

    async function restoreLogById(id) {
        await apiRequest({ action: 'restore', id });
    }
```

**6-c.** 세션 준비 시 관리자에게만 토글을 보인다. `window.Session.start` 콜백을 확장한다.

```javascript
    window.Session.start(function onSessionReady() {
        fillVehicleOptions();
        if (window.Session.isAdmin()) {
            showDeletedWrap.classList.remove('hidden');
            showDeletedCheckbox.addEventListener('change', () => {
                includeDeleted = showDeletedCheckbox.checked;
                lastRenderedSignature = null;
                refreshLogs({ showLoading: true });
            });
        }
        refreshLogs({ showLoading: true });
        startPolling();
    });
```

**6-d.** 삭제된 행을 구분해 표시하고 복구 버튼을 단다. `renderTable`의 `records.forEach` 안에서 `tr` 생성 직후에 추가한다.

```javascript
            if (r.status === 'DELETED') tr.classList.add('row-deleted');
```

액션 칸을 상태에 따라 바꾼다.

```javascript
            const actionCell = r.status === 'DELETED'
                ? `<button class="btn-edit" data-restore="${escapeHTML(r.id)}"
                           aria-label="${escapeHTML(r.date)} 기록 복구">복구</button>`
                : `<button class="btn-edit" data-id="${escapeHTML(r.id)}"
                           aria-label="${escapeHTML(r.date)} ${escapeHTML(r.vehicleNo)} 기록 수정">수정</button>
                   <button class="btn-delete" data-id="${escapeHTML(r.id)}"
                           aria-label="${escapeHTML(r.date)} ${escapeHTML(r.vehicleNo)} 기록 삭제">삭제</button>`;
```

그리고 템플릿의 `<td class="col-actions">...</td>`를 `<td class="col-actions">${actionCell}</td>`로 바꾼다.

리스너 등록부에 복구를 추가한다.

```javascript
        document.querySelectorAll('[data-restore]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const button = e.currentTarget;
                const id = button.getAttribute('data-restore');
                if (!confirm('이 기록을 복구하시겠습니까?')) return;
                button.disabled = true;
                try {
                    await restoreLogById(id);
                    await refreshLogs();
                } catch (err) {
                    console.error('Failed to restore log', err);
                    showAlert(err.message || '복구에 실패했습니다.', 'danger');
                    button.disabled = false;
                }
            });
        });
```

삭제 확인 문구를 소프트 삭제에 맞게 바꾼다(430행).

```javascript
                if (!confirm('해당 운행 기록을 삭제하시겠습니까?\n관리자가 복구할 수 있습니다.')) return;
```

**6-e.** `style.css` 맨 끝에 추가한다.

```css
.show-deleted {
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.show-deleted input { width: auto; }
.row-deleted { opacity: .55; }
.row-deleted td { text-decoration: line-through; }
.row-deleted .col-actions { text-decoration: none; }
```

- [ ] **Step 7: 정적 검사와 수동 확인**

```bash
node --check app.js && node tests/run.js && grep -c "deleteRow" apps-script/*.gs
```

Expected: `ALL TESTS PASSED`, `deleteRow` 개수 0

배포 갱신 후 확인:
1. 일반 계정 로그인 → 「삭제된 기록 보기」 토글이 **보이지 않는다**
2. 삭제 → 목록에서 사라지지만 **구글 시트에는 행이 그대로 있고** 상태가 `DELETED`
3. 관리자 계정 로그인 → 토글이 보인다
4. 토글 켜기 → 삭제된 행이 취소선으로 표시되고 「복구」 버튼이 있다
5. 복구 → 일반 목록에 다시 나타난다
6. `감사로그` 시트에 DELETE·RESTORE가 사용자·권한과 함께 남는다

- [ ] **Step 8: 커밋**

```bash
git add apps-script/Code.gs index.html app.js style.css tests/run.js
git commit -m "feat(delete): soft delete with admin restore

물리 삭제 코드를 전부 제거했다. deleteRow 호출이 코드에 남지 않는다.

status 공란을 ACTIVE로 해석하므로 기존 행이 소프트 삭제 도입으로 사라지지 않는다.
USER가 includeDeleted를 요청하면 에러 대신 조용히 무시한다 — 권한 경계를
탐색당하지 않게 하기 위함이다."
```

---

## Task 10: 1부 통합 QA

**Files:**
- Modify: `tests/run.js` (동시성·회귀 테스트 추가)
- Create: `docs/superpowers/reports/2026-08-10-part1-qa.md`

- [ ] **Step 1: 동시성·회귀 테스트를 추가한다**

```javascript
test('락을 못 잡으면 BUSY를 반환하고 시트를 건드리지 않는다', () => {
  const app = authed();
  const token = boundSession(app, '홍길동');
  const before = app.sheet('운행일지').data.length;
  app.state.lockAvailable = false;
  assertError(app.call(validLog({ token: token })), 'BUSY', '락 실패');
  assertEq(app.sheet('운행일지').data.length, before, '행이 추가되지 않음');
});

test('모든 쓰기가 락을 잡고 반드시 반납한다', () => {
  const app = authed();
  const token = boundSession(app, '홍길동');
  const rec = createOne(app, token);
  app.call({ action: 'update', token: token, id: rec.id,
    date: rec.date, departTime: rec.departTime, arriveTime: rec.arriveTime,
    driver: rec.driver, startOdometer: 12000, endOdometer: 12050,
    destination: rec.destination, purpose: rec.purpose,
    passengerCount: 1, vehicleNo: rec.vehicleNo });
  app.call({ action: 'delete', token: token, id: rec.id });
  assertEq(app.state.lockCount, app.state.lockReleased, '잡은 횟수 == 반납 횟수');
});

test('연속 생성 시 ID가 중복되지 않는다', () => {
  const app = authed();
  const token = boundSession(app, '홍길동');
  const ids = {};
  for (let i = 0; i < 50; i++) {
    const id = createOne(app, token, { startOdometer: i * 100, endOdometer: i * 100 + 50 }).id;
    if (ids[id]) throw new Error('ID 중복: ' + id);
    ids[id] = true;
  }
});

test('8KB 초과 요청은 거부된다', () => {
  const app = authed();
  const token = boundSession(app, '홍길동');
  assertError(app.call(validLog({ token: token, purpose: 'x'.repeat(9000) })),
    'PAYLOAD_TOO_LARGE', '대용량 페이로드');
});

test('XSS 페이로드가 그대로 저장되고 이스케이프는 클라이언트 몫이다', () => {
  const app = authed();
  const token = boundSession(app, '홍길동');
  const evil = '<img src=x onerror=alert(1)>';
  const rec = createOne(app, token, { destination: evil });
  assertEq(rec.destination, evil, '서버는 원문 보존');
  const fetched = app.call({ action: 'list', token: token }).data[0];
  assertEq(fetched.destination, evil, '조회 시에도 원문');
});

test('알 수 없는 action은 쓰기로 처리되지 않는다', () => {
  const app = authed();
  const token = boundSession(app, '홍길동');
  const before = app.sheet('운행일지').data.length;
  assertError(app.call({ token: token }), 'UNKNOWN_ACTION', 'action 누락');
  assertError(app.call({ action: 'wat', token: token }), 'UNKNOWN_ACTION', '모르는 action');
  assertEq(app.sheet('운행일지').data.length, before, '행 변화 없음');
});

test('오류 응답에 스택 트레이스가 없다', () => {
  const app = authed();
  const res = app.call({ action: 'list', token: 'garbage' });
  const dump = JSON.stringify(res);
  for (const leak of ['at Object', '.gs:', 'evalmachine', 'stack']) {
    if (dump.indexOf(leak) >= 0) throw new Error('스택 노출: ' + leak);
  }
});
```

- [ ] **Step 2: 전체 테스트 실행**

```bash
node tests/run.js
node --check app.js && node --check auth.js && echo "클라이언트 문법 OK"
grep -rn "ALLOWED_VEHICLES" apps-script/ app.js index.html || echo "차량 하드코딩 없음"
grep -rn "deleteRow" apps-script/ || echo "물리 삭제 없음"
```

Expected: `ALL TESTS PASSED`, `클라이언트 문법 OK`, `차량 하드코딩 없음`, `물리 삭제 없음`

- [ ] **Step 3: 실기기 수동 QA**

배포 갱신 후 아래를 순서대로 통과시킨다. 하나라도 실패하면 계획 2로 넘어가지 않는다.

**보안**
1. 로그아웃 상태로 `/exec` URL 직접 접속 → `UNAUTHORIZED`, 데이터 없음
2. 개발자 도구에서 `localStorage['vehicleLog.session']`의 토큰 문자열을 한 글자 바꾼 뒤 새로고침 → 세션 만료 처리되고 로그인 화면
3. 일반 계정으로 콘솔에서 직접 호출 → `FORBIDDEN`
   ```js
   const t = JSON.parse(localStorage['vehicleLog.session']).token;
   fetch(window.APP_CONFIG.APPS_SCRIPT_URL, {method:'POST',
     headers:{'Content-Type':'text/plain;charset=utf-8'},
     body: JSON.stringify({action:'restore', token:t, id:'anything'})
   }).then(r=>r.json()).then(console.log)
   ```
4. 틀린 암호 11회 → `RATE_LIMITED`, 10분 후 정상 복귀

**데이터**
5. 두 브라우저(또는 폰+PC)에서 동시에 저장 → 두 행 모두 남고 ID가 다르다
6. 삭제 → 시트에 행이 남고 `상태` 열이 `DELETED`
7. 관리자로 복구 → 목록 복귀
8. 수정 → 행 수 불변, `작성시각` 불변, `수정시각` 갱신

**모바일 (실제 폰)**
9. 세로 화면에서 가로 스크롤 없이 로그인 → 입력 → 저장이 된다
10. 긴 목적지(30자 이상) 입력 시 테이블이 깨지지 않는다
11. 수정/삭제 버튼을 손가락으로 정확히 누를 수 있다
12. 계기판 입력 시 숫자 키패드가 뜬다

**회귀**
13. 30초 폴링이 동작하고 「최근 갱신」 시각이 바뀐다
14. 탭을 백그라운드로 보내면 폴링이 멈춘다
15. 목적지에 `<img src=x onerror=alert(1)>` 저장 → 목록에 **문자 그대로** 표시, 경고창 없음
16. 네트워크를 끊고 저장 시도 → 명확한 오류 메시지, 스택 트레이스 없음

- [ ] **Step 4: QA 보고서 작성**

`docs/superpowers/reports/2026-08-10-part1-qa.md`에 스펙 §10.1 형식으로 기록한다.

```markdown
# 1부 QA 보고서 — 보안·스키마·핵심 CRUD

## 단계
P0 ~ P6 (계획 1의 Task 1~10)

## 변경 내용
- 공용 암호 2개 기반 인증, HMAC 서명 세션 토큰 (12시간)
- doGet 차단, 전 action 토큰 요구, 이름 없는 토큰 거부
- 스키마 13열 → 20열 (추가 전용, 기존 열 미이동)
- 감사 로그 (CREATE/UPDATE/DELETE/RESTORE/LOGIN_FAIL)
- 출발/도착 계기판 분리, 서버측 거리 재계산
- 수정 기능 (in-place)
- 소프트 삭제 + 관리자 복구
- 차량 목록 하드코딩 3곳 제거

## 수정 파일
apps-script/Code.gs, apps-script/Auth.gs(신규), apps-script/Audit.gs(신규),
auth.js(신규), app.js, index.html, style.css,
tests/harness.js(신규), tests/run.js(신규), .gitignore

## 변경 이유
공개 GitHub에 라이브 /exec URL이 노출된 상태에서 백엔드에 인증이 전무해
누구나 전 기록 조회·위조·영구 삭제가 가능했다.

## 보존된 기존 기능
LockService 동시성 제어, escapeHTML, AbortController 타임아웃,
visibilitychange 폴링 중단, isRefreshing 중복 방지, 렌더 시그니처 비교,
30초 폴링 주기, 8KB 페이로드 제한, 기존 UI 시각적 정체성

## 수행한 테스트
[Step 2 자동 테스트 결과와 Step 3 수동 16항목 결과를 여기에 적는다]

## 테스트 결과
[실행 후 채운다]

## 알려진 한계
1. 내부자 사칭 가능 (이름 자기 신고) — B안의 설계상 대가
2. 중복 저장 방지 없음 — 타임아웃 후 재시도 시 2건 가능
3. 폴링이 전량 조회 — 약 2,000행에서 재검토
4. 속도 제한 카운터가 캐시 축출로 초기화될 수 있음
5. 개별 세션 무효화 불가 (TOKEN_VERSION 전체 무효화만)

## 다음 단계
계획 2 (P7~P12): 필터, 통계, CSV 내보내기, 감사 로그 조회 UI,
인쇄 CSS, CSP 헤더, 배포 URL 교체, 문서 정리
```

- [ ] **Step 5: 커밋**

```bash
git add tests/run.js docs/superpowers/reports/2026-08-10-part1-qa.md
git commit -m "test: part 1 integration QA and report

동시성(락 반납), ID 중복, 페이로드 상한, XSS 원문 보존, action 누락 시
쓰기 미발생, 스택 트레이스 미노출을 자동 검증한다."
```

---

## 자체 검토

**1. 스펙 커버리지** — 이 계획이 담당하는 스펙 항목:

| 스펙 | 태스크 |
|---|---|
| §1.3 배포 URL 교체 | **계획 2 (P11)** — 인증 완성 후 하는 것이 맞다 |
| §3.1 비밀 위치 | Task 3 |
| §3.2 서명 토큰 | Task 3 |
| §3.3 2단계 로그인 + 이름 없는 토큰 거부 | Task 4 |
| §3.4 권한 | Task 4, 9 |
| §3.5 속도 제한 | Task 4 |
| §3.6 doGet 차단 | Task 4 |
| §4.1~4.5 스키마·부속 시트 | Task 2 |
| §5 API 표면 | Task 4(login/bind/list), 7(create), 8(update), 9(delete/restore). `audit`는 계획 2 |
| §6 거리 계산 | Task 7 |
| §7.5 수정 | Task 8 |
| §7.6 삭제·복구 | Task 9 |
| §8.1 폴링 401 처리 | Task 6 |
| §8.2 동시성·UUID | Task 2, 8, 10 |
| §9.1 CSP / §9.3 문서 정리 | **계획 2 (P11)** |
| §11 테스트 | Task 1(하네스), 각 태스크, Task 10(통합) |
| §7.1 필터 / §7.2 통계 / §7.3 CSV / §7.4 인쇄 | **계획 2** |

계획 1 범위 내 미커버 항목 없음.

**2. 플레이스홀더 점검** — "TBD", "적절히 처리", "테스트 작성" 같은 표현 없음. 모든 코드 단계에 실제 코드 블록이 있다. Task 4 Step 5·6의 스텁은 의도적 임시 코드이며 Task 5·8·9에서 교체되는 지점이 명시되어 있다.

**3. 타입 일관성 점검**

- `getSheet_(name)` — Task 2에서 인자를 받게 바뀌었고, Task 5·8·9의 모든 호출이 `getSheet_(REC_SHEET)` / `getSheet_(AUDIT_SHEET)` 형태다. ✅
- `getLogs_(includeDeleted)` — Task 2 정의, Task 4의 `handleList_`가 동일 시그니처로 호출. ✅
- `writeAudit_(action, recordId, session, detail)` — Task 5 정의, Task 4(`LOGIN_FAIL`)·5·8·9 호출부 인자 순서 일치. ✅
- `findRowById_(sheet, index, id)` — Task 8 정의, Task 9 재사용. ✅
- `requireSession_` / `requireAdmin_` — Task 4 정의, Task 7·8·9 사용. ✅
- `session` 객체는 항상 `{name, role}`. `writeAudit_`가 `session.name` / `session.role`을 읽는다. ✅
- 프론트 `window.Session.token()` — Task 6 정의, `apiRequest`가 사용. ✅
- `apiRequest(body)` — Task 6에서 `method` 인자 제거, Task 8·9의 `updateLog`/`restoreLogById`가 단일 인자로 호출. ✅
- `STATUS_ACTIVE` / `STATUS_DELETED` — Task 2 정의, Task 7·8·9 사용. ✅

**발견하여 수정한 것:** Task 4의 `doPost` switch가 `handleUpdate_`/`handleRestore_`/`handleAudit_`를 호출하는데 그 시점에 함수가 없어 `ReferenceError`가 난다. Task 4 Step 5에 임시 스텁 3개를 추가하고, Task 8·9에서 교체하도록 명시했다. `handleAudit_` 스텁은 계획 2까지 남는다.
