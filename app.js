/**
 * Vehicle Usage Log Application - Client Logic
 *
 * 11 Required Fields:
 * 1. driveDate (운행일)
 * 2. departTime (출발시간)
 * 3. arriveTime (도착시간)
 * 4. driver (운전자)
 * 5. odometer (계기판)
 * 6. distance (운행거리)
 * 7. destination (목적지)
 * 8. purpose (운행사유)
 * 9. passengerCount (인원)
 * 10. fuelCost (단가/주유금액 - optional)
 * 11. vehicleNo (차량선택 - '0704', '8318', '1213', '5486')
 */

document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const form = document.getElementById('vehicleLogForm');
    const vehicleNoSelect = document.getElementById('vehicleNo');
    const driveDateInput = document.getElementById('driveDate');
    const departTimeInput = document.getElementById('departTime');
    const arriveTimeInput = document.getElementById('arriveTime');
    const driverNameInput = document.getElementById('driverName');
    const passengerCountInput = document.getElementById('passengerCount');
    const odometerInput = document.getElementById('odometer');
    const distanceInput = document.getElementById('distance');
    const destinationInput = document.getElementById('destination');
    const purposeInput = document.getElementById('purpose');
    const fuelCostInput = document.getElementById('fuelCost');

    const formAlert = document.getElementById('formAlert');
    const submitButton = form.querySelector('button[type="submit"]');

    const tableBody = document.getElementById('logTableBody');
    const emptyState = document.getElementById('emptyState');
    const lastUpdatedEl = document.getElementById('lastUpdated');

    // Default Values
    driveDateInput.valueAsDate = new Date();

    const ALLOWED_VEHICLES = ['0704', '8318', '1213', '5486'];

    // -------------------------------------------------------------
    // Configuration
    // -------------------------------------------------------------
    const APP_CONFIG = window.APP_CONFIG || {};
    const API_URL = String(APP_CONFIG.APPS_SCRIPT_URL || '').trim();
    const POLLING_INTERVAL_MS = Number(APP_CONFIG.POLLING_INTERVAL_MS) || 30000;
    const REQUEST_TIMEOUT_MS = 15000;

    let records = [];
    let isSubmitting = false;
    let isRefreshing = false;
    let pollingTimer = null;
    let lastRenderedSignature = null;

    // -------------------------------------------------------------
    // Utility & Security Functions
    // -------------------------------------------------------------
    function escapeHTML(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function normalizeRecord(raw) {
        const r = (raw && typeof raw === 'object') ? raw : {};
        const str = (v) => (v === null || v === undefined) ? '' : String(v);
        const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
        const numOrEmpty = (v) => {
            if (v === '' || v === null || v === undefined) return '';
            const n = Number(v);
            return isFinite(n) ? n : '';
        };

        return {
            id:             str(r.id),
            vehicleNo:      str(r.vehicleNo),
            date:           str(r.date),
            departTime:     str(r.departTime),
            arriveTime:     str(r.arriveTime),
            driver:         str(r.driver),
            odometer:       num(r.odometer),
            distance:       num(r.distance),
            destination:    str(r.destination),
            purpose:        str(r.purpose),
            passengerCount: num(r.passengerCount),
            fuelCost:       numOrEmpty(r.fuelCost),
            createdAt:      str(r.createdAt),
        };
    }

    function sortByNewest(list) {
        return list.slice().sort((a, b) => {
            if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
            return a.date < b.date ? 1 : -1;
        });
    }

    // -------------------------------------------------------------
    // API Layer
    // -------------------------------------------------------------
    async function apiRequest(method, body) {
        if (!API_URL) {
            throw new Error('Apps Script 주소가 설정되지 않았습니다. config.js를 확인해 주세요.');
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        let response;
        try {
            const options = { method, cache: 'no-store', signal: controller.signal };
            if (body) {
                options.headers = { 'Content-Type': 'text/plain;charset=utf-8' };
                options.body = JSON.stringify(body);
            }
            response = await fetch(API_URL, options);
        } catch (err) {
            if (err.name === 'AbortError') {
                throw new Error('서버 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.');
            }
            console.error('Network request failed', err);
            throw new Error('서버에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.');
        } finally {
            clearTimeout(timer);
        }

        if (!response.ok) {
            throw new Error(`서버에 연결하지 못했습니다. (오류 ${response.status})`);
        }

        let result;
        try {
            result = await response.json();
        } catch (err) {
            throw new Error('서버 응답을 해석할 수 없습니다. Apps Script 주소를 확인해 주세요.');
        }

        if (!result || result.success !== true) {
            const message = result && result.error && result.error.message;
            throw new Error(message || '서버가 오류를 반환했습니다.');
        }
        return result;
    }

    async function fetchLogs() {
        const result = await apiRequest('GET');
        const list = Array.isArray(result.data) ? result.data : [];
        return sortByNewest(list.map(normalizeRecord));
    }

    async function createLog(logData) {
        const result = await apiRequest('POST', Object.assign({ action: 'create' }, logData));
        return normalizeRecord(result.data);
    }

    async function deleteLogById(id) {
        await apiRequest('POST', { action: 'delete', id });
    }

    // -------------------------------------------------------------
    // Data Refresh & Polling
    // -------------------------------------------------------------
    function setLastUpdated(text) {
        if (lastUpdatedEl) lastUpdatedEl.textContent = text;
    }

    function showEmptyState(message) {
        if (!emptyState) return;
        emptyState.style.display = 'block';
        const p = emptyState.querySelector('p');
        if (p && message) p.innerHTML = message;
    }

    async function refreshLogs({ showLoading = false } = {}) {
        if (isRefreshing) return;
        isRefreshing = true;

        try {
            if (showLoading) {
                tableBody.innerHTML = '';
                showEmptyState('운행일지를 불러오는 중입니다...');
            }

            const logs = await fetchLogs();
            records = logs;
            renderTable();

            const now = new Date();
            setLastUpdated(`최근 갱신 ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`);
        } catch (err) {
            console.error('Failed to load logs', err);
            if (showLoading || records.length === 0) {
                tableBody.innerHTML = '';
                lastRenderedSignature = null;
                showEmptyState(`데이터를 불러오지 못했습니다.<br>${escapeHTML(err.message)}`);
            }
            setLastUpdated('갱신 실패');
        } finally {
            isRefreshing = false;
        }
    }

    function startPolling() {
        if (pollingTimer) return;
        pollingTimer = setInterval(() => refreshLogs(), POLLING_INTERVAL_MS);
    }

    function stopPolling() {
        if (!pollingTimer) return;
        clearInterval(pollingTimer);
        pollingTimer = null;
    }

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stopPolling();
        } else {
            refreshLogs();
            startPolling();
        }
    });

    // -------------------------------------------------------------
    // Form Submission & Enhanced Validation
    // -------------------------------------------------------------
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        hideAlert();

        if (isSubmitting) return;

        const vehicleNo = vehicleNoSelect.value;
        const date = driveDateInput.value;
        const departTime = departTimeInput.value;
        const arriveTime = arriveTimeInput.value;
        const driver = driverNameInput.value.trim();
        const passengerCountNum = Number(passengerCountInput.value);
        const odometerNum = Number(odometerInput.value);
        const distanceNum = Number(distanceInput.value);
        const destination = destinationInput.value.trim();
        const purpose = purposeInput.value.trim();
        const fuelCostRaw = fuelCostInput.value.trim();
        
        // 1. Vehicle Whitelist
        if (!vehicleNo || ALLOWED_VEHICLES.indexOf(vehicleNo) === -1) {
            showAlert('올바른 차량을 선택해 주세요 (0704, 8318, 1213, 5486 중 선택).', 'danger');
            return;
        }
        // 2. Date Validation
        if (!date) {
            showAlert('운행일을 입력해 주세요.', 'danger');
            return;
        }
        // 3. Time Validation
        if (!departTime || !arriveTime) {
            showAlert('출발시간과 도착시간을 입력해 주세요.', 'danger');
            return;
        }
        // 4. Driver Validation
        if (!driver) {
            showAlert('운전자 성명을 입력해 주세요.', 'danger');
            return;
        }
        // 5. Passenger Count Integer Check
        if (!Number.isInteger(passengerCountNum) || passengerCountNum < 1) {
            showAlert('인원수는 1명 이상의 정수(자연수)로 입력해 주세요.', 'danger');
            return;
        }
        // 6. Odometer Non-negative Check
        if (isNaN(odometerNum) || odometerNum < 0) {
            showAlert('계기판 누적거리를 0 이상의 숫자로 입력해 주세요.', 'danger');
            return;
        }
        // 7. Distance Positive Check
        if (isNaN(distanceNum) || distanceNum <= 0) {
            showAlert('운행거리를 0보다 큰 올바른 숫자로 입력해 주세요.', 'danger');
            return;
        }
        // 8. Destination Validation
        if (!destination) {
            showAlert('목적지를 입력해 주세요.', 'danger');
            return;
        }
        // 9. Purpose Validation
        if (!purpose) {
            showAlert('운행사유를 입력해 주세요.', 'danger');
            return;
        }
        // 10. Fuel Cost Optional & Non-negative Check
        let fuelCost = '';
        if (fuelCostRaw !== '') {
            const fuelCostNum = Number(fuelCostRaw);
            if (isNaN(fuelCostNum) || fuelCostNum < 0) {
                showAlert('단가/주유금액은 0 이상의 숫자로 입력해 주세요.', 'danger');
                return;
            }
            fuelCost = fuelCostNum;
        }

        const payload = {
            vehicleNo,
            date,
            departTime,
            arriveTime,
            driver,
            passengerCount: passengerCountNum,
            odometer: odometerNum,
            distance: distanceNum,
            destination,
            purpose,
            fuelCost
        };

        isSubmitting = true;
        const originalLabel = submitButton.innerHTML;
        submitButton.disabled = true;
        submitButton.textContent = '저장 중...';

        try {
            await createLog(payload);
            showAlert('운행일지가 성공적으로 등록되었습니다!', 'success');

            // Form Reset
            form.reset();
            driveDateInput.valueAsDate = new Date();

            await refreshLogs();
        } catch (err) {
            console.error('Failed to create log', err);
            showAlert(err.message || '저장에 실패했습니다. 다시 시도해 주세요.', 'danger');
        } finally {
            isSubmitting = false;
            submitButton.disabled = false;
            submitButton.innerHTML = originalLabel;
        }
    });

    function showAlert(msg, type) {
        formAlert.textContent = msg;
        formAlert.className = `alert-box ${type}`;
    }

    function hideAlert() {
        formAlert.className = 'alert-box hidden';
    }

    // -------------------------------------------------------------
    // Render Functions
    // -------------------------------------------------------------
    function renderTable() {
        const signature = JSON.stringify(records);
        if (signature === lastRenderedSignature) return;
        lastRenderedSignature = signature;

        tableBody.innerHTML = '';

        if (records.length === 0) {
            showEmptyState('등록된 운행일지가 없습니다.<br>좌측 폼을 작성하여 새로 추가해 보세요.');
            return;
        }

        if (emptyState) emptyState.style.display = 'none';

        records.forEach(r => {
            const tr = document.createElement('tr');
            const formattedFuelCost = r.fuelCost !== '' && r.fuelCost !== null && r.fuelCost !== undefined
                ? `${Number(r.fuelCost).toLocaleString()} 원`
                : '-';

            tr.innerHTML = `
                <td><strong class="vehicle-tag">${escapeHTML(r.vehicleNo)}</strong></td>
                <td>${escapeHTML(r.date)}</td>
                <td>${escapeHTML(r.departTime)} ~ ${escapeHTML(r.arriveTime)}</td>
                <td><strong>${escapeHTML(r.driver)}</strong></td>
                <td>${r.odometer.toLocaleString()} km</td>
                <td><strong>${r.distance.toLocaleString()} km</strong></td>
                <td>${escapeHTML(r.destination)}</td>
                <td>${escapeHTML(r.purpose)}</td>
                <td>${r.passengerCount} 명</td>
                <td>${formattedFuelCost}</td>
                <td>
                    <button class="btn-delete" data-id="${escapeHTML(r.id)}" title="삭제">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </td>
            `;
            tableBody.appendChild(tr);
        });

        // Attach Delete Listeners
        document.querySelectorAll('.btn-delete').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const button = e.currentTarget;
                const id = button.getAttribute('data-id');
                if (!confirm('해당 운행 기록을 삭제하시겠습니까?')) return;

                button.disabled = true;
                try {
                    await deleteLogById(id);
                    await refreshLogs();
                } catch (err) {
                    console.error('Failed to delete log', err);
                    showAlert(err.message || '삭제에 실패했습니다.', 'danger');
                    button.disabled = false;
                }
            });
        });
    }

    // -------------------------------------------------------------
    // Initialize
    // -------------------------------------------------------------
    if (!API_URL) {
        showEmptyState('설정이 필요합니다.<br>config.js 파일에 Apps Script 주소를 입력해 주세요.');
        showAlert('config.js에 Apps Script 주소가 설정되지 않았습니다.', 'danger');
        submitButton.disabled = true;
    } else {
        refreshLogs({ showLoading: true });
        startPolling();
    }
});
