/**
 * Vehicle Usage Log Application - Client Logic & Security Architecture
 *
 * Storage: Google Sheets via an Apps Script web app (see apps-script/Code.gs).
 * The Apps Script URL is configured in config.js.
 */

document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const form = document.getElementById('vehicleLogForm');
    const driveDateInput = document.getElementById('driveDate');
    const driverNameInput = document.getElementById('driverName');
    const carNumberInput = document.getElementById('carNumber');
    const purposeCategorySelect = document.getElementById('purposeCategory');
    const startLocationInput = document.getElementById('startLocation');
    const endLocationInput = document.getElementById('endLocation');
    const startOdometerInput = document.getElementById('startOdometer');
    const endOdometerInput = document.getElementById('endOdometer');
    const calcDistanceInput = document.getElementById('calcDistance');
    const memoInput = document.getElementById('memo');
    const formAlert = document.getElementById('formAlert');
    const submitButton = form.querySelector('button[type="submit"]');

    const tableBody = document.getElementById('logTableBody');
    const emptyState = document.getElementById('emptyState');
    const searchInput = document.getElementById('searchInput');
    const btnExportCSV = document.getElementById('btnExportCSV');
    const lastUpdatedEl = document.getElementById('lastUpdated');

    // Stat Elements
    const statTotalKm = document.getElementById('statTotalKm');
    const statTotalCount = document.getElementById('statTotalCount');
    const statBusinessRatio = document.getElementById('statBusinessRatio');
    const statAvgKm = document.getElementById('statAvgKm');

    // Default Date to Today
    driveDateInput.valueAsDate = new Date();

    // -------------------------------------------------------------
    // Configuration
    // -------------------------------------------------------------

    const APP_CONFIG = window.APP_CONFIG || {};
    const API_URL = String(APP_CONFIG.APPS_SCRIPT_URL || '').trim();
    const POLLING_INTERVAL_MS = Number(APP_CONFIG.POLLING_INTERVAL_MS) || 10000;
    const REQUEST_TIMEOUT_MS = 15000;

    let records = [];
    let isSubmitting = false;
    let isRefreshing = false;
    let pollingTimer = null;
    let lastRenderedSignature = null;

    // -------------------------------------------------------------
    // Security & Utility Functions
    // -------------------------------------------------------------

    /**
     * Escape HTML strings to prevent XSS (Cross-Site Scripting)
     * @param {string} str
     * @returns {string} Safe HTML string
     */
    function escapeHTML(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    /**
     * Coerce one record coming back from the spreadsheet into the shape the
     * rest of this file assumes.
     *
     * Spreadsheet cells are typed by whoever edits the sheet, so a "number"
     * column can contain arbitrary text and any cell can be blank. Without
     * this, renderTable()'s .toLowerCase() throws on a blank cell (killing the
     * whole table) and updateStats() string-concatenates instead of adding.
     * Everything downstream may assume: text fields are strings, numeric
     * fields are finite numbers.
     */
    function normalizeRecord(raw) {
        const r = (raw && typeof raw === 'object') ? raw : {};
        const str = (v) => (v === null || v === undefined) ? '' : String(v);
        const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };

        return {
            id:        str(r.id),
            date:      str(r.date),
            driver:    str(r.driver),
            carNumber: str(r.carNumber),
            category:  str(r.category),
            startLoc:  str(r.startLoc),
            endLoc:    str(r.endLoc),
            startKm:   num(r.startKm),
            endKm:     num(r.endKm),
            distance:  num(r.distance),
            memo:      str(r.memo),
            createdAt: str(r.createdAt),
        };
    }

    /** Newest first. Sorted client-side so manual row reordering in the sheet doesn't change the view. */
    function sortByNewest(list) {
        return list.slice().sort((a, b) => {
            if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
            return a.date < b.date ? 1 : -1;
        });
    }

    /**
     * Calculate Distance automatically
     */
    function updateCalculatedDistance() {
        const start = parseFloat(startOdometerInput.value);
        const end = parseFloat(endOdometerInput.value);

        if (!isNaN(start) && !isNaN(end)) {
            const dist = end - start;
            if (dist < 0) {
                calcDistanceInput.value = '오류 (도착 < 출발)';
                calcDistanceInput.style.color = '#ef4444';
            } else {
                calcDistanceInput.value = `${dist.toLocaleString()} km`;
                calcDistanceInput.style.color = '#3b82f6';
            }
        } else {
            calcDistanceInput.value = '0 km';
            calcDistanceInput.style.color = '#3b82f6';
        }
    }

    startOdometerInput.addEventListener('input', updateCalculatedDistance);
    endOdometerInput.addEventListener('input', updateCalculatedDistance);

    // -------------------------------------------------------------
    // API Layer (Google Apps Script)
    // -------------------------------------------------------------

    /**
     * Shared request handling: timeout, network errors, non-2xx, bad JSON,
     * and API-level {success:false}.
     *
     * NOTE: POST uses Content-Type 'text/plain;charset=utf-8' on purpose.
     * 'application/json' would make the browser send a CORS preflight
     * (OPTIONS), which Apps Script web apps cannot answer - the request would
     * fail before reaching the server. text/plain is a CORS "simple request".
     * The body is still JSON and Apps Script parses it as such.
     */
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
            console.error('HTTP error', response.status);
            throw new Error(`서버에 연결하지 못했습니다. (오류 ${response.status})`);
        }

        let result;
        try {
            result = await response.json();
        } catch (err) {
            // Usually means the Apps Script URL is wrong and we got an HTML page.
            console.error('Failed to parse API response as JSON', err);
            throw new Error('서버 응답을 해석할 수 없습니다. Apps Script 주소를 확인해 주세요.');
        }

        // Apps Script cannot set HTTP status codes - every response is 200,
        // so success/failure must be read from the payload.
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
        emptyState.style.display = 'block';
        const p = emptyState.querySelector('p');
        if (p && message) p.innerHTML = message;
    }

    /**
     * @param {{showLoading?: boolean}} opts
     */
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
            renderTable(searchInput.value);
            updateStats();

            const now = new Date();
            setLastUpdated(`최근 갱신 ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`);
        } catch (err) {
            console.error('Failed to load logs', err);
            // Background polling failures must not wipe data already on screen.
            if (showLoading || records.length === 0) {
                tableBody.innerHTML = '';
                lastRenderedSignature = null;
                showEmptyState(`데이터를 불러오지 못했습니다.<br>${escapeHTML(err.message)}`);
                updateStats();
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

    // Don't poll a tab nobody is looking at.
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stopPolling();
        } else {
            refreshLogs();
            startPolling();
        }
    });

    // -------------------------------------------------------------
    // Form Submission & Validation
    // -------------------------------------------------------------

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        hideAlert();

        if (isSubmitting) return;

        const date = driveDateInput.value;
        const driver = driverNameInput.value.trim();
        const carNumber = carNumberInput.value.trim();
        const category = purposeCategorySelect.value;
        const startLoc = startLocationInput.value.trim();
        const endLoc = endLocationInput.value.trim();
        const startKm = parseFloat(startOdometerInput.value);
        const endKm = parseFloat(endOdometerInput.value);
        const memo = memoInput.value.trim();

        // Validation Checks (the server validates again - this is for fast feedback)
        if (!date || !driver || !carNumber || !startLoc || !endLoc || isNaN(startKm) || isNaN(endKm)) {
            showAlert('모든 필수 항목을 입력해 주세요.', 'danger');
            return;
        }

        if (endKm < startKm) {
            showAlert('도착 계기판 거리는 출발 계기판 거리보다 크거나 같아야 합니다.', 'danger');
            return;
        }

        // distance is deliberately not sent - the server recalculates it.
        const payload = { date, driver, carNumber, category, startLoc, endLoc, startKm, endKm, memo };

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
            startOdometerInput.value = endKm; // Next trip default start odometer
            updateCalculatedDistance();

            await refreshLogs();
        } catch (err) {
            // Input is left untouched so the user can retry without retyping.
            console.error('Failed to create log', err);
            showAlert(err.message || '저장에 실패했습니다. 다시 시도해 주세요.', 'danger');
        } finally {
            isSubmitting = false;
            submitButton.disabled = false;
            submitButton.innerHTML = originalLabel;
        }
    });

    // Alert Messages
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

    function getCategoryTagClass(cat) {
        switch(cat) {
            case '업무용': return 'tag-business';
            case '출퇴근': return 'tag-commute';
            case '비업무용': return 'tag-personal';
            default: return 'tag-maintenance';
        }
    }

    function renderTable(filterQuery = '') {
        const query = String(filterQuery || '').toLowerCase();

        const filtered = records.filter(r => {
            return r.driver.toLowerCase().includes(query) ||
                   r.carNumber.toLowerCase().includes(query) ||
                   r.category.toLowerCase().includes(query) ||
                   r.startLoc.toLowerCase().includes(query) ||
                   r.endLoc.toLowerCase().includes(query);
        });

        // Skip the DOM work when polling returned identical data, so the table
        // doesn't flicker and the user doesn't lose their place every interval.
        const signature = JSON.stringify(filtered);
        if (signature === lastRenderedSignature) return;
        lastRenderedSignature = signature;

        tableBody.innerHTML = '';

        if (filtered.length === 0) {
            showEmptyState('등록된 운행일지가 없습니다.<br>좌측 폼을 작성하여 새로 추가해 보세요.');
            return;
        }

        emptyState.style.display = 'none';

        filtered.forEach(r => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${escapeHTML(r.date)}</td>
                <td><strong>${escapeHTML(r.driver)}</strong></td>
                <td>${escapeHTML(r.carNumber)}</td>
                <td><span class="tag-badge ${getCategoryTagClass(r.category)}">${escapeHTML(r.category)}</span></td>
                <td>${escapeHTML(r.startLoc)} ➔ ${escapeHTML(r.endLoc)}</td>
                <td><strong>${r.distance.toLocaleString()} km</strong> <br><small style="color:var(--text-muted)">(${r.startKm.toLocaleString()}~${r.endKm.toLocaleString()})</small></td>
                <td>${escapeHTML(r.memo || '-')}</td>
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

    function updateStats() {
        const totalKm = records.reduce((acc, r) => acc + r.distance, 0);
        const totalCount = records.length;

        const businessCount = records.filter(r => r.category === '업무용').length;
        const businessRatio = totalCount > 0 ? ((businessCount / totalCount) * 100).toFixed(1) : 0;
        const avgKm = totalCount > 0 ? (totalKm / totalCount).toFixed(1) : 0;

        statTotalKm.textContent = `${totalKm.toLocaleString()} km`;
        statTotalCount.textContent = `${totalCount.toLocaleString()} 건`;
        statBusinessRatio.textContent = `${businessRatio} %`;
        statAvgKm.textContent = `${avgKm} km`;
    }

    // Filter Listeners
    searchInput.addEventListener('input', (e) => {
        renderTable(e.target.value);
    });

    // -------------------------------------------------------------
    // CSV Export (Excel Compatible)
    // -------------------------------------------------------------

    btnExportCSV.addEventListener('click', () => {
        if (records.length === 0) {
            alert('내보낼 운행 기록 데이터가 없습니다.');
            return;
        }

        const headers = ['일자', '운전자', '차량번호', '구분', '출발지', '도착지', '출발계기판(km)', '도착계기판(km)', '주행거리(km)', '비고'];
        let csvContent = '\uFEFF'; // UTF-8 BOM for Excel Korean support
        csvContent += headers.join(',') + '\n';

        records.forEach(r => {
            const row = [
                `"${r.date}"`,
                `"${r.driver.replace(/"/g, '""')}"`,
                `"${r.carNumber.replace(/"/g, '""')}"`,
                `"${r.category.replace(/"/g, '""')}"`,
                `"${r.startLoc.replace(/"/g, '""')}"`,
                `"${r.endLoc.replace(/"/g, '""')}"`,
                r.startKm,
                r.endKm,
                r.distance,
                `"${(r.memo || '').replace(/"/g, '""')}"`
            ];
            csvContent += row.join(',') + '\n';
        });

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.setAttribute('href', url);
        link.setAttribute('download', `차량사용일지_${new Date().toISOString().split('T')[0]}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    });

    // -------------------------------------------------------------
    // Initialize
    // -------------------------------------------------------------

    updateStats();

    if (!API_URL) {
        showEmptyState('설정이 필요합니다.<br>config.js 파일에 Apps Script 주소를 입력해 주세요.');
        showAlert('config.js에 Apps Script 주소가 설정되지 않았습니다.', 'danger');
        submitButton.disabled = true;
    } else {
        refreshLogs({ showLoading: true });
        startPolling();
    }
});
