/**
 * Vehicle Usage Log App - Google Apps Script Backend
 *
 * Deploy as a Web App:
 *   Execute as       : Me
 *   Who has access   : Anyone
 *
 * Column Structure (Matches 11 Fields):
 * 1. date (운행일)
 * 2. departTime (출발시간)
 * 3. arriveTime (도착시간)
 * 4. driver (운전자)
 * 5. odometer (계기판)
 * 6. distance (운행거리)
 * 7. destination (목적지)
 * 8. purpose (운행사유)
 * 9. passengerCount (인원)
 * 10. fuelCost (단가/주유금액 - optional)
 * 11. vehicleNo (차량선택 - whitelist: ['0704', '8318', '1213', '5486'])
 */

const CONFIG = {
  SPREADSHEET_ID: 'YOUR_SPREADSHEET_ID',
  SHEET_NAME: '운행일지',
  TIMEZONE: 'Asia/Seoul',
  MAX_PAYLOAD_BYTES: 8192,
  LOCK_TIMEOUT_MS: 10000,
};

const ALLOWED_VEHICLES = ['0704', '8318', '1213', '5486'];

const COLUMNS = [
  { key: 'id',             header: '기록ID',        type: 'text'   },
  { key: 'date',           header: '운행일',        type: 'text'   },
  { key: 'departTime',     header: '출발시간',      type: 'text'   },
  { key: 'arriveTime',     header: '도착시간',      type: 'text'   },
  { key: 'driver',         header: '운전자',        type: 'text'   },
  { key: 'odometer',       header: '계기판(km)',    type: 'number' },
  { key: 'distance',       header: '운행거리(km)',  type: 'number' },
  { key: 'destination',    header: '목적지',        type: 'text'   },
  { key: 'purpose',        header: '운행사유',      type: 'text'   },
  { key: 'passengerCount', header: '인원',          type: 'number' },
  { key: 'fuelCost',       header: '단가/주유금액', type: 'number' },
  { key: 'vehicleNo',      header: '차량선택',      type: 'text'   },
  { key: 'createdAt',      header: '작성시각',      type: 'text'   },
];

// ---------------------------------------------------------------------------
// Entry Points
// ---------------------------------------------------------------------------

function doGet(e) {
  try {
    const logs = getLogs_();
    return jsonResponse_({ success: true, data: logs, count: logs.length });
  } catch (err) {
    console.error('doGet failed: ' + (err && err.stack ? err.stack : err));
    return errorResponse_(
      err.code || 'SERVER_ERROR',
      err.userMessage || '데이터를 불러오지 못했습니다. 구글 시트 헤더 설정을 확인해 주세요.',
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
    sheet.appendRow(row);

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
// Sheet Access
// ---------------------------------------------------------------------------

function getSheet_() {
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
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    throw makeError_('CONFIG_ERROR', "'" + CONFIG.SHEET_NAME + "' 시트를 찾을 수 없습니다.");
  }
  return sheet;
}

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
    throw makeError_('CONFIG_ERROR', '시트 헤더가 불일치합니다. Apps Script 편집기에서 setupSheet()를 실행해 헤더를 재구성해 주세요. 누락 헤더: ' + missing.join(', '));
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
    if (!log.id) return;
    logs.push(log);
  });

  return logs;
}

function normalizeCell_(value, type) {
  if (value === null || value === undefined || value === '') {
    return type === 'number' ? '' : '';
  }
  if (type === 'number') {
    const n = Number(value);
    return isFinite(n) ? n : '';
  }
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, CONFIG.TIMEZONE, 'yyyy-MM-dd');
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

  // 1. Vehicle Whitelist Validation
  clean.vehicleNo = text(payload.vehicleNo);
  if (ALLOWED_VEHICLES.indexOf(clean.vehicleNo) === -1) {
    errors.push('허용되지 않은 차량번호입니다. (0704, 8318, 1213, 5486 만 선택 가능)');
  }

  // 2. Date
  clean.date = text(payload.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean.date)) {
    errors.push('운행일자를 올바르게 입력해 주세요.');
  }

  // 3 & 4. Times
  clean.departTime = text(payload.departTime);
  clean.arriveTime = text(payload.arriveTime);
  if (!clean.departTime || !clean.arriveTime) {
    errors.push('출발시간과 도착시간을 입력해 주세요.');
  }

  // 5. Driver
  clean.driver = text(payload.driver);
  if (!clean.driver) {
    errors.push('운전자 성명을 입력해 주세요.');
  }

  // 6. Odometer Non-negative Check
  const odometer = Number(payload.odometer);
  if (!isFinite(odometer) || odometer < 0) {
    errors.push('계기판 누적거리는 0 이상의 숫자로 입력해 주세요.');
  } else {
    clean.odometer = odometer;
  }

  // 7. Distance Positive Check
  const distance = Number(payload.distance);
  if (!isFinite(distance) || distance <= 0) {
    errors.push('운행거리는 0보다 큰 숫자로 입력해 주세요.');
  } else {
    clean.distance = distance;
  }

  // 8. Destination
  clean.destination = text(payload.destination);
  if (!clean.destination) {
    errors.push('목적지를 입력해 주세요.');
  }

  // 9. Purpose
  clean.purpose = text(payload.purpose);
  if (!clean.purpose) {
    errors.push('운행사유를 입력해 주세요.');
  }

  // 10. Passenger Count Integer Check
  const passengerCount = Number(payload.passengerCount);
  if (!isFinite(passengerCount) || passengerCount < 1 || Math.floor(passengerCount) !== passengerCount) {
    errors.push('인원수는 1명 이상의 정수(자연수)로 입력해 주세요.');
  } else {
    clean.passengerCount = passengerCount;
  }

  // 11. Fuel Cost Optional & Non-negative Check
  if (payload.fuelCost !== '' && payload.fuelCost !== null && payload.fuelCost !== undefined) {
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

// ---------------------------------------------------------------------------
// Helpers & Setup
// ---------------------------------------------------------------------------

function createLogId_() {
  const stamp = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyyMMdd-HHmmss');
  return 'log-' + stamp + '-' + (Math.floor(Math.random() * 9000) + 1000);
}

function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

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
 * Creates or updates the sheet headers to match the 11-field spec.
 * Safe to run: updates line 1 headers without deleting row data.
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

  sheet.autoResizeColumns(1, headers.length);
  SpreadsheetApp.flush();
  console.log("'" + CONFIG.SHEET_NAME + "' 시트 준비 완료.");
}
