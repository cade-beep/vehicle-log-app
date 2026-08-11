/**
 * Visual + layout audit for the vehicle log app.
 *
 * Serves the repo over http (a file:// origin would break fetch), drives the
 * Chrome already installed on this machine via puppeteer-core, and walks a set
 * of device/state scenarios.
 *
 * Every request to the Apps Script endpoint is intercepted and answered with
 * canned JSON. The audit must never reach the real spreadsheet: scenarios that
 * need a full ledger would otherwise write junk rows into live data.
 *
 * Two outputs per scenario:
 *   - a screenshot in tests/screenshots/, for eyeballing
 *   - a list of elements that spill outside the viewport, printed to stdout
 *
 * The overflow list is the part that actually catches the bug being chased -
 * a screenshot only shows the spill if it happens above the fold.
 *
 * Usage: node tests/visual_audit.js
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(__dirname, 'screenshots');
const PORT = 8080;

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find(function (p) { return fs.existsSync(p); });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// ---------------------------------------------------------------------------
// Static server (stdlib - avoids pulling in a package to serve four files)
// ---------------------------------------------------------------------------

function serve() {
  const server = http.createServer(function (req, res) {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);

    // Keep the server inside the repo even if a page requests '../../etc'.
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(file, function (err, body) {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    });
  });
  return new Promise(function (resolve) {
    server.listen(PORT, function () { resolve(server); });
  });
}

// ---------------------------------------------------------------------------
// Fake ledger data
// ---------------------------------------------------------------------------

const VEHICLES = ['0704', '8318', '1213', '5486'];

function fakeRows(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      id: 'log-fake-' + String(i).padStart(4, '0'),
      date: '2026-08-' + String((i % 28) + 1).padStart(2, '0'),
      vehicleNo: VEHICLES[i % VEHICLES.length],
      driver: ['김규호', '박서준', '이하늘'][i % 3],
      departTime: '09:00',
      arriveTime: '18:30',
      odometer: 10500 + i * 137,
      distance: 45 + (i % 9) * 13,
      // A deliberately long value - the ledger has to cope with real place names.
      destination: i % 4 === 0 ? '전라남도 광양시 중마중앙로 111 시청 별관' : '광양시청',
      purpose: i % 3 === 0 ? '본청 정기 회의 참석 및 관련 부서 업무 협의' : '현장 점검',
      passengerCount: (i % 4) + 1,
      fuelCost: i % 3 === 0 ? '' : 50000 + i * 1000,
      createdAt: '2026-08-' + String((i % 28) + 1).padStart(2, '0') + 'T09:00:00+09:00',
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const DESKTOP = { width: 1920, height: 1080, isMobile: false };
const SCENARIOS = [
  { name: '01-desktop-light', viewport: DESKTOP, scheme: 'light', rows: 3 },
  { name: '02-desktop-dark', viewport: DESKTOP, scheme: 'dark', rows: 3 },
  { name: '03-iphone-se', viewport: { width: 375, height: 667, isMobile: true }, scheme: 'dark', rows: 3 },
  { name: '04-iphone-14-pro-max', viewport: { width: 430, height: 932, isMobile: true }, scheme: 'dark', rows: 3 },
  { name: '05-ipad-mini', viewport: { width: 768, height: 1024, isMobile: true }, scheme: 'dark', rows: 3 },
  { name: '06-galaxy-z-fold-closed', viewport: { width: 280, height: 653, isMobile: true }, scheme: 'dark', rows: 3 },
  { name: '07-form-focused', viewport: { width: 375, height: 667, isMobile: true }, scheme: 'dark', rows: 0, focus: '#odometer' },
  { name: '08-validation-error', viewport: { width: 375, height: 667, isMobile: true }, scheme: 'dark', rows: 0, submitEmpty: true },
  { name: '09-ledger-full-desktop', viewport: DESKTOP, scheme: 'dark', rows: 12 },
  { name: '10-ledger-full-mobile', viewport: { width: 375, height: 667, isMobile: true }, scheme: 'dark', rows: 12 },
  // Beyond the plan's ten: the two states most likely to spill sideways.
  { name: '11-long-values-narrow', viewport: { width: 320, height: 568, isMobile: true }, scheme: 'dark', rows: 12 },
  { name: '12-desktop-narrow-split', viewport: { width: 1100, height: 900, isMobile: false }, scheme: 'dark', rows: 12 },
];

/**
 * Finds elements painted outside the viewport's horizontal bounds.
 *
 * Elements inside a deliberately scrollable box (the ledger's own table wrap)
 * are skipped - overflowing there is the design, not a defect. Anything else
 * that reaches past the right edge is pushing the page wider than the screen.
 */
const FIND_OVERFLOW = function () {
  const docWidth = document.documentElement.clientWidth;
  const bad = [];
  const seen = new Set();

  const inScroller = function (el) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
    return false;
  };

  const label = function (el) {
    return el.tagName.toLowerCase() +
      (el.id ? '#' + el.id : '') +
      (el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\s+/).join('.') : '');
  };

  document.querySelectorAll('body *').forEach(function (el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    if (getComputedStyle(el).visibility === 'hidden') return;

    const spill = Math.round(r.right - docWidth);
    if (spill <= 1 && r.left >= -1) return;

    const key = label(el);
    if (seen.has(key)) return;
    seen.add(key);
    bad.push({
      el: key,
      right: Math.round(r.right),
      left: Math.round(r.left),
      spill: spill,
      // Reported rather than filtered out: an element inside a scroller is
      // usually fine, but when the page itself is scrolling sideways one of
      // these is the cause and hiding them hides the culprit.
      overflowX: getComputedStyle(el).overflowX,
      inScroller: inScroller(el),
    });
  });

  // Measured width at each layer of the ledger's containing chain. When the
  // page spills sideways this says which ancestor stopped constraining its
  // child, which the offender list alone cannot.
  const chain = ['.app', '.sheet', '.ledger', '.table-wrapper', '.log-table']
    .map(function (sel) {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        sel: sel,
        width: Math.round(el.getBoundingClientRect().width),
        scrollWidth: el.scrollWidth,
        minWidth: cs.minWidth,
        overflowX: cs.overflowX,
      };
    })
    .filter(Boolean);

  return {
    docWidth: docWidth,
    pageScrollWidth: document.documentElement.scrollWidth,
    offenders: bad,
    chain: chain,
  };
};

// ---------------------------------------------------------------------------

async function run() {
  if (!CHROME) throw new Error('Chrome not found - install it or set CHROME manually.');
  fs.mkdirSync(SHOTS, { recursive: true });

  const server = await serve();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--hide-scrollbars'],
  });

  const report = [];

  for (const s of SCENARIOS) {
    const page = await browser.newPage();
    await page.setViewport(Object.assign({ deviceScaleFactor: 1 }, s.viewport));
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: s.scheme }]);

    await page.setRequestInterception(true);
    page.on('request', function (req) {
      if (!req.url().includes('script.google.com')) {
        req.continue();
        return;
      }
      const body = req.method() === 'POST'
        ? { success: true, message: '운행일지가 등록되었습니다.', data: fakeRows(1)[0] }
        : { success: true, data: fakeRows(s.rows), count: s.rows };
      req.respond({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify(body),
      });
    });

    await page.goto('http://localhost:' + PORT + '/', { waitUntil: 'networkidle0' });

    if (s.focus) {
      await page.focus(s.focus);
      await page.type(s.focus, '10500');
    }
    if (s.submitEmpty) {
      await page.click('button[type=submit]');
      await new Promise(function (r) { setTimeout(r, 400); });
    }

    const result = await page.evaluate(FIND_OVERFLOW);
    await page.screenshot({ path: path.join(SHOTS, s.name + '.png'), fullPage: true });

    report.push({ scenario: s.name, viewport: s.viewport.width + 'x' + s.viewport.height, ...result });
    await page.close();
  }

  await browser.close();
  server.close();

  // -------------------------------------------------------------------------

  let failures = 0;
  for (const r of report) {
    const wider = r.pageScrollWidth > r.docWidth + 1;
    // Elements inside a scroller only matter when the page itself is spilling.
    const real = r.offenders.filter(function (o) { return !o.inScroller; });
    const ok = real.length === 0 && !wider;
    if (!ok) failures++;
    console.log('\n' + (ok ? 'PASS' : 'FAIL') + '  ' + r.scenario + '  (' + r.viewport + ')');
    if (wider) {
      console.log('  page scrolls sideways: scrollWidth ' + r.pageScrollWidth + ' > viewport ' + r.docWidth);
    }
    for (const o of r.offenders.slice(0, 12)) {
      console.log('  +' + o.spill + 'px  ' + o.el +
        '  [overflow-x:' + o.overflowX + (o.inScroller ? ', in scroller' : '') + ']');
    }
    if (r.offenders.length > 12) console.log('  ... and ' + (r.offenders.length - 12) + ' more');
    if (!ok) {
      for (const c of r.chain) {
        console.log('    ' + c.sel.padEnd(16) + ' w=' + String(c.width).padStart(5) +
          '  scrollW=' + String(c.scrollWidth).padStart(5) +
          '  min-width=' + c.minWidth + '  overflow-x=' + c.overflowX);
      }
    }
  }

  console.log('\n' + (report.length - failures) + '/' + report.length + ' scenarios clean.');
  console.log('Screenshots: ' + SHOTS);
  process.exitCode = failures ? 1 : 0;
}

run().catch(function (err) {
  console.error(err);
  process.exit(1);
});
