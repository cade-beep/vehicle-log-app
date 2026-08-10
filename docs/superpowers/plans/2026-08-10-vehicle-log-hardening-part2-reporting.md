# 차량 사용일지 하드닝 — 2부: 조회·집계·내보내기·마무리 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **선행 조건:** `2026-08-10-vehicle-log-hardening-part1-security-core.md`의 Task 1~10이 전부 완료되고 QA를 통과했어야 한다. 이 계획은 인증·소프트삭제·20열 스키마가 이미 동작한다고 가정한다.

**Goal:** 잠긴 운행일지 앱에 필터·통계·CSV 내보내기·감사 로그 조회를 붙이고, CSP·인쇄·배포 URL 교체·문서 정리로 실운영 상태를 완성한다.

**Architecture:** 필터·통계·CSV는 전량 클라이언트 측이다. 목록이 이미 폴링으로 메모리에 있으므로 백엔드 변경이 없고 응답 지연도 없다. 세 기능이 같은 `filtered()` 결과를 공유하므로 화면·통계·내보낸 파일이 항상 일치한다. 감사 로그 조회만 서버 왕복이 필요하다.

**Tech Stack:** 바닐라 HTML/CSS/ES6+, Google Apps Script, Cloudflare Pages (`_headers`)

## Global Constraints

계획 1과 동일하다. 이 계획에서 특히 걸리는 것들:

- 프레임워크·번들러·npm 런타임 의존성 없음. **CSV/PDF 라이브러리를 도입하지 않는다.**
- 목표 운영비 **$0/월**. 폴링 주기 30초를 바꾸지 않는다.
- 권한 판단은 토큰의 `r` 필드에서만. `audit`은 ADMIN 전용.
- 감사 로그에 **암호·토큰을 절대 기록하지 않는다.**
- 기존 UI의 시각적 정체성·레이아웃·반응형 동작 유지. **CSS 전면 교체 금지.** 기존 규칙 수정 없이 추가만 한다.
- CSV는 UTF-8 **BOM(`\uFEFF`) 필수**. 없으면 엑셀에서 한글이 깨진다.
- **필터·통계·CSV 세 결과가 항상 일치해야 한다.** 내보낸 파일이 화면과 다르면 안 된다.
- 사용자에게 스택 트레이스를 노출하지 않는다.

---

## 파일 구조

### 신규

| 파일 | 책임 |
|---|---|
| `report.js` | 필터 상태, 필터링, 통계 집계, CSV 생성. `window.Report` 노출 |

### 수정

| 파일 | 변경 성격 |
|---|---|
| `app.js` | 렌더 시 `Report.filtered()`를 거치도록 연결. 감사 로그 화면 |
| `index.html` | 필터 바, 통계 패널, 내보내기 버튼, 감사 로그 영역 |
| `style.css` | 필터·통계·인쇄 스타일 **추가만** |
| `apps-script/Code.gs` | `handleAudit_` 실구현 (계획 1의 스텁 교체) |
| `_headers` | CSP 추가 |
| `config.js` | 새 배포 URL |
| `README.md`, `SECURITY_PLAN.md` | 실제 구현과 일치하도록 재작성 |
| `.env.example` | 삭제 |

### `report.js`를 나누는 이유

계획 1을 마친 `app.js`는 약 700줄이다. 필터·통계·CSV를 여기 넣으면 1,000줄을 넘는다. 세 기능은 **같은 필터 결과를 공유하는 하나의 책임**(조회 결과를 걸러 보여주고 내보내기)이라 함께 묶이는 것이 맞다. `app.js`는 폼·API·렌더를 계속 맡는다.

---

## Task 1: 필터

**Files:**
- Create: `report.js`
- Modify: `index.html` (필터 바, `report.js` 로드)
- Modify: `app.js` (렌더가 필터를 거치게)
- Modify: `style.css`
- Create: `tests/report.test.js`

**Interfaces:**
- Produces: `window.Report` —
  - `Report.init(onChange)` — DOM 연결, 필터 변경 시 `onChange()` 호출
  - `Report.apply(records)` → 필터를 통과한 배열
  - `Report.state()` → `{from, to, vehicleNo, driver, text}`
  - `Report.refreshDriverOptions(records)` — 기록에 등장하는 운전자로 목록 갱신
  - `Report.reset()`
  - `Report.matches(record, state)` → boolean (순수 함수, 테스트 대상)

- [ ] **Step 1: 실패하는 테스트를 먼저 쓴다**

`report.js`의 필터 판정은 순수 함수라 브라우저 없이 검증할 수 있다. `tests/report.test.js`:

```javascript
/**
 * report.js는 브라우저 전역(window, document)에 의존하지만
 * 순수 판정 함수는 따로 꺼내 검증한다.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const cases = [];
let failed = 0;
function test(name, fn) { cases.push([name, fn]); }
function assertEq(a, e, label) {
  if (String(a) !== String(e)) throw new Error(`${label}: expected ${e}, got ${a}`);
}

function loadReport() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'report.js'), 'utf8');
  const sandbox = {
    window: {}, document: { getElementById: () => null, querySelectorAll: () => [] },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'report.js' });
  return sandbox.window.Report;
}

const rec = (o) => Object.assign({
  id: 'x', date: '2026-08-15', vehicleNo: '0704', driver: '홍길동',
  destination: '광양시청', purpose: '회의 참석',
  distance: 45, fuelCost: 50000, passengerCount: 2,
  startOdometer: 12000, endOdometer: 12045, status: 'ACTIVE',
}, o);

const blank = { from: '', to: '', vehicleNo: '', driver: '', text: '' };

test('빈 필터는 전부 통과시킨다', () => {
  const R = loadReport();
  assertEq(R.matches(rec(), blank), true, '통과');
});

test('기간 필터가 경계값을 포함한다', () => {
  const R = loadReport();
  const s = Object.assign({}, blank, { from: '2026-08-15', to: '2026-08-15' });
  assertEq(R.matches(rec({ date: '2026-08-15' }), s), true, '시작=종료=당일');
  assertEq(R.matches(rec({ date: '2026-08-14' }), s), false, '하루 전');
  assertEq(R.matches(rec({ date: '2026-08-16' }), s), false, '하루 후');
});

test('시작일만 있으면 그 이후 전부', () => {
  const R = loadReport();
  const s = Object.assign({}, blank, { from: '2026-08-15' });
  assertEq(R.matches(rec({ date: '2026-12-31' }), s), true, '이후');
  assertEq(R.matches(rec({ date: '2026-08-14' }), s), false, '이전');
});

test('차량·운전자 필터는 정확히 일치할 때만', () => {
  const R = loadReport();
  assertEq(R.matches(rec(), Object.assign({}, blank, { vehicleNo: '0704' })), true, '차량 일치');
  assertEq(R.matches(rec(), Object.assign({}, blank, { vehicleNo: '8318' })), false, '차량 불일치');
  assertEq(R.matches(rec(), Object.assign({}, blank, { driver: '홍길동' })), true, '운전자 일치');
  assertEq(R.matches(rec(), Object.assign({}, blank, { driver: '김철수' })), false, '운전자 불일치');
});

test('텍스트 검색은 목적지와 운행사유를 함께 본다', () => {
  const R = loadReport();
  assertEq(R.matches(rec(), Object.assign({}, blank, { text: '광양' })), true, '목적지 부분일치');
  assertEq(R.matches(rec(), Object.assign({}, blank, { text: '회의' })), true, '사유 부분일치');
  assertEq(R.matches(rec(), Object.assign({}, blank, { text: '  광양  ' })), true, '앞뒤 공백 무시');
  assertEq(R.matches(rec(), Object.assign({}, blank, { text: 'ABC' })), false, '없는 단어');
  assertEq(R.matches(rec({ destination: 'Gwangyang' }),
    Object.assign({}, blank, { text: 'gwangYANG' })), true, '대소문자 무시');
});

test('조건이 여러 개면 전부 만족해야 한다', () => {
  const R = loadReport();
  const s = { from: '2026-08-01', to: '2026-08-31', vehicleNo: '0704', driver: '홍길동', text: '광양' };
  assertEq(R.matches(rec(), s), true, '전부 만족');
  assertEq(R.matches(rec({ vehicleNo: '8318' }), s), false, '하나라도 불일치하면 탈락');
});

test('apply가 필터를 통과한 것만 돌려준다', () => {
  const R = loadReport();
  const list = [rec({ id: 'a', vehicleNo: '0704' }), rec({ id: 'b', vehicleNo: '8318' })];
  const out = R.apply(list, Object.assign({}, blank, { vehicleNo: '8318' }));
  assertEq(out.length, 1, '1건');
  assertEq(out[0].id, 'b', 'b만 남음');
});

for (const [name, fn] of cases) {
  try { fn(); console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + '\n        ' + e.message); }
}
console.log(failed === 0 ? '\nALL REPORT TESTS PASSED' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

```bash
cd "C:/Users/김규호/vehicle-log-app"
node tests/report.test.js
```

Expected: `ENOENT ... report.js`

- [ ] **Step 3: `report.js` 작성 (필터 부분)**

```javascript
/**
 * 필터 · 통계 · CSV.
 *
 * 세 기능이 모두 같은 filtered() 결과를 쓴다. 화면에 보이는 것, 통계 숫자,
 * 내보낸 파일이 항상 같아야 하기 때문이다.
 *
 * 전량 클라이언트 처리다. 목록이 이미 폴링으로 메모리에 있어 백엔드 왕복이 없다.
 */
(function () {
  'use strict';

  var el = {};
  var onChangeCallback = null;

  function emptyState() {
    return { from: '', to: '', vehicleNo: '', driver: '', text: '' };
  }

  function state() {
    if (!el.from) return emptyState();
    return {
      from: el.from.value.trim(),
      to: el.to.value.trim(),
      vehicleNo: el.vehicle.value,
      driver: el.driver.value,
      text: el.text.value.trim(),
    };
  }

  /** 순수 함수. DOM에 의존하지 않는다. */
  function matches(record, s) {
    if (s.from && String(record.date) < s.from) return false;
    if (s.to && String(record.date) > s.to) return false;
    if (s.vehicleNo && record.vehicleNo !== s.vehicleNo) return false;
    if (s.driver && record.driver !== s.driver) return false;

    if (s.text) {
      var needle = s.text.trim().toLowerCase();
      var hay = (String(record.destination) + ' ' + String(record.purpose)).toLowerCase();
      if (hay.indexOf(needle) === -1) return false;
    }
    return true;
  }

  function apply(records, s) {
    var target = s || state();
    return records.filter(function (r) { return matches(r, target); });
  }

  /** 기록에 실제로 등장한 운전자만 목록에 넣는다. */
  function refreshDriverOptions(records) {
    if (!el.driver) return;
    var current = el.driver.value;
    var names = [];
    records.forEach(function (r) {
      if (r.driver && names.indexOf(r.driver) === -1) names.push(r.driver);
    });
    names.sort();
    el.driver.innerHTML = '<option value="">전체</option>' + names.map(function (n) {
      return '<option value="' + escapeAttr(n) + '">' + escapeText(n) + '</option>';
    }).join('');
    if (names.indexOf(current) >= 0) el.driver.value = current;
  }

  function reset() {
    if (!el.from) return;
    el.from.value = '';
    el.to.value = '';
    el.vehicle.value = '';
    el.driver.value = '';
    el.text.value = '';
    if (onChangeCallback) onChangeCallback();
  }

  function escapeText(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeAttr(s) { return escapeText(s).replace(/"/g, '&quot;'); }

  function init(onChange) {
    onChangeCallback = onChange;
    el = {
      from:    document.getElementById('filterFrom'),
      to:      document.getElementById('filterTo'),
      vehicle: document.getElementById('filterVehicle'),
      driver:  document.getElementById('filterDriver'),
      text:    document.getElementById('filterText'),
      reset:   document.getElementById('filterReset'),
    };
    if (!el.from) return;

    ['from', 'to', 'vehicle', 'driver'].forEach(function (k) {
      el[k].addEventListener('change', function () { if (onChangeCallback) onChangeCallback(); });
    });
    // 타이핑 중 매 글자마다 다시 그리면 목록이 번쩍인다.
    var timer = null;
    el.text.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () { if (onChangeCallback) onChangeCallback(); }, 200);
    });
    el.reset.addEventListener('click', reset);
  }

  /** 차량 목록은 세션에서 온다. 기록에 없는 차량도 고를 수 있어야 한다. */
  function fillVehicleFilter(vehicles) {
    if (!el.vehicle) return;
    el.vehicle.innerHTML = '<option value="">전체</option>' + vehicles.map(function (v) {
      return '<option value="' + escapeAttr(v.vehicleNo) + '">' + escapeText(v.vehicleNo) + '</option>';
    }).join('');
  }

  window.Report = {
    init: init,
    state: state,
    matches: matches,
    apply: apply,
    reset: reset,
    refreshDriverOptions: refreshDriverOptions,
    fillVehicleFilter: fillVehicleFilter,
  };
})();
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

```bash
node tests/report.test.js
```

Expected: 7개 전부 PASS, `ALL REPORT TESTS PASSED`

- [ ] **Step 5: `index.html`에 필터 바 추가**

원장 섹션의 `panel-head` 다음, `table-wrapper` 앞에 넣는다.

```html
                <div class="filter-bar">
                    <div class="filter-field">
                        <label for="filterFrom">시작일</label>
                        <input type="date" id="filterFrom">
                    </div>
                    <div class="filter-field">
                        <label for="filterTo">종료일</label>
                        <input type="date" id="filterTo">
                    </div>
                    <div class="filter-field">
                        <label for="filterVehicle">차량</label>
                        <select id="filterVehicle"><option value="">전체</option></select>
                    </div>
                    <div class="filter-field">
                        <label for="filterDriver">운전자</label>
                        <select id="filterDriver"><option value="">전체</option></select>
                    </div>
                    <div class="filter-field filter-search">
                        <label for="filterText">검색</label>
                        <input type="text" id="filterText" placeholder="목적지 · 운행사유" maxlength="50">
                    </div>
                    <button type="button" id="filterReset" class="ghost-btn">초기화</button>
                </div>
```

스크립트 태그에 `report.js`를 `app.js` **앞**으로 추가한다.

```html
    <script src="config.js"></script>
    <script src="auth.js"></script>
    <script src="report.js"></script>
    <script src="app.js"></script>
```

- [ ] **Step 6: `app.js`가 필터를 거치게 연결**

**6-a.** `renderTable`이 필터 결과를 그리게 바꾼다. 함수 맨 앞의 시그니처 계산을 필터 결과 기준으로 바꿔야 필터만 바뀌어도 다시 그려진다.

```javascript
    function renderTable() {
        const visible = window.Report.apply(records);

        // 수정 중인 기록이 목록에서 사라지면(다른 사람이 삭제) 편집을 중단한다.
        if (editingId && !records.some(r => r.id === editingId)) {
            exitEditMode();
            showAlert('수정 중이던 기록이 다른 사용자에 의해 삭제되었습니다.', 'danger');
        }

        const signature = JSON.stringify(visible);
        if (signature === lastRenderedSignature) return;
        lastRenderedSignature = signature;

        tableBody.innerHTML = '';

        if (visible.length === 0) {
            showEmptyState(records.length === 0
                ? '등록된 운행일지가 없습니다.<br>양식을 작성하여 새로 추가해 보세요.'
                : '조건에 맞는 기록이 없습니다.<br>필터를 초기화해 보세요.');
            return;
        }

        if (emptyState) emptyState.style.display = 'none';

        visible.forEach(r => {
            // ... 기존 행 생성 로직 그대로 ...
        });
```

`records.forEach(r => {` 를 `visible.forEach(r => {` 로 바꾸는 것이 핵심이다. 그 아래 행 생성 코드는 손대지 않는다.

**6-b.** `refreshLogs` 성공 후 운전자 목록을 갱신한다. `renderTable();` 앞에 넣는다.

```javascript
            records = logs;
            window.Report.refreshDriverOptions(logs);
            renderTable();
```

**6-c.** 세션 준비 시 필터를 초기화한다. `window.Session.start` 콜백에 추가한다.

```javascript
        window.Report.init(function onFilterChange() {
            lastRenderedSignature = null;   // 필터가 바뀌면 반드시 다시 그린다
            renderTable();
        });
        window.Report.fillVehicleFilter(window.Session.vehicles());
```

**6-d.** 수정/삭제 리스너가 `records`에서 찾는 부분은 그대로 둔다. `visible`은 `records`의 부분집합이라 `records.find`로 항상 찾을 수 있다.

- [ ] **Step 7: `style.css`에 추가**

```css
/* ── 필터 ───────────────────────────────────────────────────── */
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
  padding: 12px 0 16px;
}
.filter-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.filter-field label {
  font-size: 12px;
  margin: 0;
}
.filter-field input,
.filter-field select {
  padding: 8px 10px;
  font-size: 15px;
  border: 1px solid var(--line, #dfe3e8);
  border-radius: 7px;
  font-family: inherit;
}
.filter-search { flex: 1 1 160px; }
.filter-bar .ghost-btn { align-self: flex-end; padding: 9px 14px; }

@media (max-width: 640px) {
  .filter-field { flex: 1 1 calc(50% - 5px); }
  .filter-search { flex: 1 1 100%; }
  .filter-bar .ghost-btn { flex: 1 1 100%; }
}
```

- [ ] **Step 8: 정적 검사와 수동 확인**

```bash
node --check report.js && node --check app.js && node tests/report.test.js && node tests/run.js
```

배포 갱신 후 확인:
1. 기간을 지정하면 그 범위만 남는다. 시작일=종료일이면 그날 기록만
2. 차량 선택 → 해당 차량만
3. 운전자 목록이 실제 기록에 등장한 이름으로 채워진다
4. 검색어를 타이핑해도 목록이 번쩍이지 않는다 (200ms 지연)
5. 「초기화」 → 전부 해제되고 전체 목록 복귀
6. 필터를 걸어둔 채 30초 폴링이 돌아도 필터가 유지된다
7. 폰 세로 화면에서 필터 필드가 2열로 접히고 가로 스크롤이 없다

- [ ] **Step 9: 커밋**

```bash
git add report.js index.html app.js style.css tests/report.test.js
git commit -m "feat(filter): client-side date/vehicle/driver/text filtering

목록이 이미 메모리에 있어 백엔드 왕복이 없다. 판정 함수는 DOM에 의존하지 않는
순수 함수라 브라우저 없이 검증한다.

검색어는 200ms 디바운스한다. 매 글자마다 다시 그리면 목록이 번쩍인다."
```

---

## Task 2: 통계

**Files:**
- Modify: `report.js` (`summarize` 추가)
- Modify: `index.html` (통계 패널)
- Modify: `app.js` (렌더 시 통계 갱신)
- Modify: `style.css`
- Modify: `tests/report.test.js`

**Interfaces:**
- Consumes: Task 1의 `Report.apply(records, state)`
- Produces: `Report.summarize(records)` →
  ```
  { count, totalDistance, totalFuelCost,
    byVehicle: [{vehicleNo, distance, fuelCost, count}],   // 거리 내림차순
    byDriver:  [{driver, distance, count}] }               // 거리 내림차순
  ```

- [ ] **Step 1: 실패하는 테스트를 먼저 쓴다**

`tests/report.test.js`의 마지막 `for` 루프 **앞**에 추가한다.

```javascript
test('통계가 건수·거리·주유비를 합산한다', () => {
  const R = loadReport();
  const s = R.summarize([
    rec({ vehicleNo: '0704', driver: '홍길동', distance: 45, fuelCost: 50000 }),
    rec({ vehicleNo: '0704', driver: '김철수', distance: 30, fuelCost: '' }),
    rec({ vehicleNo: '8318', driver: '홍길동', distance: 25, fuelCost: 20000 }),
  ]);
  assertEq(s.count, 3, '건수');
  assertEq(s.totalDistance, 100, '총 거리');
  assertEq(s.totalFuelCost, 70000, '총 주유비 — 공란은 0으로');
});

test('차량별 집계가 거리 내림차순으로 나온다', () => {
  const R = loadReport();
  const s = R.summarize([
    rec({ vehicleNo: '8318', distance: 25, fuelCost: 20000 }),
    rec({ vehicleNo: '0704', distance: 45, fuelCost: 50000 }),
    rec({ vehicleNo: '0704', distance: 30, fuelCost: '' }),
  ]);
  assertEq(s.byVehicle.length, 2, '차량 2대');
  assertEq(s.byVehicle[0].vehicleNo, '0704', '거리 많은 차량이 먼저');
  assertEq(s.byVehicle[0].distance, 75, '0704 합계');
  assertEq(s.byVehicle[0].count, 2, '0704 건수');
  assertEq(s.byVehicle[0].fuelCost, 50000, '0704 주유비');
  assertEq(s.byVehicle[1].distance, 25, '8318 합계');
});

test('운전자별 집계가 나온다', () => {
  const R = loadReport();
  const s = R.summarize([
    rec({ driver: '홍길동', distance: 45 }),
    rec({ driver: '김철수', distance: 30 }),
    rec({ driver: '홍길동', distance: 25 }),
  ]);
  assertEq(s.byDriver[0].driver, '홍길동', '거리 많은 운전자 먼저');
  assertEq(s.byDriver[0].distance, 70, '홍길동 합계');
  assertEq(s.byDriver[0].count, 2, '홍길동 건수');
});

test('빈 목록의 통계가 0이고 터지지 않는다', () => {
  const R = loadReport();
  const s = R.summarize([]);
  assertEq(s.count, 0, '건수 0');
  assertEq(s.totalDistance, 0, '거리 0');
  assertEq(s.totalFuelCost, 0, '주유비 0');
  assertEq(s.byVehicle.length, 0, '차량 없음');
});

test('통계는 필터 결과에만 반응한다', () => {
  const R = loadReport();
  const all = [
    rec({ vehicleNo: '0704', distance: 45 }),
    rec({ vehicleNo: '8318', distance: 25 }),
  ];
  const filtered = R.apply(all, Object.assign({}, blank, { vehicleNo: '0704' }));
  assertEq(R.summarize(filtered).totalDistance, 45, '필터된 집합만 합산');
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

```bash
node tests/report.test.js
```

Expected: `R.summarize is not a function`

- [ ] **Step 3: `report.js`에 `summarize` 추가**

`escapeText` 함수 **앞**에 넣고, 맨 아래 `window.Report` 객체에 `summarize: summarize,`를 추가한다.

```javascript
  function toNumber(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  /** 넘겨받은 배열만 집계한다. 필터링은 호출자 책임이다. */
  function summarize(records) {
    var out = {
      count: records.length,
      totalDistance: 0,
      totalFuelCost: 0,
      byVehicle: [],
      byDriver: [],
    };

    var vehicles = {};
    var drivers = {};

    records.forEach(function (r) {
      var d = toNumber(r.distance);
      var f = toNumber(r.fuelCost);   // 공란은 0
      out.totalDistance += d;
      out.totalFuelCost += f;

      var vk = String(r.vehicleNo || '(미지정)');
      if (!vehicles[vk]) vehicles[vk] = { vehicleNo: vk, distance: 0, fuelCost: 0, count: 0 };
      vehicles[vk].distance += d;
      vehicles[vk].fuelCost += f;
      vehicles[vk].count += 1;

      var dk = String(r.driver || '(미지정)');
      if (!drivers[dk]) drivers[dk] = { driver: dk, distance: 0, count: 0 };
      drivers[dk].distance += d;
      drivers[dk].count += 1;
    });

    var byDistance = function (a, b) { return b.distance - a.distance; };
    out.byVehicle = Object.keys(vehicles).map(function (k) { return vehicles[k]; }).sort(byDistance);
    out.byDriver = Object.keys(drivers).map(function (k) { return drivers[k]; }).sort(byDistance);

    return out;
  }
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

```bash
node tests/report.test.js
```

Expected: 12개 전부 PASS

- [ ] **Step 5: `index.html`에 통계 패널 추가**

필터 바 다음, `table-wrapper` 앞에 넣는다.

```html
                <div class="stats" id="statsPanel">
                    <div class="stat-row">
                        <span class="stat"><b id="statCount">0</b> 건</span>
                        <span class="stat">총 <b id="statDistance">0</b> km</span>
                        <span class="stat">주유 <b id="statFuel">0</b> 원</span>
                    </div>
                    <details class="stat-detail">
                        <summary>차량별 · 운전자별 보기</summary>
                        <div class="stat-tables">
                            <table class="mini-table"><tbody id="statByVehicle"></tbody></table>
                            <table class="mini-table"><tbody id="statByDriver"></tbody></table>
                        </div>
                    </details>
                </div>
```

- [ ] **Step 6: `app.js`에 통계 렌더 연결**

**6-a.** DOM 참조를 추가한다.

```javascript
    const statCount = document.getElementById('statCount');
    const statDistance = document.getElementById('statDistance');
    const statFuel = document.getElementById('statFuel');
    const statByVehicle = document.getElementById('statByVehicle');
    const statByDriver = document.getElementById('statByDriver');
```

**6-b.** 통계 렌더 함수를 추가한다.

```javascript
    function renderStats(visible) {
        const s = window.Report.summarize(visible);
        statCount.textContent = s.count.toLocaleString();
        statDistance.textContent = s.totalDistance.toLocaleString();
        statFuel.textContent = s.totalFuelCost.toLocaleString();

        statByVehicle.innerHTML = s.byVehicle.length
            ? s.byVehicle.map(v => `<tr>
                <th scope="row">${escapeHTML(v.vehicleNo)}</th>
                <td>${v.count}건</td>
                <td>${v.distance.toLocaleString()}km</td>
                <td>${v.fuelCost.toLocaleString()}원</td></tr>`).join('')
            : '<tr><td>기록 없음</td></tr>';

        statByDriver.innerHTML = s.byDriver.length
            ? s.byDriver.map(d => `<tr>
                <th scope="row">${escapeHTML(d.driver)}</th>
                <td>${d.count}건</td>
                <td>${d.distance.toLocaleString()}km</td></tr>`).join('')
            : '<tr><td>기록 없음</td></tr>';
    }
```

**6-c.** `renderTable` 안에서 부른다. 조기 반환보다 **앞**에 둬야 필터만 바뀌어도 통계가 갱신된다.

```javascript
    function renderTable() {
        const visible = window.Report.apply(records);
        renderStats(visible);          // 시그니처 비교보다 먼저

        if (editingId && !records.some(r => r.id === editingId)) { /* ... */ }

        const signature = JSON.stringify(visible);
        if (signature === lastRenderedSignature) return;
        // ...
```

- [ ] **Step 7: `style.css`에 추가**

```css
/* ── 통계 ───────────────────────────────────────────────────── */
.stats {
  border-top: 1px solid var(--line, #dfe3e8);
  border-bottom: 1px solid var(--line, #dfe3e8);
  padding: 12px 0;
  margin-bottom: 12px;
}
.stat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  font-size: 14px;
}
.stat b { font-variant-numeric: tabular-nums; font-size: 16px; }
.stat-detail { margin-top: 10px; }
.stat-detail summary {
  font-size: 13px;
  cursor: pointer;
  color: var(--muted, #6b7280);
}
.stat-tables {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
  margin-top: 10px;
}
.mini-table {
  border-collapse: collapse;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.mini-table th,
.mini-table td { padding: 4px 10px 4px 0; text-align: left; font-weight: 400; }
.mini-table th { font-weight: 600; }
```

- [ ] **Step 8: 정적 검사와 수동 확인**

```bash
node --check report.js && node --check app.js && node tests/report.test.js
```

배포 갱신 후 확인:
1. 상단에 건수·총 거리·총 주유비가 뜬다
2. 필터를 걸면 **숫자가 즉시 필터 결과로 바뀐다**
3. 「차량별 · 운전자별 보기」를 펼치면 표 두 개가 나온다
4. 주유금액이 비어 있는 기록이 있어도 합계가 `NaN`이 되지 않는다
5. 손으로 계산한 값과 일치한다 (기록 3~4건으로 확인)

- [ ] **Step 9: 커밋**

```bash
git add report.js index.html app.js style.css tests/report.test.js
git commit -m "feat(stats): filter-aware totals and per-vehicle/driver breakdown

통계를 시그니처 비교보다 먼저 갱신한다. 뒤에 두면 필터만 바뀌고 목록 내용이
같을 때 숫자가 안 바뀐다.

주유금액 공란은 0으로 더한다. Number('')는 0이지만 undefined는 NaN이라
toNumber로 한 번 거른다."
```

---

## Task 3: CSV 내보내기

**Files:**
- Modify: `report.js` (`buildCsv`, `download`)
- Modify: `index.html` (내보내기 버튼)
- Modify: `app.js` (버튼 연결)
- Modify: `tests/report.test.js`

**Interfaces:**
- Consumes: Task 1의 `Report.apply`, `Report.state`
- Produces:
  - `Report.buildCsv(records)` → CSV 문자열 (**BOM 포함**)
  - `Report.csvFileName(state, records)` → `운행일지_YYYYMMDD-YYYYMMDD.csv`
  - `Report.download(filename, text)` — Blob 다운로드

- [ ] **Step 1: 실패하는 테스트를 먼저 쓴다**

```javascript
test('CSV가 BOM으로 시작한다', () => {
  const R = loadReport();
  const csv = R.buildCsv([rec()]);
  assertEq(csv.charCodeAt(0), 0xFEFF, 'BOM');
});

test('CSV 헤더와 행 순서가 맞는다', () => {
  const R = loadReport();
  const lines = R.buildCsv([rec()]).replace(/^\uFEFF/, '').trim().split('\r\n');
  assertEq(lines.length, 2, '헤더 + 1행');
  assertEq(lines[0].split(',')[0], '운행일', '첫 열');
  assertEq(lines[1].split(',')[0], '2026-08-15', '첫 값');
});

test('쉼표·따옴표·줄바꿈이 RFC4180으로 이스케이프된다', () => {
  const R = loadReport();
  const csv = R.buildCsv([rec({
    destination: '광양, 여수', purpose: '그가 "말했다"', driver: '홍\n길동',
  })]).replace(/^\uFEFF/, '');
  if (csv.indexOf('"광양, 여수"') === -1) throw new Error('쉼표 미처리: ' + csv);
  if (csv.indexOf('"그가 ""말했다"""') === -1) throw new Error('따옴표 미처리: ' + csv);
  if (csv.indexOf('"홍\n길동"') === -1) throw new Error('줄바꿈 미처리: ' + csv);
});

test('숫자 열은 따옴표 없이 숫자로 남는다', () => {
  const R = loadReport();
  const line = R.buildCsv([rec({ distance: 45, fuelCost: 50000, passengerCount: 2 })])
    .replace(/^\uFEFF/, '').trim().split('\r\n')[1];
  if (line.indexOf('"45"') >= 0) throw new Error('거리가 따옴표로 감싸짐');
  if (line.indexOf('"50000"') >= 0) throw new Error('주유비가 따옴표로 감싸짐');
  if (line.indexOf(',45,') === -1) throw new Error('거리 45가 숫자로 없음: ' + line);
});

test('한글이 보존된다', () => {
  const R = loadReport();
  const csv = R.buildCsv([rec({ destination: '광양시청', driver: '홍길동' })]);
  if (csv.indexOf('광양시청') === -1) throw new Error('목적지 한글 손실');
  if (csv.indexOf('홍길동') === -1) throw new Error('운전자 한글 손실');
});

test('주유금액 공란은 빈 칸으로 나간다', () => {
  const R = loadReport();
  const line = R.buildCsv([rec({ fuelCost: '' })])
    .replace(/^\uFEFF/, '').trim().split('\r\n')[1];
  if (line.indexOf(',0,') >= 0 || /,0$/.test(line)) {
    throw new Error('공란이 0으로 바뀜: ' + line);
  }
});

test('파일명에 필터 기간이 반영된다', () => {
  const R = loadReport();
  const s = Object.assign({}, blank, { from: '2026-08-01', to: '2026-08-31' });
  assertEq(R.csvFileName(s, []), '운행일지_20260801-20260831.csv', '기간 지정');
});

test('기간을 안 정하면 기록의 실제 범위를 쓴다', () => {
  const R = loadReport();
  const list = [rec({ date: '2026-08-05' }), rec({ date: '2026-08-20' })];
  assertEq(R.csvFileName(blank, list), '운행일지_20260805-20260820.csv', '자동 범위');
});

test('기록이 없으면 파일명이 전체가 된다', () => {
  const R = loadReport();
  assertEq(R.csvFileName(blank, []), '운행일지_전체.csv', '빈 목록');
});

test('CSV가 넘겨받은 배열만 담는다 (필터 일치)', () => {
  const R = loadReport();
  const all = [rec({ id: 'a', vehicleNo: '0704' }), rec({ id: 'b', vehicleNo: '8318' })];
  const filtered = R.apply(all, Object.assign({}, blank, { vehicleNo: '8318' }));
  const lines = R.buildCsv(filtered).replace(/^\uFEFF/, '').trim().split('\r\n');
  assertEq(lines.length, 2, '헤더 + 1행만');
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

```bash
node tests/report.test.js
```

Expected: `R.buildCsv is not a function`

- [ ] **Step 3: `report.js`에 CSV 생성 추가**

`summarize` 다음에 넣고, `window.Report`에 `buildCsv`, `csvFileName`, `download`를 추가한다.

```javascript
  var CSV_COLUMNS = [
    { header: '운행일',        key: 'date',           numeric: false },
    { header: '출발시간',      key: 'departTime',     numeric: false },
    { header: '도착시간',      key: 'arriveTime',     numeric: false },
    { header: '차량번호',      key: 'vehicleNo',      numeric: false },
    { header: '운전자',        key: 'driver',         numeric: false },
    { header: '출발계기판(km)', key: 'startOdometer', numeric: true  },
    { header: '도착계기판(km)', key: 'endOdometer',   numeric: true  },
    { header: '운행거리(km)',  key: 'distance',       numeric: true  },
    { header: '목적지',        key: 'destination',    numeric: false },
    { header: '운행사유',      key: 'purpose',        numeric: false },
    { header: '인원',          key: 'passengerCount', numeric: true  },
    { header: '주유금액',      key: 'fuelCost',       numeric: true  },
    { header: '작성자',        key: 'createdBy',      numeric: false },
    { header: '작성시각',      key: 'createdAt',      numeric: false },
  ];

  /**
   * RFC4180. 쉼표·따옴표·줄바꿈이 있으면 따옴표로 감싸고 내부 따옴표는 두 번.
   * 숫자 열은 감싸지 않는다 — 엑셀이 문자열로 인식하면 합계를 못 낸다.
   */
  function csvCell(value, numeric) {
    if (value === null || value === undefined || value === '') return '';
    if (numeric) {
      var n = Number(value);
      return isFinite(n) ? String(n) : '';
    }
    var s = String(value);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function buildCsv(records) {
    var rows = [CSV_COLUMNS.map(function (c) { return csvCell(c.header, false); }).join(',')];
    records.forEach(function (r) {
      rows.push(CSV_COLUMNS.map(function (c) {
        return csvCell(r[c.key], c.numeric);
      }).join(','));
    });
    // BOM이 없으면 엑셀이 UTF-8을 못 알아보고 한글이 깨진다.
    return '\uFEFF' + rows.join('\r\n') + '\r\n';
  }

  function compactDate(d) { return String(d).replace(/-/g, ''); }

  function csvFileName(s, records) {
    var from = s.from;
    var to = s.to;
    if (!from || !to) {
      var dates = records.map(function (r) { return String(r.date); })
        .filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); }).sort();
      if (dates.length === 0) return '운행일지_전체.csv';
      from = from || dates[0];
      to = to || dates[dates.length - 1];
    }
    return '운행일지_' + compactDate(from) + '-' + compactDate(to) + '.csv';
  }

  /** 정적 사이트라 Blob 다운로드가 그대로 된다 (샌드박스 iframe이 아니다). */
  function download(filename, text) {
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

```bash
node tests/report.test.js
```

Expected: 22개 전부 PASS

- [ ] **Step 5: `index.html`에 내보내기 버튼 추가**

필터 바의 「초기화」 버튼 다음에 넣는다.

```html
                    <button type="button" id="exportCsv" class="ghost-btn">CSV 내보내기</button>
                    <button type="button" id="printLedger" class="ghost-btn">인쇄</button>
```

- [ ] **Step 6: `app.js`에 버튼 연결**

`window.Session.start` 콜백 안, `Report.init` 다음에 넣는다.

```javascript
        document.getElementById('exportCsv').addEventListener('click', () => {
            const visible = window.Report.apply(records);
            if (visible.length === 0) {
                showAlert('내보낼 기록이 없습니다.', 'danger');
                return;
            }
            window.Report.download(
                window.Report.csvFileName(window.Report.state(), visible),
                window.Report.buildCsv(visible)
            );
        });

        document.getElementById('printLedger').addEventListener('click', () => {
            window.print();
        });
```

- [ ] **Step 7: 정적 검사와 수동 확인**

```bash
node --check report.js && node --check app.js && node tests/report.test.js
```

배포 갱신 후 확인:
1. 「CSV 내보내기」 → 파일이 받아진다
2. **엑셀에서 열어 한글이 깨지지 않는다** (가장 중요)
3. 운행거리·주유금액 열을 엑셀에서 선택하면 **하단에 합계가 뜬다** (숫자로 인식됨)
4. 필터를 걸고 내보내면 **화면에 보이는 건수와 파일 행 수가 같다**
5. 파일명에 필터 기간이 반영된다
6. 목적지에 쉼표(`광양, 여수`)를 넣은 기록이 엑셀에서 한 칸에 들어간다
7. 주유금액을 비운 기록의 해당 칸이 **0이 아니라 빈 칸**이다
8. 기록이 0건일 때 → "내보낼 기록이 없습니다" 안내

- [ ] **Step 8: 커밋**

```bash
git add report.js index.html app.js tests/report.test.js
git commit -m "feat(export): filtered CSV with BOM and RFC4180 escaping

화면에 보이는 것과 파일이 항상 같다 — 둘 다 Report.apply 결과를 쓴다.

숫자 열은 따옴표로 감싸지 않는다. 엑셀이 문자열로 인식하면 합계를 못 낸다.
주유금액 공란은 0이 아니라 빈 칸으로 내보낸다."
```

---

## Task 4: 감사 로그 조회 (관리자)

**Files:**
- Modify: `apps-script/Code.gs` (`handleAudit_` 실구현 — 계획 1의 스텁 교체)
- Modify: `index.html` (감사 로그 영역)
- Modify: `app.js` (조회·렌더)
- Modify: `style.css`
- Modify: `tests/run.js`

**Interfaces:**
- Consumes: 계획 1의 `requireAdmin_`, `getSheet_(AUDIT_SHEET)`
- Produces: `handleAudit_(payload)` — `{token, limit?}` → `{data: [{시각, 동작, 기록ID, 사용자, 권한, 상세}]}`. 최신순, 기본 200건

- [ ] **Step 1: 실패하는 테스트를 먼저 쓴다**

`tests/run.js`의 마지막 `runAll()` 호출 **앞**에 추가한다.

```javascript
test('USER는 감사 로그를 볼 수 없다', () => {
  const app = authed();
  const token = boundSession(app, '홍길동');
  assertError(app.call({ action: 'audit', token: token }), 'FORBIDDEN', 'USER 조회');
});

test('ADMIN은 감사 로그를 최신순으로 받는다', () => {
  const app = authed();
  const userToken = boundSession(app, '홍길동');
  const rec = createOne(app, userToken);
  app.call({ action: 'delete', token: userToken, id: rec.id });

  const admin = adminToken(app, '관리자');
  const res = app.call({ action: 'audit', token: admin });
  assertEq(res.success, true, '조회 성공');
  if (res.data.length < 2) throw new Error('CREATE/DELETE가 안 보임');
  assertEq(res.data[0].동작, 'DELETE', '최신이 먼저');
  assertEq(res.data[1].동작, 'CREATE', '그다음');
});

test('감사 로그 limit이 동작한다', () => {
  const app = authed();
  const userToken = boundSession(app, '홍길동');
  for (let i = 0; i < 5; i++) {
    createOne(app, userToken, { startOdometer: i * 100, endOdometer: i * 100 + 10 });
  }
  const admin = adminToken(app, '관리자');
  assertEq(app.call({ action: 'audit', token: admin, limit: 2 }).data.length, 2, 'limit 2');
});

test('감사 로그 응답에 토큰·암호가 없다', () => {
  const app = authed();
  const userToken = boundSession(app, '홍길동');
  createOne(app, userToken);
  app.call({ action: 'login', passcode: 'wrong-secret-xyz' });

  const admin = adminToken(app, '관리자');
  const dump = JSON.stringify(app.call({ action: 'audit', token: admin }));
  for (const leak of ['wrong-secret-xyz', 'staff-pw-1234', admin.slice(0, 20)]) {
    if (dump.indexOf(leak) >= 0) throw new Error('감사 응답에 비밀 노출: ' + leak);
  }
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

```bash
node tests/run.js
```

Expected: `조회 성공: 성공 응답이 왔음` 실패 — 스텁이 "준비 중입니다"를 반환하므로.

- [ ] **Step 3: `handleAudit_` 실구현**

계획 1 Task 4에서 넣은 `handleAudit_` 스텁을 `Code.gs`에서 지우고, `Audit.gs` 맨 끝에 아래를 추가한다.

```javascript
const AUDIT_DEFAULT_LIMIT = 200;
const AUDIT_MAX_LIMIT = 1000;

/** ADMIN 전용. 최신순으로 최대 limit건. */
function handleAudit_(payload) {
  requireAdmin_(payload);

  var limit = Number(payload.limit);
  if (!isFinite(limit) || limit < 1) limit = AUDIT_DEFAULT_LIMIT;
  limit = Math.min(Math.floor(limit), AUDIT_MAX_LIMIT);

  var sheet = getSheet_(AUDIT_SHEET);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return jsonResponse_({ success: true, data: [], count: 0 });

  // 뒤에서부터 limit건만 읽는다. 전량을 읽으면 로그가 쌓일수록 느려진다.
  var take = Math.min(limit, lastRow - 1);
  var startRow = lastRow - take + 1;
  var values = sheet.getRange(startRow, 1, take, 6).getValues();

  var rows = values.map(function (r) {
    return {
      시각:   String(r[0]),
      동작:   String(r[1]),
      기록ID: String(r[2]),
      사용자: String(r[3]),
      권한:   String(r[4]),
      상세:   String(r[5]),
    };
  }).reverse();   // 최신이 앞

  return jsonResponse_({ success: true, data: rows, count: rows.length });
}
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

```bash
node tests/run.js
```

Expected: 신규 4개 포함 전부 PASS

- [ ] **Step 5: `index.html`에 감사 로그 영역 추가**

`</main>` 바로 앞에 넣는다.

```html
            <section class="ledger hidden" id="auditSection" aria-labelledby="auditTitle">
                <div class="panel-head">
                    <h2 class="panel-title" id="auditTitle">감사 로그</h2>
                    <button type="button" id="auditRefresh" class="ghost-btn">불러오기</button>
                </div>
                <div class="table-wrapper">
                    <table class="log-table audit-table">
                        <thead>
                            <tr>
                                <th scope="col">시각</th>
                                <th scope="col">동작</th>
                                <th scope="col">사용자</th>
                                <th scope="col">권한</th>
                                <th scope="col">상세</th>
                            </tr>
                        </thead>
                        <tbody id="auditTableBody"></tbody>
                    </table>
                    <p id="auditEmpty" class="empty-state">「불러오기」를 눌러 조회하세요.</p>
                </div>
            </section>
```

- [ ] **Step 6: `app.js`에 조회·렌더 추가**

`window.Session.start` 콜백의 `isAdmin()` 블록 안에 넣는다.

```javascript
        if (window.Session.isAdmin()) {
            showDeletedWrap.classList.remove('hidden');
            showDeletedCheckbox.addEventListener('change', () => {
                includeDeleted = showDeletedCheckbox.checked;
                lastRenderedSignature = null;
                refreshLogs({ showLoading: true });
            });

            const auditSection = document.getElementById('auditSection');
            const auditBody = document.getElementById('auditTableBody');
            const auditEmpty = document.getElementById('auditEmpty');
            const auditRefresh = document.getElementById('auditRefresh');
            auditSection.classList.remove('hidden');

            auditRefresh.addEventListener('click', async () => {
                auditRefresh.disabled = true;
                auditRefresh.textContent = '불러오는 중...';
                try {
                    const result = await apiRequest({ action: 'audit', limit: 200 });
                    const rows = Array.isArray(result.data) ? result.data : [];
                    if (rows.length === 0) {
                        auditBody.innerHTML = '';
                        auditEmpty.style.display = 'block';
                        auditEmpty.textContent = '감사 로그가 비어 있습니다.';
                        return;
                    }
                    auditEmpty.style.display = 'none';
                    auditBody.innerHTML = rows.map(r => `<tr>
                        <td data-label="시각">${escapeHTML(r['시각'])}</td>
                        <td data-label="동작"><strong>${escapeHTML(r['동작'])}</strong></td>
                        <td data-label="사용자">${escapeHTML(r['사용자'])}</td>
                        <td data-label="권한">${escapeHTML(r['권한'])}</td>
                        <td data-label="상세">${escapeHTML(r['상세'])}</td>
                    </tr>`).join('');
                } catch (err) {
                    console.error('Failed to load audit log', err);
                    auditBody.innerHTML = '';
                    auditEmpty.style.display = 'block';
                    auditEmpty.textContent = '감사 로그를 불러오지 못했습니다. ' + err.message;
                } finally {
                    auditRefresh.disabled = false;
                    auditRefresh.textContent = '불러오기';
                }
            });
        }
```

감사 로그는 **폴링하지 않는다.** 30초마다 자동으로 불러오면 Apps Script 쿼터만 소모한다. 관리자가 필요할 때 버튼을 누른다.

- [ ] **Step 7: `style.css`에 추가**

```css
.audit-table { font-size: 13px; }
.audit-table td { font-variant-numeric: tabular-nums; }
#auditSection { margin-top: 32px; }
```

- [ ] **Step 8: 정적 검사와 수동 확인**

```bash
node --check app.js && node tests/run.js
```

배포 갱신 후 확인:
1. 일반 계정 → 감사 로그 섹션이 **보이지 않는다**
2. 관리자 계정 → 섹션이 보이고 「불러오기」로 조회된다
3. 저장·수정·삭제·복구를 한 뒤 다시 불러오면 최신 항목이 **맨 위**에 있다
4. 틀린 암호로 로그인 시도 후 조회 → `LOGIN_FAIL`이 보이고 **암호 문자열은 없다**
5. 일반 계정으로 콘솔에서 `audit` 직접 호출 → `FORBIDDEN`
6. 감사 로그가 30초마다 자동 갱신되지 **않는다** (네트워크 탭에서 확인)

- [ ] **Step 9: 커밋**

```bash
git add apps-script/Code.gs apps-script/Audit.gs index.html app.js style.css tests/run.js
git commit -m "feat(audit): admin-only audit log viewer

시트를 뒤에서부터 limit건만 읽는다. 전량을 읽으면 로그가 쌓일수록 느려진다.

폴링하지 않는다 — 30초마다 자동 조회하면 Apps Script 쿼터만 소모한다."
```

---

## Task 5: 인쇄, CSP, 배포 URL 교체

**Files:**
- Modify: `style.css` (`@media print`)
- Modify: `_headers` (CSP)
- Modify: `config.js` (새 배포 URL)

**Interfaces:** 없음 (설정·스타일만)

- [ ] **Step 1: 인쇄 스타일 추가**

**PDF 라이브러리를 도입하지 않는다.** 공식 제출 양식이 없고 사내 관리용이므로 브라우저 인쇄로 충분하다. `style.css` 맨 끝에 붙인다.

```css
/* ── 인쇄 ───────────────────────────────────────────────────── */
@media print {
  .slip,
  .filter-bar,
  .session-bar,
  .login-screen,
  #auditSection,
  .col-actions,
  .stat-detail,
  .last-updated { display: none !important; }

  body { background: #fff; }
  .app { max-width: none; padding: 0; }
  .ledger { border: 0; }

  .stats {
    border: 0;
    border-bottom: 1px solid #000;
    padding: 0 0 8px;
  }

  .table-wrapper { overflow: visible; }
  .log-table {
    width: 100%;
    font-size: 11px;
    border-collapse: collapse;
  }
  .log-table th,
  .log-table td {
    border: 1px solid #999;
    padding: 4px 6px;
    color: #000;
  }
  .log-table thead { display: table-header-group; }   /* 페이지마다 헤더 반복 */
  .log-table tr { page-break-inside: avoid; }

  .row-deleted { opacity: 1; }
  .row-deleted td { text-decoration: line-through; }

  a[href]::after { content: ''; }   /* URL 꼬리표 제거 */
}
```

- [ ] **Step 2: 인쇄 확인**

브라우저에서 「인쇄」 버튼 또는 Ctrl+P.

1. 입력 폼·필터·로그아웃 버튼·감사 로그가 **보이지 않는다**
2. 통계 요약과 운행 기록 표만 나온다
3. 표에 테두리가 있고 여러 페이지면 **각 페이지에 헤더가 반복**된다
4. 필터를 걸면 인쇄 미리보기도 필터 결과만 나온다

- [ ] **Step 3: `_headers`에 CSP 추가**

기존 4개 헤더는 그대로 두고 한 줄을 덧붙인다. **들여쓰기 2칸을 지켜야 Cloudflare가 파싱한다.**

```
/*
  Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net; connect-src https://script.google.com https://script.googleusercontent.com; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

`script.googleusercontent.com`이 **반드시** 있어야 한다. Apps Script `/exec`는 실제 응답을 이 도메인으로 리다이렉트하므로 빠뜨리면 모든 요청이 CSP에 막힌다.

`form-action 'none'`은 폼이 전부 `preventDefault`로 처리되므로 안전하다.

- [ ] **Step 4: CSP 확인**

Cloudflare Pages에 배포한 뒤 브라우저 개발자 도구 **Console** 탭을 열고:

1. 로그인 → 저장 → 목록 조회를 한 바퀴 돈다
2. **CSP 위반 오류가 하나도 없어야 한다**
3. Network 탭에서 Pretendard 폰트 CSS가 정상 로드되는지 확인
4. `Refused to connect` 오류가 뜨면 `connect-src`에 실제 리다이렉트 도메인을 추가한다 (오류 메시지에 도메인이 찍힌다)

로컬 파일(`file://`)로 열면 `_headers`가 적용되지 않는다. **반드시 Pages 배포본에서 확인한다.**

- [ ] **Step 5: 새 배포 URL 발급과 교체**

기존 `/exec` URL은 공개 git 히스토리(커밋 `785fa5b`)에 남아 있어 회수할 수 없다. 인증이 붙은 지금은 URL 노출이 치명적이지 않지만, 쿼터 낭비 방지를 위해 교체한다.

1. Apps Script 편집기 → **배포 → 새 배포** → 유형 「웹 앱」
   - 설명: `v2-authenticated`
   - 실행 주체: **나**
   - 액세스 권한: **모든 사용자**
   - 배포 → 새 URL 복사
2. `config.js`의 `APPS_SCRIPT_URL`을 새 URL로 바꾼다
3. **배포 → 배포 관리 → 기존 v1 배포 → 보관처리(archive)** — 옛 URL을 죽인다
4. Cloudflare Pages에 배포하고 앱이 정상 동작하는지 확인
5. 브라우저에서 **옛 URL**을 열어 더 이상 응답하지 않는지 확인

- [ ] **Step 6: GitHub 저장소 비공개 전환**

GitHub → Settings → 맨 아래 Danger Zone → **Change repository visibility → Private**

URL은 이미 히스토리에 있어 이것만으로 차단되지 않는다. Step 5의 URL 교체가 실질적 대책이고, 이건 심층 방어다.

- [ ] **Step 7: 커밋**

```bash
git add style.css _headers config.js
git commit -m "chore(deploy): print styles, CSP, and rotated Apps Script URL

CSP의 connect-src에 script.googleusercontent.com이 반드시 필요하다.
Apps Script /exec는 실제 응답을 이 도메인으로 리다이렉트한다.

PDF 라이브러리를 넣지 않았다. 공식 제출 양식이 없고 사내 관리용이라
@media print로 충분하다.

옛 배포 URL은 공개 히스토리에 남아 회수할 수 없으므로 새 배포로 교체하고
기존 배포를 보관처리했다."
```

---

## Task 6: 문서 정리와 최종 QA

**Files:**
- Modify: `README.md` (재작성)
- Modify: `SECURITY_PLAN.md` (재작성)
- Delete: `.env.example`
- Create: `docs/superpowers/reports/2026-08-10-final-qa.md`

- [ ] **Step 1: `.env.example` 삭제**

아무 코드도 읽지 않는 죽은 파일이다. 빌드 단계도 서버도 없는 정적 사이트라 `.env`는 동작에 관여하지 않는다. 참조하는 Firebase·Vite·Maps 키는 전부 미사용이다. **존재 자체가 "비밀 관리를 하고 있다"는 잘못된 인상을 준다.**

```bash
git rm .env.example
```

로컬 `.env`는 `.gitignore` 대상이고 사용자 소유이므로 건드리지 않는다. `.gitignore`의 `.env` 항목도 그대로 둔다.

- [ ] **Step 2: `README.md` 재작성**

전체를 아래로 교체한다. 기존 README는 없는 기능(CSV·통계·필터·자동거리계산·LocalStorage·운행구분)을 있다고 서술하고 있었다.

```markdown
# 차량 사용일지 (Vehicle Usage Log App)

사내 차량 운행 기록을 폰·PC에서 입력하고 구글 시트에 모아 관리하는 내부 업무 앱.

## 아키텍처

```
브라우저 (Cloudflare Pages · 정적 · 빌드 없음)
  │  POST, Content-Type: text/plain;charset=utf-8
  │  body: { action, token, ... }        ← 토큰은 헤더가 아닌 본문
  ▼
Apps Script /exec                        ← HMAC 서명 토큰 검증
  ▼
Google Sheets (운행일지 / 사용자 / 차량 / 감사로그)
```

토큰을 헤더가 아니라 본문에 넣는 이유: `Authorization` 헤더는 CORS preflight(`OPTIONS`)를
유발하는데 Apps Script 웹앱은 `OPTIONS`에 응답할 수 없다.

운영비 **$0/월**. 유료 서비스·외부 API·데이터베이스를 쓰지 않는다.

## 기능

- 공용 암호 로그인 + 이름 선택 (일반 / 관리자 2단계 권한)
- 운행 기록 등록 · 수정 · 소프트 삭제 · 관리자 복구
- 출발/도착 계기판 입력 → **서버가 운행거리를 계산** (클라이언트 값은 무시)
- 차량 선택 시 직전 기록의 도착 계기판 자동 채움
- 기간 · 차량 · 운전자 · 텍스트 필터
- 필터를 반영한 통계 (건수 · 총 거리 · 총 주유비 · 차량별 · 운전자별)
- 필터를 반영한 CSV 내보내기 (UTF-8 BOM, 엑셀 호환)
- 브라우저 인쇄 (전용 인쇄 스타일)
- 감사 로그 (관리자 전용 조회)

## 파일

| 파일 | 역할 |
|---|---|
| `index.html` | 화면 구조 |
| `style.css` | 스타일 (인쇄 스타일 포함) |
| `config.js` | Apps Script 웹앱 주소, 폴링 주기 |
| `auth.js` | 로그인 화면, 세션 토큰 보관 |
| `report.js` | 필터 · 통계 · CSV |
| `app.js` | 폼, API 호출, 목록 렌더 |
| `apps-script/Code.gs` | 라우팅, 시트 접근, 검증 |
| `apps-script/Auth.gs` | 암호 · 토큰 · 속도 제한 |
| `apps-script/Audit.gs` | 감사 로그 |
| `tests/` | Node 테스트 하네스 (런타임 의존성 아님) |

## 최초 설치

1. 구글 스프레드시트를 만들고 **확장 프로그램 → Apps Script**.
2. `apps-script/` 의 `Code.gs`, `Auth.gs`, `Audit.gs`를 각각 만든다.
3. `Code.gs`의 `CONFIG.SPREADSHEET_ID`에 스프레드시트 ID를 넣는다.
4. 편집기에서 `setupSheet()` 실행 → 시트 4개 생성.
5. 편집기에서 `setPasscodes('직원암호', '관리자암호')`를 한 번 실행한 뒤
   **그 호출부의 평문을 지운다.** 암호는 8자 이상, 서로 달라야 한다.
6. `사용자` 시트에 `이름 | 권한 | 사용여부`를 채운다.
7. `차량` 시트에서 차량번호를 관리한다. 소스 수정이 필요 없다.
8. 배포 → 새 배포 → 웹 앱 / 실행 주체: 나 / 액세스: 모든 사용자 → URL 복사.
9. `config.js`의 `APPS_SCRIPT_URL`에 URL을 넣고 Cloudflare Pages에 배포.

## 운영

- **암호 변경**: 편집기에서 `setPasscodes()` 재실행 후 전원에게 새 암호 전달
- **전 세션 강제 로그아웃**: 편집기에서 `revokeAllSessions()` 실행
- **사용자 추가/제거**: `사용자` 시트 편집 (`사용여부`를 FALSE로)
- **차량 추가/폐차**: `차량` 시트 편집. 과거 기록의 차량 표시는 유지된다
- **코드 수정 반영**: 배포 → 배포 관리 → 기존 배포 ✏️ → 새 버전.
  「새 배포」를 만들면 URL이 바뀌어 `config.js`도 함께 고쳐야 한다

## 테스트

```bash
node tests/run.js          # Apps Script 백엔드
node tests/report.test.js  # 필터·통계·CSV
node --check app.js && node --check auth.js && node --check report.js
```

Node는 테스트에만 쓴다. 앱 자체는 어떤 런타임 의존성도 없다.

## 알려진 한계

1. **내부자 사칭 가능.** 공용 암호 + 이름 선택 방식이라 이름이 자기 신고다.
   감사 로그는 "홍길동으로 로그인한 세션이 삭제함"까지만 답한다.
   개인 계정이 필요해지면 `사용자` 시트에 해시·솔트 열을 추가하고
   로그인 화면만 교체하면 된다.
2. **중복 저장 방지 없음.** 저장이 타임아웃된 뒤 다시 누르면 2건이 생길 수 있다.
   타임아웃 시 "목록을 확인한 뒤 다시 시도" 안내가 뜬다.
3. **폴링이 전량 조회.** 약 2,000행을 넘으면 30초마다 오가는 JSON이 부담이 된다.
   그때 서버측 기간 필터로 전환한다.
4. **속도 제한 카운터가 캐시 축출로 초기화될 수 있다.** 실패 시 500ms 지연이 1차 방어다.
5. **개별 세션 무효화 불가.** `revokeAllSessions()`로 전원 무효화만 가능하다.

## 문서

- [`SECURITY_PLAN.md`](./SECURITY_PLAN.md) — 위협 모델과 실제 대응
- [`BILLING_PLAN.md`](./BILLING_PLAN.md) — 쿼터·비용 방침
- [`docs/superpowers/specs/`](./docs/superpowers/specs/) — 설계서
```

- [ ] **Step 3: `SECURITY_PLAN.md` 재작성**

전체를 아래로 교체한다. 기존 문서는 구현되지 않은 대책(출발/도착 계기판 검증, LocalStorage 체크섬)을 완료된 것처럼 서술하고, 정작 실제 위협(무인증 공개 엔드포인트)을 다루지 않았다.

```markdown
# 보안 계획서

최종 갱신: 2026-08-10 (하드닝 완료 시점)

이 문서는 **구현된 것만** 적는다. 계획 중인 항목은 §4에 따로 둔다.

## 1. 위협 모델

내부 업무 앱이다. 지키려는 것은 사내 차량 운행 기록이고,
막으려는 상대는 **인터넷의 불특정 다수**다. 내부자 사칭은 §3에서 다룬다.

| 자산 | 위협 | 대응 |
|---|---|---|
| 운행 기록 | 무단 조회 | 토큰 없는 요청 전면 거부 |
| 운행 기록 | 무단 생성·위조 | 동일 |
| 운행 기록 | 무단 삭제 | 동일 + 소프트 삭제로 복구 가능 |
| 암호 | 소스·저장소 노출 | Script Properties에만 저장 |
| 운행거리 | 클라이언트 위조 | 서버가 항상 재계산 |

## 2. 구현된 대책

### 2.1 인증
- 공용 암호 2개(직원 / 관리자)를 **Script Properties에만** 보관.
  저장소·프론트엔드·시트 어디에도 평문이 없다.
- 암호는 사용자별 솔트 + SHA-256 10,000회 반복 해시로 저장.
- 세션은 서버에 저장하지 않는다. `{이름, 권한, 만료, 버전}`을 HMAC-SHA256으로
  서명한 자기검증 토큰(12시간)을 쓴다.
- 서명 비교는 상수시간 비교 함수를 쓴다.
- `revokeAllSessions()`로 전 세션 즉시 무효화 가능.

### 2.2 인가
- 권한은 **토큰의 서명된 필드에서만** 읽는다. 클라이언트가 보낸 값은 쓰지 않는다.
- 복구·감사 로그 조회는 ADMIN 전용. USER가 시도하면 `FORBIDDEN`.
- USER가 `includeDeleted`를 요청하면 에러 대신 조용히 무시한다.
  권한 경계를 탐색당하지 않게 하기 위함이다.
- 로그인만 마치고 이름을 고르지 않은 토큰은 `bind` 외 모든 요청에서 거부된다.

### 2.3 엔드포인트 보호
- `doGet`은 데이터를 반환하지 않는다. 조회는 인증된 `POST list`로만 가능하다.
- `action` 기본값을 제거했다. action을 빠뜨린 요청이 쓰기로 처리되지 않는다.
- 요청 본문 8KB 상한.
- 로그인 실패 시 500ms 지연 + 10분 내 10회 실패 시 10분 잠금.

### 2.4 입력 검증
- **모든 검증이 서버에서 다시 수행된다.** 프론트 검증은 왕복을 줄이는 용도다.
- 차량번호는 하드코딩 배열이 아니라 `차량` 시트로 검증한다.
- 운행거리는 클라이언트에서 받지 않는다. 서버가 `도착 - 출발`로 계산한다.
  역전·0·음수는 거부한다.
- 이름은 `사용자` 시트에 존재하는 값만 받는다.

### 2.5 XSS
- DOM에 넣는 모든 값을 `escapeHTML`로 이스케이프한다.
- CSP: `default-src 'self'`, `script-src 'self'` (인라인 스크립트 없음),
  `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`.
- 서버는 입력을 원문 그대로 저장한다. 이스케이프는 표시 시점의 책임이다.

### 2.6 동시성·무결성
- 모든 쓰기가 `LockService.tryLock(10초)` 안에서 수행된다.
- 행은 인덱스가 아니라 UUID로 찾는다.
- 수정은 단일 `setValues`. 행이 반쯤 갱신되는 상태가 없다.
- 삭제는 소프트 삭제. 물리 삭제 코드가 존재하지 않는다.

### 2.7 감사
- CREATE / UPDATE / DELETE / RESTORE / LOGIN_FAIL을 시각·사용자·권한과 함께 기록.
- 뮤테이션과 **같은 락 구간**에서 기록한다.
- **암호와 토큰은 절대 기록하지 않는다.**

### 2.8 오류 처리
- 사용자에게 스택 트레이스를 노출하지 않는다.
- 서버 오류는 일반 문구로 치환하고 상세는 Apps Script 로그에만 남긴다.

## 3. 수용한 위험

**내부자 사칭.** 공용 암호 방식이라 이름이 자기 신고다. 암호를 아는 사람은
누구의 이름으로든 로그인할 수 있다. 10명 규모 조직에서 개인 계정 관리 부담과
맞바꾼 선택이다. 감사 로그는 "그 이름으로 로그인한 세션의 행위"까지 답한다.

승격 경로: `사용자` 시트에 비밀번호해시·솔트 열을 추가하고 로그인 화면만
교체한다. 토큰·권한·감사 구조는 그대로 쓴다.

**중복 저장.** 타임아웃 후 재시도 시 2건이 생길 수 있다. 멱등성 키 대신
안내 문구로 처리했다. 실제로 잦으면 `clientRequestId` 열을 추가한다.

**속도 제한 카운터 축출.** `CacheService`가 카운터를 버릴 수 있다.
500ms 지연이 1차 방어이고 카운터는 보조다.

## 4. 미구현 (필요해지면)

- 개인별 계정 및 비밀번호
- 개별 세션 무효화
- 중복 제출 멱등성 키
- 서버측 기간 필터 (약 2,000행 도달 시)

## 5. 사고 대응

암호 유출이 의심되면:
1. 편집기에서 `setPasscodes()`로 새 암호 설정
2. `revokeAllSessions()` 실행 → 전 세션 즉시 무효화
3. `감사로그` 시트에서 유출 의심 시점 이후의 DELETE·UPDATE 확인
4. 필요 시 관리자 계정으로 삭제된 기록 복구
5. 스프레드시트 **파일 → 버전 기록**으로 시트 단위 복원 가능

## 6. 보안 문의

[`security.txt`](./security.txt) 참조.
```

- [ ] **Step 4: 최종 통합 테스트**

```bash
cd "C:/Users/김규호/vehicle-log-app"
node tests/run.js
node tests/report.test.js
node --check app.js && node --check auth.js && node --check report.js
grep -rn "ALLOWED_VEHICLES" apps-script/ app.js index.html || echo "차량 하드코딩 없음"
grep -rn "deleteRow" apps-script/ || echo "물리 삭제 없음"
grep -rn "\.env" README.md SECURITY_PLAN.md || echo "죽은 .env 참조 없음"
ls .env.example 2>/dev/null || echo ".env.example 삭제됨"
```

Expected: 두 테스트 모두 `ALL ... PASSED`, 문법 검사 통과, 네 개의 확인 문구 출력

- [ ] **Step 5: 최종 수동 QA**

배포본에서 아래를 순서대로 통과시킨다.

**보안**
1. 로그아웃 상태로 `/exec` 직접 접속 → `UNAUTHORIZED`, 데이터 없음
2. 옛 배포 URL → 응답 없음
3. 일반 계정으로 콘솔에서 `restore` / `audit` 호출 → `FORBIDDEN`
4. 토큰을 한 글자 조작 → 로그인 화면으로 돌아감
5. 틀린 암호 11회 → `RATE_LIMITED`
6. 개발자 도구 Console에 **CSP 위반 오류 없음**
7. 페이지 소스·번들 어디에도 암호가 없다 (`Ctrl+U`로 확인)

**데이터**
8. 등록 → 수정 → 삭제 → (관리자) 복구가 전부 동작
9. 삭제해도 시트 행이 남고 `상태`가 `DELETED`
10. 수정 시 행 수 불변, `작성시각` 불변, `수정시각` 갱신
11. 두 기기에서 동시 저장 → 두 건 모두 보존, ID 중복 없음
12. `distance` 위조 전송 → 서버 계산값이 저장됨

**조회·내보내기**
13. 필터 4종이 각각 동작하고 「초기화」로 해제된다
14. 통계 숫자가 필터 결과와 일치한다 (손 계산으로 검증)
15. CSV 행 수 = 화면 건수 = 통계 건수
16. CSV를 엑셀에서 열어 **한글 정상**, 숫자 열에서 **합계가 계산됨**
17. 쉼표가 든 목적지가 엑셀에서 한 칸에 들어간다
18. 인쇄 미리보기에 폼·필터·감사로그가 안 나오고 표만 나온다

**모바일 (실제 폰)**
19. 세로 화면에서 로그인 → 입력 → 저장 → 필터 → CSV가 전부 된다
20. 필터 필드가 2열로 접히고 가로 스크롤이 없다
21. 긴 목적지(30자 이상)에도 테이블이 깨지지 않는다
22. 수정/삭제 버튼을 손가락으로 정확히 누를 수 있다

**회귀**
23. 30초 폴링 동작, 백그라운드 전환 시 중단
24. 필터를 걸어둔 채 폴링이 돌아도 필터가 유지된다
25. 목적지에 `<img src=x onerror=alert(1)>` → 문자 그대로 표시, 경고창 없음
26. 네트워크 차단 후 저장 → 명확한 오류, 스택 트레이스 없음
27. 콘솔에 오류가 하나도 없다

- [ ] **Step 6: 최종 QA 보고서 작성**

`docs/superpowers/reports/2026-08-10-final-qa.md`에 스펙 §26 형식으로 쓴다. 아래 골격의 대괄호를 실제 실행 결과로 채운다.

```markdown
# 최종 QA 보고서 — 차량 사용일지 앱

## A. 최종 아키텍처
[README의 아키텍처 다이어그램과 동일. 실제 배포 URL·Pages 도메인 기재]

## B. 완료된 기능
[README §기능 목록을 실제 확인 결과와 함께 나열]

## C. 보안 상태
- 인증: 공용 암호 2개 + HMAC 서명 토큰 (12시간)
- 인가: USER / ADMIN. 권한은 서명된 토큰 필드에서만 판독
- API 보호: doGet 차단, 전 action 토큰 요구, 8KB 상한, 로그인 속도 제한
- 데이터 검증: 전 항목 서버 재검증, 차량·이름은 시트 대조, 거리는 서버 계산
- XSS: escapeHTML 전 구간 + CSP (script-src 'self', 인라인 없음)
- 비밀 관리: Script Properties 전용. 저장소·프론트·시트에 평문 없음
- 감사 로그: 5종 동작, 락 내부 기록, 암호·토큰 미기록

## D. 데이터 무결성
- ID: UUID, 불변. 행 탐색은 인덱스가 아닌 ID
- 수정: 단일 setValues in-place. createdAt/createdBy 불변
- 삭제: 소프트 삭제. 물리 삭제 코드 없음(grep으로 확인)
- 복구: ADMIN 전용, status 복원
- 동시성: 전 쓰기 LockService(10초). 락 반납 검증됨
- 마이그레이션: 추가 전용 20열. 기존 A~M열 미이동. status 공란=ACTIVE

## E. 테스트 결과
[Step 4 자동 테스트 출력과 Step 5의 27개 항목 결과를 개별로 기록]

## F. 남은 이슈
### Critical
[없으면 "없음"]

### Important
[예: 폴링 전량 조회 — 약 2,000행 도달 시 서버측 기간 필터 필요]

### Optional
- 개인별 계정 (내부자 사칭 대응)
- 중복 제출 멱등성 키
- 개별 세션 무효화

## G. 프로덕션 준비도
[READY / READY WITH MINOR ISSUES / NOT READY 중 하나와 근거]
```

- [ ] **Step 7: 커밋**

```bash
git add README.md SECURITY_PLAN.md docs/superpowers/reports/2026-08-10-final-qa.md
git rm --cached .env.example 2>/dev/null || true
git commit -m "docs: rewrite README and SECURITY_PLAN to match reality

기존 문서는 없는 기능(CSV·통계·필터·자동거리계산·LocalStorage·운행구분)을
있다고 서술하고, 실제 위협이던 무인증 공개 엔드포인트는 다루지 않았다.

.env.example을 삭제했다. 빌드 단계도 서버도 없어 아무 코드도 읽지 않으며,
존재 자체가 비밀 관리를 하고 있다는 잘못된 인상을 준다."
```

---

## 자체 검토

**1. 스펙 커버리지** — 계획 1에서 미커버로 표시된 항목 전부:

| 스펙 | 태스크 |
|---|---|
| §1.3 배포 URL 교체 · 저장소 비공개 | Task 5 Step 5·6 |
| §5 `audit` action | Task 4 |
| §7.1 필터 (기간·차량·운전자·텍스트·초기화) | Task 1 |
| §7.2 통계 (필터 반영, 차량별·운전자별) | Task 2 |
| §7.3 CSV (필터된 집합, BOM, RFC4180, 숫자 유지, 파일명) | Task 3 |
| §7.4 인쇄 (`@media print`, PDF 미도입) | Task 5 Step 1 |
| §9.1 CSP | Task 5 Step 3 |
| §9.3 문서 정리 (`README`, `SECURITY_PLAN`, `.env.example` 삭제) | Task 6 |
| §11.3 기능·회귀 테스트 | Task 6 Step 5 |
| §12 알려진 한계 문서화 | Task 6 Step 2·3 |
| §14 완료 판정 | Task 6 Step 4·5 |

스펙 전 항목이 계획 1 또는 계획 2에 배정되었다. 미커버 없음.

**2. 플레이스홀더 점검** — 코드 단계마다 실제 코드가 있다. Task 6 Step 6의 QA 보고서 골격에 대괄호가 있으나, 이는 **실행 결과를 채우는 자리**이며 어떤 값을 넣을지 각 항목에 명시했다. 구현 지시가 비어 있는 곳은 없다.

**3. 타입 일관성 점검**

- `Report.apply(records, s)` — Task 1 정의. 두 번째 인자 생략 시 `state()` 사용. Task 2·3의 호출부가 두 형태 모두 정의와 일치. ✅
- `Report.matches(record, s)` — Task 1 정의, 테스트만 직접 호출. ✅
- `Report.summarize(records)` — Task 2 정의. 반환 필드 `count`/`totalDistance`/`totalFuelCost`/`byVehicle`/`byDriver`가 Task 2 Step 6의 `renderStats`에서 쓰는 이름과 일치. ✅
- `byVehicle` 요소는 `{vehicleNo, distance, fuelCost, count}`, `byDriver`는 `{driver, distance, count}`. `renderStats`가 `v.fuelCost`는 쓰고 `d.fuelCost`는 쓰지 않는다 — 정의와 일치. ✅
- `Report.buildCsv(records)` / `csvFileName(s, records)` / `download(filename, text)` — Task 3 정의, Task 3 Step 6 호출부 인자 순서 일치. ✅
- `apiRequest(body)` — 계획 1 Task 6에서 단일 인자로 확정. Task 4의 `apiRequest({action:'audit', limit:200})` 일치. ✅
- `handleAudit_(payload)` — 계획 1 Task 4의 스텁을 Task 4 Step 3에서 교체. 스텁이 `Code.gs`에, 실구현이 `Audit.gs`에 있으므로 **스텁을 반드시 지워야 한다** — Step 3에 명시. ✅
- `requireAdmin_(payload)` — 계획 1 Task 4 정의, Task 4에서 사용. ✅
- 감사 로그 응답 키가 한글(`시각`/`동작`/`기록ID`/`사용자`/`권한`/`상세`)이고, Task 4 Step 6의 렌더가 `r['시각']` 형태로 접근. ✅

**발견하여 수정한 것:**

- Task 2 Step 6에서 `renderStats`를 `renderTable`의 시그니처 조기 반환 **뒤**에 두면, 필터만 바뀌고 목록 내용이 같을 때 통계가 갱신되지 않는다. 조기 반환보다 앞에 두도록 명시했다.
- Task 1 Step 6에서 `renderTable`의 시그니처를 `records`가 아니라 **`visible` 기준**으로 계산해야 한다. `records`로 계산하면 필터를 바꿔도 시그니처가 같아 다시 그려지지 않는다. 코드에 반영했다.
- Task 1의 필터 변경 콜백에서 `lastRenderedSignature = null`을 설정하지 않으면 첫 필터 변경이 무시될 수 있다. Step 6-c에 넣었다.
