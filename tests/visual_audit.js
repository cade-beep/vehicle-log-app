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
      destination: i % 4 === 0 ? '전라남도 광양시 중마중앙로 111 시청 별관'
        : (i === 1 ? '광양시청, 별관 "3층"' : '광양시청'),
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
  // The widths where the ledger changes shape. A table that does not fit only
  // shows up within a few dozen pixels of these, so they are pinned.
  { name: '13-laptop-1280', viewport: { width: 1280, height: 800, isMobile: false }, scheme: 'dark', rows: 12 },
  { name: '14-split-boundary-1366', viewport: { width: 1366, height: 768, isMobile: false }, scheme: 'dark', rows: 12 },
  { name: '15-desktop-1440', viewport: { width: 1440, height: 900, isMobile: false }, scheme: 'dark', rows: 12 },
  // Longest value every field will accept, on the narrowest screen. The unit
  // suffix (km/명/원) is painted over the input rather than beside it, so a
  // long odometer reading is the case where it would collide.
  {
    name: '16-max-input-narrow', viewport: { width: 320, height: 568, isMobile: true },
    scheme: 'dark', rows: 0,
    fill: {
      '#driverName': '김규호박서준이하늘김규호박서',
      '#passengerCount': '100',
      '#odometer': '9999999',
      '#distance': '9999',
      '#destination': '전라남도 광양시 중마중앙로 111 시청 별관 3층 회의실',
      '#purpose': '본청 정기 회의 참석 및 관련 부서 업무 협의 그리고 현장 점검',
      '#fuelCost': '9999999',
    },
  },
  // Not a layout case: the export builds a file from the same records the
  // ledger renders, and bad quoting or a missing BOM is invisible on screen.
  { name: '17-csv-export', viewport: DESKTOP, scheme: 'dark', rows: 12, exportCsv: true },
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

  /* The unit suffix (km, 명, 원) is painted over the input, not beside it, so
     the only thing keeping a long odometer reading from running underneath it
     is the padding reserved on the right. That coupling is invisible: change
     원 to 만원, or bump the font, and the reserve silently stops being enough.

     Measuring where the text lands does not work - once it overflows, the
     browser scrolls the field and the painted position stops matching any
     width you can calculate. So this checks the invariant that prevents the
     collision instead of trying to catch the collision itself. */
  const collisions = [];
  document.querySelectorAll('.field-unit').forEach(function (fu) {
    const input = fu.querySelector('input');
    const unit = fu.querySelector('.unit');
    if (!input || !unit) return;
    const reserved = parseFloat(getComputedStyle(input).paddingRight);
    const needed = unit.getBoundingClientRect().width + 6;
    if (reserved < needed) {
      collisions.push({
        el: '#' + input.id,
        unit: unit.textContent.trim(),
        reserved: Math.round(reserved),
        needed: Math.round(needed),
      });
    }
  });

  /* The ledger has two legitimate shapes: a table that fits, and label:value
     cards. What it must never be is a table that does not fit - that clips
     운행사유 mid-glyph and hides 인원, 주유금액 and the delete button behind a
     horizontal scroll with no affordance.

     The overflow scan above cannot see this. .table-wrapper scrolls, so it
     absorbs the spill and the page stays the right width: every check passes
     while the ledger is visibly broken. This compares what the table needs
     against the room it has, but only while it is still a table. */
  const wrap = document.querySelector('.table-wrapper');
  const table = document.querySelector('.log-table');
  let ledger = null;
  if (wrap && table && table.querySelector('tbody tr')) {
    const cardMode = getComputedStyle(table).display === 'block';
    ledger = {
      cardMode: cardMode,
      needs: table.scrollWidth,
      has: wrap.clientWidth,
      clipped: !cardMode && wrap.scrollWidth > wrap.clientWidth + 1,
    };
  }

  return {
    docWidth: docWidth,
    pageScrollWidth: document.documentElement.scrollWidth,
    offenders: bad,
    chain: chain,
    ledger: ledger,
    collisions: collisions,
  };
};

/**
 * Contrast and hit-target audit.
 *
 * Both thresholds come from WCAG 2.2 level AA: 4.5:1 for body text (3:1 once
 * it is large), and 24x24 CSS px for anything you have to hit. A control can
 * look fine in a screenshot and still fail either one, which is the point of
 * measuring rather than eyeballing.
 */
const AUDIT_A11Y = function () {
  const parse = function (c) {
    const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
    return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null;
  };

  const lum = function (rgb) {
    const f = rgb.slice(0, 3).map(function (v) {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
  };

  const over = function (fg, bg) {
    const a = fg[3];
    return [0, 1, 2].map(function (i) { return fg[i] * a + bg[i] * (1 - a); }).concat(1);
  };

  // The nearest ancestor that actually paints something.
  const bgOf = function (el) {
    for (let p = el; p; p = p.parentElement) {
      const c = parse(getComputedStyle(p).backgroundColor);
      if (c && c[3] > 0) return c[3] === 1 ? c : over(c, bgOf(p.parentElement || document.body));
    }
    return [255, 255, 255, 1];
  };

  const ratio = function (a, b) {
    const l1 = lum(a);
    const l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };

  const label = function (el) {
    return el.tagName.toLowerCase() +
      (el.id ? '#' + el.id : '') +
      (el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\s+/).join('.') : '');
  };

  const lowContrast = [];
  const smallTargets = [];
  // Every measurement, kept so a run can be spot-checked. A contrast test that
  // silently measures nothing reports a clean sheet, which is worse than no
  // test at all - AUDIT_VERBOSE=1 prints the tightest ratios to prove it looked.
  const measured = [];
  const wideFields = [];
  const seenC = new Set();
  const seenT = new Set();
  const seenW = new Set();

  document.querySelectorAll('body *').forEach(function (el) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden') return;

    // Contrast: only elements that render their own text.
    const own = Array.prototype.filter.call(el.childNodes, function (n) {
      return n.nodeType === 3 && n.textContent.trim();
    });
    if (own.length) {
      const fg = parse(cs.color);
      if (fg) {
        const bg = bgOf(el);
        const got = ratio(fg[3] < 1 ? over(fg, bg) : fg, bg);
        const size = parseFloat(cs.fontSize);
        const bold = parseInt(cs.fontWeight, 10) >= 700;
        const large = size >= 24 || (bold && size >= 18.66);
        const need = large ? 3 : 4.5;
        const key = label(el);
        measured.push({ el: key, ratio: Math.round(got * 100) / 100, need: need });
        if (got < need && !seenC.has(key)) {
          seenC.add(key);
          lowContrast.push({
            el: key,
            text: own.map(function (n) { return n.textContent.trim(); }).join(' ').slice(0, 24),
            ratio: Math.round(got * 100) / 100,
            need: need,
          });
        }
      }
    }

    // Fields stretched past readable width. Nothing overflows and nothing is
    // clipped, so the layout checks stay quiet, but a 1,190px box holding
    // "09:00" drags the eye a screen away from its own label. 560 is the same
    // reasoning as a line-length limit, not a spec number.
    const t = el.tagName.toLowerCase();
    if ((t === 'input' || t === 'select') && el.type !== 'hidden' && r.width > 560) {
      const key = label(el);
      if (!seenW.has(key)) {
        seenW.add(key);
        wideFields.push({ el: key, width: Math.round(r.width) });
      }
    }

    // Hit targets.
    const tag = el.tagName.toLowerCase();
    const hit = tag === 'button' || tag === 'select' || tag === 'a' ||
      (tag === 'input' && el.type !== 'hidden') || el.getAttribute('role') === 'button';
    if (hit && (r.width < 24 || r.height < 24)) {
      const key = label(el);
      if (!seenT.has(key)) {
        seenT.add(key);
        smallTargets.push({ el: key, size: Math.round(r.width) + 'x' + Math.round(r.height) });
      }
    }
  });

  measured.sort(function (a, b) { return a.ratio - b.ratio; });
  return {
    lowContrast: lowContrast,
    smallTargets: smallTargets,
    wideFields: wideFields,
    measuredCount: measured.length,
    tightest: measured.slice(0, 8),
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
    if (s.fill) {
      for (const [sel, value] of Object.entries(s.fill)) {
        await page.focus(sel);
        await page.type(sel, value);
      }
    }
    let csv = null;
    if (s.exportCsv) {
      // Capture what the download would contain instead of letting the browser
      // save it: the blob is the artefact under test, not the file on disk.
      await page.evaluate(function () {
        const orig = URL.createObjectURL.bind(URL);
        URL.createObjectURL = function (blob) { window.__blob = blob; return orig(blob); };
        HTMLAnchorElement.prototype.click = function () {};
      });
      await page.click('#exportCsv');
      // Read the bytes, not Blob.text(): the UTF-8 decode algorithm strips a
      // leading BOM, so text() reports a file without one as identical to a
      // file with one - and the BOM is precisely what is being checked.
      csv = await page.evaluate(async function () {
        if (!window.__blob) return null;
        const bytes = new Uint8Array(await window.__blob.arrayBuffer());
        return {
          bom: bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF,
          text: new TextDecoder('utf-8').decode(bytes),
        };
      });
    }

    let rejection = null;
    if (s.submitEmpty) {
      await page.click('button[type=submit]');
      // Long enough for the smooth scroll to settle before measuring.
      await new Promise(function (r) { setTimeout(r, 900); });

      // A rejected submit must land the driver on the field at fault, not just
      // print a message under a form three screens tall.
      rejection = await page.evaluate(function () {
        const el = document.querySelector('[aria-invalid="true"]');
        if (!el) return { marked: false };
        const r = el.getBoundingClientRect();
        return {
          marked: true,
          field: el.id || el.tagName.toLowerCase(),
          focused: document.activeElement === el,
          inView: r.top >= 0 && r.bottom <= document.documentElement.clientHeight,
        };
      });
    }

    const result = await page.evaluate(FIND_OVERFLOW);
    const a11y = await page.evaluate(AUDIT_A11Y);
    await page.screenshot({ path: path.join(SHOTS, s.name + '.png'), fullPage: true });

    report.push({
      scenario: s.name,
      viewport: s.viewport.width + 'x' + s.viewport.height,
      ...result,
      ...a11y,
      rejection: rejection,
      csv: csv,
    });
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
    const rj = r.rejection;
    const rejectionOk = !rj || (rj.marked && rj.focused && rj.inView);
    const clipped = r.ledger && r.ledger.clipped;

    // The export is checked against what it has to survive: Excel needs the
    // BOM, RFC 4180 needs commas and quotes escaped, and no record may vanish.
    const csvProblems = [];
    if (r.csv) {
      const lines = r.csv.text.split('\r\n').filter(Boolean);
      const quoted = '"광양시청, 별관 ""3층"""';
      if (!r.csv.bom) csvProblems.push('UTF-8 BOM 없음 - 엑셀에서 한글이 깨진다');
      if (!lines[0] || lines[0].indexOf('기록ID') === -1) csvProblems.push('헤더 행 없음');
      if (lines.length !== 13) csvProblems.push('데이터 ' + (lines.length - 1) + '행, 기대 12행');
      if (r.csv.text.indexOf(quoted) === -1) csvProblems.push('쉼표/따옴표가 RFC 4180대로 인용되지 않음');
    } else if (r.scenario.indexOf('csv') !== -1) {
      csvProblems.push('내보내기가 아무것도 만들지 않았다');
    }

    const ok = real.length === 0 && !wider && !clipped &&
      r.lowContrast.length === 0 && r.smallTargets.length === 0 &&
      r.wideFields.length === 0 && r.collisions.length === 0 &&
      csvProblems.length === 0 && rejectionOk;
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
    for (const c of csvProblems) console.log('  csv: ' + c);
    for (const c of r.lowContrast) {
      console.log('  contrast ' + c.ratio + ':1 (needs ' + c.need + ')  ' + c.el + '  "' + c.text + '"');
    }
    for (const t of r.smallTargets) {
      console.log('  hit target ' + t.size + ' (needs 24x24)  ' + t.el);
    }
    for (const c of r.collisions || []) {
      console.log('  unit "' + c.unit + '" needs ' + c.needed +
        'px reserved, has ' + c.reserved + 'px  ' + c.el);
    }
    for (const w of r.wideFields) {
      console.log('  field ' + w.width + 'px wide (max 560)  ' + w.el);
    }
    if (r.ledger) {
      console.log('  ledger: ' + (r.ledger.cardMode ? 'cards' : 'table') +
        ', needs ' + r.ledger.needs + 'px, has ' + r.ledger.has + 'px' +
        (r.ledger.clipped ? '  <-- CLIPPED, columns hidden behind a scroll' : ''));
    }
    if (rj) {
      console.log('  rejected submit -> ' + (rj.marked
        ? 'field ' + rj.field + ', focused=' + rj.focused + ', in view=' + rj.inView
        : 'NO FIELD MARKED (message only)'));
    }
    if (process.env.AUDIT_VERBOSE) {
      console.log('  measured ' + r.measuredCount + ' text nodes; tightest:');
      for (const m of r.tightest) {
        console.log('    ' + String(m.ratio).padStart(6) + ':1 (needs ' + m.need + ')  ' + m.el);
      }
    }
    if (wider || real.length) {
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
