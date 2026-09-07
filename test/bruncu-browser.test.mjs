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
const osmShot = path.join(ROOT, 'test', 'shots', 'bruncu-spina-osm-layers.png');
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
      ready: !!a.mesh && !a.terrainFallback && !!a.imageryReady && a.mode === 'aerial' && a.aerialView === 'map',
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

  await send('Runtime.evaluate', { expression: `(() => { app.ui.closeSheet(); app.ui.openSheet('layers'); })()` });
  await sleep(400);
  const layerPanelStart = (await send('Runtime.evaluate', {
    expression: `(() => {
      const body = document.querySelector('#sheetBody'); body.scrollTop = 0;
      const r = body.getBoundingClientRect();
      window.__layerWheel = null;
      body.addEventListener('wheel', e => { window.__layerWheel = { prevented: e.defaultPrevented, target: e.target.className }; }, { once: true });
      return { tab: app.ui.tab, cards: body.querySelectorAll('.layer-card').length,
        ranges: body.querySelectorAll('input[type=range]').length,
        scrollHeight: body.scrollHeight, clientHeight: body.clientHeight,
        sheetClass: document.querySelector('#sheet').className,
        innerWidth, dpr: devicePixelRatio, rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
        x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 220), dist: app.orbit.dist,
        scoutHidden: document.querySelector('#scoutbar').hidden };
    })()`, returnByValue: true
  })).result.value;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: layerPanelStart.x, y: layerPanelStart.y, button: 'none', buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: layerPanelStart.x, y: layerPanelStart.y, deltaX: 0, deltaY: 320 });
  await sleep(250);
  const layerPanelEnd = (await send('Runtime.evaluate', {
    expression: `(() => {
      const body = document.querySelector('#sheetBody'), nativeScrollTop = body.scrollTop;
      body.scrollTop = 100;
      return { nativeScrollTop, canScroll: body.scrollTop === 100, dist: app.orbit.dist, wheel: window.__layerWheel };
    })()`,
    returnByValue: true
  })).result.value;
  await send('Runtime.evaluate', { expression: `app.ui.closeSheet()` });
  if (layerPanelStart.tab !== 'layers' || layerPanelStart.cards < 4 || layerPanelStart.ranges !== 0 ||
      layerPanelStart.scrollHeight <= layerPanelStart.clientHeight || !layerPanelEnd.canScroll ||
      !layerPanelEnd.wheel || layerPanelEnd.wheel.prevented ||
      layerPanelEnd.dist !== layerPanelStart.dist || !layerPanelStart.scoutHidden) {
    throw new Error(`Layers panel failure: ${JSON.stringify({ layerPanelStart, layerPanelEnd })}`);
  }
  diagnostics.layersPanel = 'dedicated layer manager scrolls without zooming · viewpoint card stays hidden until selection';

  const osmCheck = await send('Runtime.evaluate', {
    expression: `(async () => {
      await app.setOSMLayer('roads', true);
      await app.setOSMLayer('pois', true);
      const result = {
        roads: app.osmData?.roads.length || 0,
        pois: app.osmData?.pois.length || 0,
        roadGeometry: app.renderer.worldLines.has('osm-roads'),
        poiGeometry: app.renderer.worldLines.has('osm-poi-pins'),
        markers: app.poiMarkers.length,
        attribution: !document.querySelector('#osmAttribution').hidden
      };
      return result;
    })()`,
    awaitPromise: true,
    returnByValue: true
  });
  const osm = osmCheck.result.value;
  if (!osm?.roads || !osm?.pois || !osm.roadGeometry || !osm.poiGeometry || !osm.markers || !osm.attribution) {
    throw new Error(`OSM overlay failure: ${JSON.stringify(osm)}`);
  }
  diagnostics.osm = `${osm.roads} roads · ${osm.pois} POIs · terrain geometry and attribution present`;

  const interfaceCheck = await send('Runtime.evaluate', {
    expression: `(async () => {
      const a = window.app, S = a.S;
      S.showSun = false; S.showMoon = false; a.recompute();
      const hiddenBodies = !a.bodies.some(b => b.kind === 'sun' || b.kind === 'moon') &&
        !a.labels.some(l => l.text.startsWith('Sun') || l.text.startsWith('Moon'));
      S.showDarknessChip = false; S.showTimeline = false; S.showSceneStatus = false; S.showHints = false;
      a.syncInterfaceChrome();
      const hiddenChrome = document.querySelector('.timeline-wrap').hidden &&
        document.querySelector('.dock-status').hidden && document.querySelector('#sceneHint').hidden &&
        !document.querySelector('#chips').textContent.toLowerCase().includes('sun');
      a.ui.openSheet('where');
      const searchUI = document.querySelector('.searchbar button')?.textContent === 'Search' &&
        document.querySelector('.searchbar input')?.placeholder.includes('viewpoints');
      const coord = await a.geocode('40.01601, 9.30192');
      a.ui.closeSheet();
      S.showSun = true; S.showMoon = true; S.showDarknessChip = true;
      S.showTimeline = true; S.showSceneStatus = true; S.showHints = true;
      a.recompute(); a.syncInterfaceChrome();
      return { hiddenBodies, hiddenChrome, searchUI, coordinateSearch: coord[0] };
    })()`,
    awaitPromise: true,
    returnByValue: true
  });
  const iface = interfaceCheck.result.value;
  if (!iface?.hiddenBodies || !iface.hiddenChrome || !iface.searchUI ||
      Math.abs(iface.coordinateSearch?.lat - 40.01601) > 1e-8 || Math.abs(iface.coordinateSearch?.lon - 9.30192) > 1e-8) {
    throw new Error(`Interface control failure: ${JSON.stringify(iface)}`);
  }
  diagnostics.interface = 'Sun, Moon, darkness, timeline, status and hints can be hidden · POI/coordinate search ready';

  await send('Runtime.evaluate', {
    expression: `(() => { app.setViewMode('orbit'); app.blend = 1; app.orbit.az = 205; app.orbit.pitch = 42; app.orbit.dist = 9500; app.invalidate(); })()`
  });
  await sleep(800);
  const osmCapture = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(osmShot, Buffer.from(osmCapture.data, 'base64'));
  await send('Runtime.evaluate', {
    expression: `(async () => { app.setViewMode('map'); await app.setOSMLayer('roads', false); await app.setOSMLayer('pois', false); })()`,
    awaitPromise: true
  });

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

  const orbitLookBefore = (await send('Runtime.evaluate', {
    expression: `(() => { app.setViewMode('orbit'); app.blend = 1; return { az: app.orbit.az, pitch: app.orbit.pitch }; })()`,
    returnByValue: true
  })).result.value;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 650, y: 330, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 710, y: 330, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 710, y: 330, button: 'left', buttons: 0, clickCount: 1 });
  const orbitLookAfter = (await send('Runtime.evaluate', {
    expression: `(() => ({ az: app.orbit.az, pitch: app.orbit.pitch }))()`, returnByValue: true
  })).result.value;
  const orbitDelta = ((orbitLookAfter.az - orbitLookBefore.az + 540) % 360) - 180;
  if (orbitDelta >= 0 || Math.abs(orbitLookAfter.pitch - orbitLookBefore.pitch) > 0.01)
    throw new Error(`Orbit desktop drag-direction failure: ${JSON.stringify({ orbitLookBefore, orbitLookAfter })}`);

  const povLookBefore = (await send('Runtime.evaluate', {
    expression: `(() => { app.setViewMode('pov'); app.blend = 0; return { az: app.view.az, alt: app.view.alt }; })()`,
    returnByValue: true
  })).result.value;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 650, y: 330, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 710, y: 330, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 710, y: 330, button: 'left', buttons: 0, clickCount: 1 });
  const povLookAfter = (await send('Runtime.evaluate', {
    expression: `(() => ({ az: app.view.az, alt: app.view.alt }))()`, returnByValue: true
  })).result.value;
  const povDelta = ((povLookAfter.az - povLookBefore.az + 540) % 360) - 180;
  if (povDelta >= 0 || Math.abs(povLookAfter.alt - povLookBefore.alt) > 0.01)
    throw new Error(`POV desktop drag-direction failure: ${JSON.stringify({ povLookBefore, povLookAfter })}`);
  diagnostics.cameraDrag = 'desktop horizontal drag restored in 3D and POV · touch remains inverted · pitch unchanged';

  const panBefore = (await send('Runtime.evaluate', {
    expression: `(() => { app.setViewMode('orbit'); app.blend = 1; app.invalidate(); return { cx: app.orbit.cx, cz: app.orbit.cz, az: app.orbit.az, pitch: app.orbit.pitch }; })()`,
    returnByValue: true
  })).result.value;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 700, y: 350, button: 'right', buttons: 2, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 780, y: 390, button: 'right', buttons: 2 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 780, y: 390, button: 'right', buttons: 0, clickCount: 1 });
  const panAfter = (await send('Runtime.evaluate', {
    expression: `(() => ({ cx: app.orbit.cx, cz: app.orbit.cz, az: app.orbit.az, pitch: app.orbit.pitch }))()`,
    returnByValue: true
  })).result.value;
  if (Math.hypot(panAfter.cx - panBefore.cx, panAfter.cz - panBefore.cz) < 10 ||
      Math.abs(panAfter.az - panBefore.az) > 0.01 || Math.abs(panAfter.pitch - panBefore.pitch) > 0.01) {
    throw new Error(`3D pan failure: ${JSON.stringify({ panBefore, panAfter })}`);
  }
  diagnostics.terrainPan = `right-drag moved ${(Math.hypot(panAfter.cx - panBefore.cx, panAfter.cz - panBefore.cz) / 1000).toFixed(2)} km without rotating`;
  await send('Runtime.evaluate', { expression: `app.setViewMode('map')` });

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
