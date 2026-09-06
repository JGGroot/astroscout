/* Dependency-free, live browser integration check for Bruncu Spina.
 * Requires network access and a local Chromium/Edge installation. */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
const PORT = 8911;
const DEBUG_PORT = 9311;
const profile = path.join(ROOT, 'test', '.bruncu-browser-profile');
const mapShot = path.join(ROOT, 'test', 'shots', 'bruncu-spina-satellite.png');
const povShot = path.join(ROOT, 'test', 'shots', 'bruncu-spina-pov.png');
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const LIVE_URL = process.env.ASTROSCOUT_URL || '';
const server = LIVE_URL ? null : createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${PORT}`).pathname);
    const file = path.resolve(ROOT, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(ROOT)) throw new Error('outside root');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
if (server) await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve));
await rm(profile, { recursive: true, force: true });
await mkdir(profile, { recursive: true });

// Deliberately omit both view and satellite flags: this verifies the real defaults.
const url = LIVE_URL || `http://127.0.0.1:${PORT}/index.html?lat=40.01601&lon=9.30192&name=Bruncu%20Spina,%20Sardinia&quality=fast`;
const browser = spawn(edge, [
  '--headless=new', '--no-sandbox', '--hide-scrollbars', '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1440,900', url
], { stdio: 'ignore', windowsHide: true });

let socket;
try {
  let target;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then(r => r.json());
      target = list.find(item => item.type === 'page' && item.url.includes('Bruncu'));
    } catch { /* browser is starting */ }
    if (!target) await sleep(250);
  }
  if (!target) throw new Error('Could not attach to the headless browser');

  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++; pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

  await send('Runtime.enable');
  await send('Page.enable');
  const expression = `(() => {
    const a = window.app;
    if (!a) return null;
    return {
      ready: !!a.mesh && !!a.imageryReady && a.mode === 'aerial' && a.aerialView === 'map',
      loading: !!a._loading || !!a._imageryLoading,
      baseElev: a.mesh ? Math.round(a.mesh.baseElev) : null,
      vertices: a.mesh ? a.mesh.nVerts : 0,
      radiusKm: a.mesh ? Math.round(a.mesh.rMax / 1000) : 0,
      imageryReady: !!a.imageryReady,
      mode: a.mode,
      view: a.aerialView,
      glError: a.renderer ? a.renderer.gl.getError() : null
    };
  })()`;
  let diagnostics;
  for (let i = 0; i < 120; i++) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true });
    diagnostics = result.result.value;
    if (diagnostics?.ready) break;
    if (diagnostics && !diagnostics.loading && i > 5) break;
    await sleep(1000);
  }
  if (!diagnostics?.ready) throw new Error(`Scene did not become ready: ${JSON.stringify(diagnostics)}`);
  if (Math.abs(diagnostics.baseElev - 1828) > 80) throw new Error(`Implausible summit elevation: ${diagnostics.baseElev} m`);
  if (diagnostics.glError !== 0) throw new Error(`WebGL error: ${diagnostics.glError}`);
  diagnostics.defaultView = '2D top-down map';

  const transitionCheck = await send('Runtime.evaluate', {
    expression: `(() => {
      const a = window.app, states = [];
      document.querySelector('#btnAerial').click(); states.push([a.mode, a.aerialView, document.querySelector('#btnAerial').classList.contains('on')]);
      document.querySelector('#btnPOV').click(); states.push([a.mode, document.querySelector('#btnPOV').classList.contains('on')]);
      document.querySelector('#btnMap').click(); states.push([a.mode, a.aerialView, document.querySelector('#btnMap').classList.contains('on')]);
      return states;
    })()`,
    returnByValue: true
  });
  const transitions = transitionCheck.result.value;
  const expected = JSON.stringify([['aerial', 'orbit', true], ['eye', true], ['aerial', 'map', true]]);
  if (JSON.stringify(transitions) !== expected) throw new Error(`View transition failure: ${JSON.stringify(transitions)}`);
  diagnostics.transitions = 'map → orbit → POV → map';

  const fallbackCheck = await send('Runtime.evaluate', {
    expression: `(() => {
      const a = window.app;
      const saved = { mesh: a.mesh, dem: a.dem, fallback: a.terrainFallback };
      a.mode = 'eye'; a.mesh = null; a.dem = null; a.terrainFallback = false; a._loading = true;
      document.querySelector('#btnAerial').click();
      const explore = [a.mode, a.aerialView, !!a.mesh, a.terrainFallback];
      document.querySelector('#btnMap').click();
      const map = [a.mode, a.aerialView, !!a.mesh, a.terrainFallback];
      a.mesh = saved.mesh; a.dem = saved.dem; a.terrainFallback = saved.fallback; a._loading = false;
      a.renderer.setTerrain(saved.mesh); a.setViewMode('map');
      return { explore, map };
    })()`,
    returnByValue: true
  });
  const fallback = fallbackCheck.result.value;
  if (JSON.stringify(fallback) !== JSON.stringify({ explore: ['aerial', 'orbit', true, true], map: ['aerial', 'map', true, true] }))
    throw new Error(`Offline navigation failure: ${JSON.stringify(fallback)}`);
  diagnostics.offlineNavigation = 'Explore and Map respond before elevation is available';

  await send('Runtime.evaluate', {
    expression: `(() => { app.setViewMode('pov'); app.view.az = 148.8; app.view.alt = 1.5; app.S.contextZoom = 1; app.invalidate(); })()`
  });
  await sleep(1800);
  const povCapture = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(povShot, Buffer.from(povCapture.data, 'base64'));

  await send('Runtime.evaluate', { expression: `app.setViewMode('map')` });
  await sleep(1200);
  const capture = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(mapShot, Buffer.from(capture.data, 'base64'));

  const viewpointCheck = await send('Runtime.evaluate', {
    expression: `(async () => {
      const a = window.app;
      a.pickAt(innerWidth * 0.58, innerHeight * 0.43);
      if (!a.pick) return { picked: false };
      const selected = { lat: a.pick.lat, lon: a.pick.lon, elev: a.pick.elev };
      await a.viewFromHere();
      return {
        picked: true, selected,
        mode: a.mode,
        lat: a.S.lat, lon: a.S.lon,
        povButton: document.querySelector('#btnPOV').classList.contains('on')
      };
    })()`,
    awaitPromise: true,
    returnByValue: true
  });
  const viewpoint = viewpointCheck.result.value;
  if (!viewpoint?.picked || viewpoint.mode !== 'eye' || !viewpoint.povButton ||
      Math.abs(viewpoint.lat - viewpoint.selected.lat) > 1e-7 ||
      Math.abs(viewpoint.lon - viewpoint.selected.lon) > 1e-7) {
    throw new Error(`Map-to-POV selection failure: ${JSON.stringify(viewpoint)}`);
  }
  diagnostics.mapToPOV = `selected ${viewpoint.selected.lat.toFixed(5)}, ${viewpoint.selected.lon.toFixed(5)} at ${viewpoint.selected.elev.toFixed(0)} m`;
  console.log(JSON.stringify(diagnostics, null, 2));
  console.log(`PASS · Bruncu Spina POV, orbit, and satellite map rendered · ${povShot}`);
} finally {
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  browser.kill();
  server?.close();
  await Promise.race([
    new Promise(resolve => browser.once('exit', resolve)),
    sleep(2500)
  ]);
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
}
