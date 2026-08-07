/**
 * Vehicle Usage Log Application - Client Logic & Security Architecture
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
    
    const tableBody = document.getElementById('logTableBody');
    const emptyState = document.getElementById('emptyState');
    const searchInput = document.getElementById('searchInput');
    const btnExportCSV = document.getElementById('btnExportCSV');

    // Stat Elements
    const statTotalKm = document.getElementById('statTotalKm');
    const statTotalCount = document.getElementById('statTotalCount');
    const statBusinessRatio = document.getElementById('statBusinessRatio');
    const statAvgKm = document.getElementById('statAvgKm');

    // Default Date to Today
    driveDateInput.valueAsDate = new Date();

    // Data Storage (LocalStorage Key)
    const STORAGE_KEY = 'vehicle_log_records_v1';
    let records = loadRecords();

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
     * Load records securely from LocalStorage
     */
    function loadRecords() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return raw ? JSON.parse(raw) : getSampleRecords();
        } catch (e) {
            console.error('Failed to parse local records', e);
            return getSampleRecords();
        }
    }

    /**
     * Save records to LocalStorage
     */
    function saveRecords() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
        } catch (e) {
            showAlert('로컬 저장소 저장에 실패했습니다.', 'danger');
        }
    }

    /**
     * Initial Sample Data for better demonstration
     */
    function getSampleRecords() {
        const today = new Date().toISOString().split('T')[0];
        return [
            {
                id: 'rec_1',
                date: today,
                driver: '홍길동',
                carNumber: '12가 3456',
                category: '업무용',
                startLoc: '본사 사옥',
                endLoc: '강남 미팅룸',
                startKm: 12500,
                endKm: 12545,
                distance: 45,
                memo: '클라이언트 미팅 참석'
            },
            {
                id: 'rec_2',
                date: today,
                driver: '김철수',
                carNumber: '78나 9012',
                category: '출퇴근',
                startLoc: '자택',
                endLoc: '본사 사옥',
                startKm: 34100,
                endKm: 34120,
                distance: 20,
                memo: '오전 출근'
            }
        ];
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
    // Form Submission & Validation
    // -------------------------------------------------------------

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        hideAlert();

        const date = driveDateInput.value;
        const driver = driverNameInput.value.trim();
        const carNumber = carNumberInput.value.trim();
        const category = purposeCategorySelect.value;
        const startLoc = startLocationInput.value.trim();
        const endLoc = endLocationInput.value.trim();
        const startKm = parseFloat(startOdometerInput.value);
        const endKm = parseFloat(endOdometerInput.value);
        const memo = memoInput.value.trim();

        // Validation Checks
        if (!date || !driver || !carNumber || !startLoc || !endLoc || isNaN(startKm) || isNaN(endKm)) {
            showAlert('모든 필수 항목을 입력해 주세요.', 'danger');
            return;
        }

        if (endKm < startKm) {
            showAlert('도착 계기판 거리는 출발 계기판 거리보다 크거나 같아야 합니다.', 'danger');
            return;
        }

        const distance = endKm - startKm;

        // Create New Record
        const newRecord = {
            id: 'rec_' + Date.now(),
            date,
            driver,
            carNumber,
            category,
            startLoc,
            endLoc,
            startKm,
            endKm,
            distance,
            memo
        };

        records.unshift(newRecord);
        saveRecords();
        renderTable();
        updateStats();

        showAlert('운행일지가 성공적으로 등록되었습니다!', 'success');

        // Form Reset
        form.reset();
        driveDateInput.valueAsDate = new Date();
        startOdometerInput.value = endKm; // Next trip default start odometer
        updateCalculatedDistance();
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
        tableBody.innerHTML = '';
        const query = filterQuery.toLowerCase();

        const filtered = records.filter(r => {
            return r.driver.toLowerCase().includes(query) ||
                   r.carNumber.toLowerCase().includes(query) ||
                   r.category.toLowerCase().includes(query) ||
                   r.startLoc.toLowerCase().includes(query) ||
                   r.endLoc.toLowerCase().includes(query);
        });

        if (filtered.length === 0) {
            emptyState.style.display = 'block';
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
                    <button class="btn-delete" data-id="${r.id}" title="삭제">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </td>
            `;
            tableBody.appendChild(tr);
        });

        // Attach Delete Listeners
        document.querySelectorAll('.btn-delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.currentTarget.getAttribute('data-id');
                if (confirm('해당 운행 기록을 삭제하시겠습니까?')) {
                    records = records.filter(r => r.id !== id);
                    saveRecords();
                    renderTable(searchInput.value);
                    updateStats();
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
                `"${r.category}"`,
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
    });

    // Initialize
    renderTable();
    updateStats();
});
