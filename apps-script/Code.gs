/**
 * Vehicle Usage Log App - Google Apps Script backend
 *
 * Deploy as a Web App:
 *   Execute as       : Me
 *   Who has access   : Anyone
 *
 * The field keys below are the contract with app.js on vehicle-log-app.pages.dev.
 * Renaming a `key` breaks the frontend; renaming a `header` breaks the lookup in
 * getHeaderIndex_(). Change either only on both sides at once.
 *
 * IMPORTANT (CORS): Apps Script cannot set custom CORS headers and does not
 * handle OPTIONS preflight requests. The frontend therefore POSTs with
 * Content-Type 'text/plain;charset=utf-8' (a CORS "simple request", so no
 * preflight is issued). The body is still JSON and is parsed below.
 *
 * IMPORTANT (HTTP status): ContentService cannot set HTTP status codes.
 * Every response is HTTP 200. The `status` value inside the error payload is
 * informational only - clients must branch on `success`, never on res.status.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG = {
  SPREADSHEET_ID: '1NFYc8vHInTKdGPcw6r7KIwi3x-cFUwd3ihl4BlNKJ_8',
  SHEET_NAME: '운행일지',
  TIMEZONE: 'Asia/Seoul',
  MAX_PAYLOAD_BYTES: 8192,
  LOCK_TIMEOUT_MS: 10000,
};

/**
 * Must match ALLOWED_VEHICLES in app.js. The client checks this too, but a
 * client check is a convenience - this is the one that binds.
 * Adding a vehicle means editing both files.
 */
const ALLOWED_VEHICLES = ['0704', '8318', '1213', '5486'];

/**
 * Sheet columns. `key` is the field name used by app.js; `header` is what
 * facility staff see in the spreadsheet. Columns are located by header text,
 * so staff may reorder columns without breaking the API - but renaming a
 * header will.
 */
const COLUMNS = [
  { key: 'id',             header: '기록ID',      type: 'text'          },
  { key: 'date',           header: '일자',         type: 'text'          },
  { key: 'vehicleNo',      header: '차량번호',      type: 'text'          },
  { key: 'driver',         header: '운전자',        type: 'text'          },
  { key: 'departTime',     header: '출발시간',      type: 'text'          },
  { key: 'arriveTime',     header: '도착시간',      type: 'text'          },
  { key: 'odometer',       header: '계기판(km)',   type: 'number'        },
  { key: 'distance',       header: '주행거리(km)',  type: 'number'        },
  { key: 'destination',    header: '목적지',        type: 'text'          },
  { key: 'purpose',        header: '운행사유',      type: 'text'          },
  { key: 'passengerCount', header: '인원',         type: 'number'        },
  { key: 'fuelCost',       header: '주유금액',      type: 'numberOrEmpty' },
  { key: 'createdAt',      header: '작성시각',      type: 'text'          },
];

// Server-side bounds. The client has matching checks; these are the binding ones.
const LIMITS = {
  driver: 20,
  vehicleNo: 15,
  destination: 30,
  purpose: 100,
  maxOdometer: 10000000,
  maxDistance: 10000,
  maxPassengers: 100,
  maxFuelCost: 10000000,
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function doGet(e) {
  try {
    const logs = getLogs_();
    return jsonResponse_({ success: true, data: logs, count: logs.length });
  } catch (err) {
    console.error('doGet failed: ' + (err && err.stack ? err.stack : err));
    return errorResponse_(
      err.code || 'SERVER_ERROR',
      err.userMessage || '데이터를 불러오지 못했습니다.',
      500
    );
  }
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

    const action = payload.action || 'create';
    if (action === 'create') return handleCreate_(payload);
    if (action === 'delete') return handleDelete_(payload);
    return errorResponse_('UNKNOWN_ACTION', '알 수 없는 요청입니다.', 400);
  } catch (err) {
    console.error('doPost failed: ' + (err && err.stack ? err.stack : err));
    return errorResponse_(
      err.code || 'SERVER_ERROR',
      err.userMessage || '처리 중 오류가 발생했습니다.',
      500
    );
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function handleCreate_(payload) {
  const result = validateLogInput_(payload);
  if (!result.valid) {
    return errorResponse_('VALIDATION_ERROR', result.errors[0], 400);
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    return errorResponse_('BUSY', '다른 요청을 처리 중입니다. 잠시 후 다시 시도해 주세요.', 503);
  }
  try {
    const sheet = getSheet_();
    const index = getHeaderIndex_(sheet);

    const record = result.clean;
    record.id = createLogId_();
    record.createdAt = Utilities.formatDate(
      new Date(), CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX"
    );

    const width = Math.max(sheet.getLastColumn(), COLUMNS.length);
    const row = new Array(width).fill('');
    COLUMNS.forEach(function (col) {
      row[index[col.key]] = record[col.key];
    });

    /* appendRow() re-interprets everything it writes and ignores the format
       the column already carries, so vehicle '0704' landed as the number 704
       however setupSheet() had formatted that column. Formatting the exact
       target cells and then writing them is what makes text stay text.

       Doing it here rather than only in setupSheet() also means a sheet whose
       setup was never re-run still stores correctly - the guarantee stops
       depending on somebody having remembered to run a menu function.

       Formats for columns this app does not own are read back and put back
       untouched, so a column staff added beside ours keeps its own. */
    const target = sheet.getRange(sheet.getLastRow() + 1, 1, 1, width);
    const formats = target.getNumberFormats()[0];
    COLUMNS.forEach(function (col) {
      formats[index[col.key]] = formatFor_(col);
    });
    target.setNumberFormats([formats]);
    target.setValues([row]);

    return jsonResponse_({
      success: true,
      message: '운행일지가 등록되었습니다.',
      data: record,
    });
  } finally {
    lock.releaseLock();
  }
}

function handleDelete_(payload) {
  const id = payload.id ? String(payload.id).trim() : '';
  if (!id) {
    return errorResponse_('VALIDATION_ERROR', '삭제할 기록 ID가 없습니다.', 400);
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    return errorResponse_('BUSY', '다른 요청을 처리 중입니다. 잠시 후 다시 시도해 주세요.', 503);
  }
  try {
    const sheet = getSheet_();
    const index = getHeaderIndex_(sheet);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      return errorResponse_('NOT_FOUND', '해당 기록을 찾을 수 없습니다.', 404);
    }

    const ids = sheet.getRange(2, index.id + 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0]).trim() === id) {
        sheet.deleteRow(i + 2);
        return jsonResponse_({
          success: true,
          message: '운행일지가 삭제되었습니다.',
          data: { id: id },
        });
      }
    }
    return errorResponse_('NOT_FOUND', '해당 기록을 찾을 수 없습니다.', 404);
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Sheet access
// ---------------------------------------------------------------------------

function getSheet_() {
  if (!CONFIG.SPREADSHEET_ID || CONFIG.SPREADSHEET_ID === 'YOUR_SPREADSHEET_ID') {
    throw makeError_('CONFIG_ERROR', '스프레드시트 ID가 설정되지 않았습니다.');
  }
  let ss;
  try {
    ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  } catch (err) {
    // Deliberately does not echo the spreadsheet ID back to the client.
    console.error('openById failed: ' + err);
    throw makeError_('CONFIG_ERROR', '스프레드시트를 열 수 없습니다. 설정을 확인하세요.');
  }
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    throw makeError_('CONFIG_ERROR', "'" + CONFIG.SHEET_NAME + "' 시트를 찾을 수 없습니다.");
  }
  return sheet;
}

/** Maps each expected column key to its 0-based column index. */
function getHeaderIndex_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) {
    throw makeError_('CONFIG_ERROR', '시트에 헤더 행이 없습니다. setupSheet()를 먼저 실행하세요.');
  }
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function (h) { return String(h).trim(); });

  const index = {};
  const missing = [];
  COLUMNS.forEach(function (col) {
    const i = headers.indexOf(col.header);
    if (i === -1) missing.push(col.header);
    else index[col.key] = i;
  });
  if (missing.length) {
    throw makeError_('CONFIG_ERROR', '시트 헤더가 올바르지 않습니다. 누락: ' + missing.join(', '));
  }
  return index;
}

function getLogs_() {
  const sheet = getSheet_();
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
    // Rows without an ID are not app-managed records (e.g. staff scratch notes).
    if (!log.id) return;
    logs.push(log);
  });

  return logs;
}

/**
 * Coerces a raw cell into the type app.js expects.
 * A human can type anything into any cell, so this must never throw.
 * Date and time cells are formatted in CONFIG.TIMEZONE - serialising a Date
 * straight to JSON would render it in UTC and shift the day for early-morning
 * entries. Sheets also silently turns a typed "09:00" into a Date, which is
 * why the time columns go through the same guard.
 */
function normalizeCell_(value, type) {
  if (value === null || value === undefined || value === '') {
    return type === 'number' ? 0 : '';
  }
  if (type === 'number') {
    const n = Number(value);
    return isFinite(n) ? n : 0;
  }
  if (type === 'numberOrEmpty') {
    const n = Number(value);
    return isFinite(n) ? n : '';
  }
  if (Object.prototype.toString.call(value) === '[object Date]') {
    // A bare time cell lands on 1899-12-30; anything else is a real date.
    const isTimeOnly = value.getFullYear() < 1900;
    return Utilities.formatDate(
      value, CONFIG.TIMEZONE, isTimeOnly ? 'HH:mm' : 'yyyy-MM-dd'
    );
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateLogInput_(payload) {
  const errors = [];
  const clean = {};
  const text = function (v) {
    return (v === null || v === undefined) ? '' : String(v).trim();
  };

  clean.vehicleNo = text(payload.vehicleNo);
  if (ALLOWED_VEHICLES.indexOf(clean.vehicleNo) === -1) {
    errors.push('올바른 차량을 선택해 주세요 (' + ALLOWED_VEHICLES.join(', ') + ' 중 선택).');
  }

  clean.date = text(payload.date);
  if (!DATE_RE.test(clean.date)) {
    errors.push('운행일을 YYYY-MM-DD 형식으로 입력해 주세요.');
  }

  clean.departTime = text(payload.departTime);
  clean.arriveTime = text(payload.arriveTime);
  if (!TIME_RE.test(clean.departTime) || !TIME_RE.test(clean.arriveTime)) {
    errors.push('출발/도착 시간을 HH:MM 형식으로 입력해 주세요.');
  }

  clean.driver = text(payload.driver);
  if (!clean.driver) errors.push('운전자 성명을 입력해 주세요.');
  else if (clean.driver.length > LIMITS.driver) errors.push('운전자 성명이 너무 깁니다.');

  clean.destination = text(payload.destination);
  if (!clean.destination) errors.push('목적지를 입력해 주세요.');
  else if (clean.destination.length > LIMITS.destination) errors.push('목적지가 너무 깁니다.');

  clean.purpose = text(payload.purpose);
  if (!clean.purpose) errors.push('운행사유를 입력해 주세요.');
  else if (clean.purpose.length > LIMITS.purpose) errors.push('운행사유가 너무 깁니다.');

  const passengerCount = Number(payload.passengerCount);
  if (!Number.isInteger(passengerCount) || passengerCount < 1) {
    errors.push('인원수는 1명 이상의 정수로 입력해 주세요.');
  } else if (passengerCount > LIMITS.maxPassengers) {
    errors.push('인원수가 너무 큽니다.');
  } else {
    clean.passengerCount = passengerCount;
  }

  const odometer = Number(payload.odometer);
  if (!isFinite(odometer) || odometer < 0) {
    errors.push('계기판 누적거리를 0 이상의 숫자로 입력해 주세요.');
  } else if (odometer > LIMITS.maxOdometer) {
    errors.push('계기판 값이 너무 큽니다.');
  } else {
    clean.odometer = odometer;
  }

  // Trusted as sent: the form collects a single odometer reading plus the trip
  // distance, so there is no second reading to recompute it from.
  const distance = Number(payload.distance);
  if (!isFinite(distance) || distance <= 0) {
    errors.push('운행거리를 0보다 큰 숫자로 입력해 주세요.');
  } else if (distance > LIMITS.maxDistance) {
    errors.push('운행거리가 너무 큽니다.');
  } else {
    clean.distance = distance;
  }

  // Optional. '' is a legitimate value and must survive as '' - app.js renders
  // it as '-' rather than '0 원'.
  const fuelCostRaw = payload.fuelCost;
  if (fuelCostRaw === '' || fuelCostRaw === null || fuelCostRaw === undefined) {
    clean.fuelCost = '';
  } else {
    const fuelCost = Number(fuelCostRaw);
    if (!isFinite(fuelCost) || fuelCost < 0) {
      errors.push('단가/주유금액은 0 이상의 숫자로 입력해 주세요.');
    } else if (fuelCost > LIMITS.maxFuelCost) {
      errors.push('단가/주유금액이 너무 큽니다.');
    } else {
      clean.fuelCost = fuelCost;
    }
  }

  return { valid: errors.length === 0, errors: errors, clean: clean };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * ponytail: timestamp + random rather than a per-day sequence (log-...-001),
 * which would need a full scan of the ID column on every insert. Switch if
 * staff ever need human-countable sequential numbers.
 */
function createLogId_() {
  const stamp = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyyMMdd-HHmmss');
  return 'log-' + stamp + '-' + (Math.floor(Math.random() * 9000) + 1000);
}

function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * `status` is echoed in the body for debugging only. The real HTTP status is
 * always 200 - ContentService cannot set status codes.
 */
function errorResponse_(code, message, status) {
  return jsonResponse_({
    success: false,
    error: { code: code, message: message, status: status || 400 },
  });
}

function makeError_(code, userMessage) {
  const err = new Error(userMessage);
  err.code = code;
  err.userMessage = userMessage;
  return err;
}

/**
 * The format a column's cells must carry.
 *
 * Text columns have to be plain text or Sheets re-reads what it is given and
 * the original string is gone: '0704' becomes the number 704, '09:00' becomes
 * a Date rendered as "오전 9:00:00". `date` is the deliberate exception - a
 * real date cell sorts and filters for staff, and normalizeCell_() turns it
 * back into yyyy-MM-dd in CONFIG.TIMEZONE on the way out.
 *
 * One function because handleCreate_() and setupSheet() both need the answer
 * and a disagreement between them would only show up as lost data.
 */
function formatFor_(col) {
  if (col.key === 'date') return 'yyyy-mm-dd';
  if (col.type === 'text') return '@';
  return '#,##0';
}

// ---------------------------------------------------------------------------
// One-time setup - run manually from the Apps Script editor
// ---------------------------------------------------------------------------

/**
 * Creates the sheet and its header row. Run once from the editor
 * (select setupSheet -> Run). Safe to re-run: it never deletes data rows.
 *
 * The time columns are forced to plain text. Left as-is, Sheets parses "09:00"
 * into a Date and the cell then renders as "오전 9:00:00".
 */
function setupSheet() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(CONFIG.SHEET_NAME);

  const headers = COLUMNS.map(function (c) { return c.header; });
  sheet.getRange(1, 1, 1, headers.length)
    .setValues([headers])
    .setFontWeight('bold')
    .setBackground('#f1f5f9');
  sheet.setFrozenRows(1);

  // Same formats handleCreate_() applies per row, so the two cannot drift.
  // Existing rows are reformatted too; new ones no longer depend on this.
  const keys = COLUMNS.map(function (c) { return c.key; });
  const rows = sheet.getMaxRows() - 1;
  COLUMNS.forEach(function (c) {
    sheet.getRange(2, keys.indexOf(c.key) + 1, rows, 1).setNumberFormat(formatFor_(c));
  });

  sheet.autoResizeColumns(1, headers.length);
  SpreadsheetApp.flush();
  console.log("'" + CONFIG.SHEET_NAME + "' 시트 준비 완료.");
}

// ---------------------------------------------------------------------------
// Self-check - run manually from the Apps Script editor
// ---------------------------------------------------------------------------

/**
 * Writes one record, reads it back, and deletes it.
 *
 * Worth its lines because this exact thing was already got wrong once:
 * formatting the column in setupSheet() looked correct, passed review, and
 * still stored 704. Only writing a row and reading it back proves it.
 *
 * Uses the real sheet - there is no other sheet to use - so it always removes
 * what it wrote, including when an assertion fails.
 */
function testLeadingZero() {
  const probe = {
    vehicleNo: '0704',
    date: Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd'),
    departTime: '09:00',
    arriveTime: '09:30',
    driver: 'SELFTEST',
    passengerCount: 1,
    odometer: 1,
    distance: 1,
    destination: 'SELFTEST',
    purpose: 'SELFTEST',
    fuelCost: '',
  };

  const created = JSON.parse(handleCreate_(probe).getContent());
  if (!created.success) throw new Error('write failed: ' + JSON.stringify(created.error));
  const id = created.data.id;

  try {
    const stored = getLogs_().filter(function (r) { return r.id === id; })[0];
    if (!stored) throw new Error('row not found after write: ' + id);

    const checks = [
      ['vehicleNo', stored.vehicleNo, '0704'],
      ['departTime', stored.departTime, '09:00'],
      ['arriveTime', stored.arriveTime, '09:30'],
      ['date', stored.date, probe.date],
      ['fuelCost', stored.fuelCost, ''],
    ];
    const failed = checks.filter(function (c) { return c[1] !== c[2]; });
    if (failed.length) {
      throw new Error('FAILED\n' + failed.map(function (c) {
        return '  ' + c[0] + ': got ' + JSON.stringify(c[1]) +
          ', expected ' + JSON.stringify(c[2]);
      }).join('\n'));
    }
    console.log('PASSED - 0704 stays 0704, times stay strings, empty 주유금액 stays empty.');
  } finally {
    handleDelete_({ id: id });
  }
}
