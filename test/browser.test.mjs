import { chromium } from 'playwright';
import sharp from 'sharp';
import { spawn } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';

const PORT = 8765;
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
  { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore' });
await sleep(700);

/* ---- synthetic terrain so the whole DEM path is exercised offline ---- */
function heightAt(lat, lon) {
  // a fictional massif centred near Zermatt, with a dominant peak and ridges
  const dx = (lon - 7.7491) * Math.cos(lat * Math.PI / 180) * 111320;
  const dy = (lat - 46.0207) * 110540;
  const d = Math.hypot(dx, dy);
  let h = 1600 + 900 * Math.exp(-(((d - 9000) / 14000) ** 2));
  h += 2300 * Math.exp(-(((dx - 4000) ** 2 + (dy - 7000) ** 2) / (2 * 2600 ** 2)));  // big peak NE
  h += 1500 * Math.exp(-(((dx + 9000) ** 2 + (dy - 3000) ** 2) / (2 * 3400 ** 2)));  // massif NW
  h += 1100 * Math.exp(-(((dx - 12000) ** 2 + (dy + 9000) ** 2) / (2 * 5000 ** 2))); // ridge SE
  h += 420 * Math.sin(dx / 2600) * Math.cos(dy / 3100);
  h += 180 * Math.sin(dx / 780 + 1.3) * Math.sin(dy / 910);
  h -= 700 * Math.exp(-((d / 2600) ** 2));                                            // valley floor
  return Math.max(300, h);
}
const S = 256;
async function terrariumTile(z, x, y) {
  const n = 1 << z;
  const buf = Buffer.alloc(S * S * 3);
  for (let j = 0; j < S; j++) {
    const ty = (y + j / S) / n;
    const a = Math.PI - 2 * Math.PI * ty;
    const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(a) - Math.exp(-a)));
    for (let i = 0; i < S; i++) {
      const lon = (x + i / S) / n * 360 - 180;
      const v = heightAt(lat, lon) + 32768;
      const o = (j * S + i) * 3;
      buf[o] = Math.floor(v / 256) & 255;
      buf[o + 1] = Math.floor(v) & 255;
      buf[o + 2] = Math.floor((v % 1) * 256) & 255;
    }
  }
  return sharp(buf, { raw: { width: S, height: S, channels: 3 } }).png().toBuffer();
}
async function imageryTile(z, x, y) {
  const buf = Buffer.alloc(S * S * 3);
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const o = (j * S + i) * 3;
    const c = ((i >> 5) + (j >> 5)) % 2 ? 90 : 60;
    buf[o] = c + 20; buf[o + 1] = c + 34; buf[o + 2] = c;
  }
  return sharp(buf, { raw: { width: S, height: S, channels: 3 } }).png().toBuffer();
}

const browser = await chromium.launch({
  executablePath: undefined,
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
         '--disable-dev-shm-usage', '--no-sandbox']
});
const results = [];
async function shoot(name, { width, height, setup, act, waitMs = 1400 }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [], logs = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); else logs.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  let demCount = 0, imgCount = 0;
  await ctx.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return route.continue();
    const m = u.pathname.match(/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/);
    if (m) { demCount++; return route.fulfill({ status: 200, contentType: 'image/png', body: await terrariumTile(+m[1], +m[2], +m[3]) }); }
    const mi = u.pathname.match(/MapServer\/tile\/(\d+)\/(\d+)\/(\d+)/);
    if (mi) { imgCount++; return route.fulfill({ status: 200, contentType: 'image/png', body: await imageryTile(+mi[1], +mi[3], +mi[2]) }); }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.addInitScript(setup || (() => {}));
  await page.goto(`http://127.0.0.1:${PORT}/${process.env.PAGE || 'index.html'}`, { waitUntil: 'load' });
  await page.waitForTimeout(900);
  if (act) await act(page);
  await page.waitForTimeout(waitMs);
  const path = `test/shots/${name}.png`;
  await page.screenshot({ path });
  const diag = await page.evaluate(() => {
    const a = window.app;
    if (!a) return { fatal: 'app missing' };
    return {
      hasMesh: !!a.mesh, verts: a.mesh ? a.mesh.nVerts : 0,
      baseElev: a.mesh ? Math.round(a.mesh.baseElev) : null,
      horizonMax: a.mesh ? Math.max(...a.mesh.horizon).toFixed(2) : null,
      coreAlt: +a.coreAlt.toFixed(2), coreAz: +a.coreAz.toFixed(2),
      sunAlt: +a.sunAlt.toFixed(2), moonAlt: +a.moonAlt.toFixed(2),
      moonIllum: +a.ill.fraction.toFixed(3),
      stars: a.starList.length,
      glErr: a.renderer.gl.getError(),
      view: { az: +a.view.az.toFixed(1), alt: +a.view.alt.toFixed(1), vfov: +a.view.vfovDeg.toFixed(1) }
    };
  });
  results.push({ name, errors, diag, demCount, imgCount });
  await ctx.close();
  return { errors, diag };
}

const setLoc = (lat, lon, name, iso, extra = {}) => new Function('return ' + JSON.stringify({ lat, lon, name, iso, extra })).toString() && (function () {});

async function run() {
  const mk = (state, iso) => `() => {
    localStorage.setItem('astroscout.state.v1', ${JSON.stringify(JSON.stringify(state))});
    const D = Date; const fixed = new D('${iso}').getTime();
    class FakeDate extends D {
      constructor(...a){ if(!a.length) super(fixed); else super(...a); }
      static now(){ return fixed; }
    }
    window.Date = FakeDate;
  }`;

  const base = { lat: 46.0207, lon: 7.7491, name: 'Test massif', tzMin: 60, quality: 'fast',
    focal: 20, contextZoom: 1.4, autoTerrain: false, showGrid: false, tzMinSet: true };

  console.log('1/8 sky only, no terrain, astronomical night');
  let r = await shoot('01-sky', { width: 900, height: 640,
    setup: new Function(`return (${mk(base, '2026-08-15T22:30:00Z')})()`), });
  console.log('   ', JSON.stringify(r.diag));
  if (r.errors.length) console.log('    ERRORS:', r.errors.slice(0, 5));

  console.log('2/8 terrain loaded, core over the ridge');
  r = await shoot('02-terrain', { width: 900, height: 640,
    setup: new Function(`return (${mk(base, '2026-08-15T22:30:00Z')})()`),
    act: async p => { await p.evaluate(() => window.app.loadTerrain()); await p.waitForTimeout(6000);
      await p.evaluate(() => { window.app.lookAtCore(); window.app.view.alt = 14; }); },
    waitMs: 2200 });
  console.log('   ', JSON.stringify(r.diag));
  if (r.errors.length) console.log('    ERRORS:', r.errors.slice(0, 5));

  console.log('3/8 twilight with the moon up');
  r = await shoot('03-twilight', { width: 900, height: 640,
    setup: new Function(`return (${mk(Object.assign({}, base, {focal:14}), '2026-08-22T19:05:00Z')})()`),
    act: async p => { await p.evaluate(() => window.app.loadTerrain()); await p.waitForTimeout(6000);
      await p.evaluate(() => { window.app.view.az = 250; window.app.view.alt = 10; }); },
    waitMs: 2000 });
  console.log('   ', JSON.stringify(r.diag));
  if (r.errors.length) console.log('    ERRORS:', r.errors.slice(0, 5));

  console.log('4/8 phone portrait, plan sheet open');
  r = await shoot('04-phone', { width: 390, height: 844,
    setup: new Function(`return (${mk(base, '2026-08-15T23:10:00Z')})()`),
    act: async p => { await p.evaluate(() => window.app.loadTerrain()); await p.waitForTimeout(6000);
      await p.evaluate(() => window.app.lookAtCore());
      await p.click('.tab[data-tab="plan"]'); },
    waitMs: 1600 });
  console.log('   ', JSON.stringify(r.diag));
  if (r.errors.length) console.log('    ERRORS:', r.errors.slice(0, 5));

  console.log('5/8 southern hemisphere, core overhead, imagery on');
  r = await shoot('05-south', { width: 900, height: 640,
    setup: new Function(`return (${mk(Object.assign({}, base, {lat:-25.3444, lon:131.0369, name:'Uluru', tzMin:570, useImagery:true, focal:24}), '2026-07-10T13:30:00Z')})()`),
    act: async p => { await p.evaluate(() => window.app.loadTerrain()); await p.waitForTimeout(7000);
      await p.evaluate(() => { window.app.view.az = 180; window.app.view.alt = 40; }); },
    waitMs: 2200 });
  console.log('   ', JSON.stringify(r.diag));
  if (r.errors.length) console.log('    ERRORS:', r.errors.slice(0, 5));

  console.log('6/8 daylight');
  r = await shoot('06-day', { width: 900, height: 640,
    setup: new Function(`return (${mk(base, '2026-08-15T10:00:00Z')})()`),
    act: async p => { await p.evaluate(() => window.app.loadTerrain()); await p.waitForTimeout(6000);
      await p.evaluate(() => { window.app.view.az = 200; window.app.view.alt = 8; window.app.S.contextZoom = 1.0; }); },
    waitMs: 2000 });
  console.log('   ', JSON.stringify(r.diag));
  if (r.errors.length) console.log('    ERRORS:', r.errors.slice(0, 5));
  console.log('7/8 aerial scout view with imagery');
  r = await shoot('07-scout', { width: 900, height: 640,
    setup: new Function(`return (${mk(Object.assign({}, base, {useImagery:true, quality:'fast'}), '2026-08-15T20:40:00Z')})()`),
    act: async p => {
      await p.evaluate(() => window.app.loadTerrain()); await p.waitForTimeout(7000);
      await p.evaluate(() => window.app.loadImagery()); await p.waitForTimeout(4000);
      await p.evaluate(() => {
        const a = window.app;
        a.toggleAerial(true);
        a.orbit.az = 25; a.orbit.pitch = 32; a.orbit.dist = 11000;
        a.blend = 1;
      });
      await p.waitForTimeout(900);
      // tap somewhere on the ground toward the peak
      await p.mouse.click(560, 300);
    },
    waitMs: 1800 });
  console.log('   ', JSON.stringify(r.diag));
  if (r.errors.length) console.log('    ERRORS:', r.errors.slice(0, 5));

  console.log('8/8 scout -> stand here -> back to eye level');
  r = await shoot('08-standhere', { width: 900, height: 640,
    setup: new Function(`return (${mk(Object.assign({}, base, {quality:'fast'}), '2026-08-15T21:20:00Z')})()`),
    act: async p => {
      await p.evaluate(() => window.app.loadTerrain()); await p.waitForTimeout(7000);
      await p.evaluate(() => {
        const a = window.app;
        a.toggleAerial(true); a.blend = 1;
        a.orbit.az = 30; a.orbit.pitch = 30; a.orbit.dist = 9000;
      });
      await p.waitForTimeout(700);
      await p.mouse.click(520, 330);
      await p.waitForTimeout(500);
      const moved = await p.evaluate(async () => {
        const a = window.app;
        if (!a.pick) return { picked: false };
        const before = a.mesh.baseElev;
        const t0 = performance.now();
        await a.standHere();
        return { picked: true, before, after: a.mesh.baseElev, ms: Math.round(performance.now() - t0) };
      });
      console.log('    move:', JSON.stringify(moved));
      await p.evaluate(() => { window.app.toggleAerial(false); window.app.blend = 0; window.app.lookAtCore(); });
    },
    waitMs: 1800 });
  console.log('   ', JSON.stringify(r.diag));
  if (r.errors.length) console.log('    ERRORS:', r.errors.slice(0, 5));
}

try { await run(); } finally {
  await browser.close(); server.kill();
}
const allErr = results.flatMap(r => r.errors);
console.log(`\n${results.length} scenes rendered, ${allErr.length} console errors`);
if (allErr.length) console.log(allErr.slice(0, 12).join('\n'));
