/* ui.js — panels, the night timeline, and the heads-up overlay. */
import * as A from './astro.js';
import * as P from './planner.js';
import { PRESETS, SKY_QUALITY, LENSES } from './presets.js';
import { DEM_SOURCES, IMAGERY_SOURCES, cacheStats, cacheClear, haversine, bearing, probeSources } from './terrain.js';

const $ = s => document.querySelector(s);
const el = (t, cls, txt) => { const e = document.createElement(t); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

export class UI {
  constructor(app) {
    this.app = app;
    this.sheet = $('#sheet'); this.body = $('#sheetBody'); this.title = $('#sheetTitle');
    this.tab = null;
    this.tl = $('#timeline'); this.tlx = this.tl.getContext('2d');
    this.hud = $('#hud'); this.hx = this.hud.getContext('2d');
    this.bindStatic();
  }

  bindStatic() {
    const app = this.app;
    document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => this.openSheet(t.dataset.tab)));
    $('#sheetClose').addEventListener('click', () => this.closeSheet());
    $('#btnNow').addEventListener('click', () => { app.setDate(new Date()); this.refresh(); });
    $('#btnPlay').addEventListener('click', () => { app.togglePlay(); this.refresh(); });
    $('#btnDark').addEventListener('click', () => app.jumpToBest());
    $('#btnAR').addEventListener('click', () => app.toggleOrientation());
    $('#btnPOV').addEventListener('click', () => app.setViewMode('pov'));
    $('#btnAerial').addEventListener('click', () => app.setViewMode('orbit'));
    $('#btnMap').addEventListener('click', () => app.setViewMode('map'));
    $('#btnSatellite').addEventListener('click', () => app.toggleSatellite());
    $('#btnLayers').addEventListener('click', () => this.openSheet('layers'));
    $('#btnPlanner').addEventListener('click', () => this.openSheet('plan'));
    $('#btnLocation').addEventListener('click', () => this.openSheet('where'));
    $('#scoutStand').addEventListener('click', () => app.viewFromHere());
    $('#scoutBack').addEventListener('click', () => app.toggleAerial(false));
    $('#btnNorth').addEventListener('click', () => app.lookAtCore());

    // timeline scrubbing
    let drag = false;
    const toTime = ev => {
      const r = this.tl.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      const s = app.night; if (!s) return;
      app.setJD(s.t[0] + f * (s.t[s.n - 1] - s.t[0]));
      this.refresh();
    };
    this.tl.addEventListener('pointerdown', e => { drag = true; this.tl.setPointerCapture(e.pointerId); toTime(e); });
    this.tl.addEventListener('pointermove', e => { if (drag) toTime(e); });
    this.tl.addEventListener('pointerup', () => drag = false);
    this.tl.addEventListener('pointercancel', () => drag = false);
  }

  toast(msg, ms = 2600) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(this._tt); this._tt = setTimeout(() => t.classList.remove('show'), ms);
  }
  progress(f) { $('#prog').style.width = (f == null ? 0 : Math.round(f * 100)) + '%'; }

  openSheet(tab) {
    if (this.tab === tab && !this.sheet.hidden) return this.closeSheet();
    this.tab = tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === tab));
    $('#btnLayers').classList.toggle('panel-open', tab === 'layers');
    this.sheet.hidden = false;
    this.sheet.classList.add('open');
    this.renderSheet();
  }
  closeSheet() {
    this.sheet.classList.remove('open'); this.sheet.hidden = true; this.tab = null;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('on'));
    $('#btnLayers').classList.remove('panel-open');
  }

  /* ---------- sheet contents ---------- */
  renderSheet() {
    const b = this.body; b.innerHTML = '';
    const titles = { where: 'Location', when: 'Time', camera: 'Camera', plan: 'Plan the night', layers: 'Layers', sky: 'Display settings', about: 'About' };
    this.title.textContent = titles[this.tab] || '';
    ({ where: () => this.panelWhere(b), when: () => this.panelWhen(b), camera: () => this.panelCamera(b),
       plan: () => this.panelPlan(b), layers: () => this.panelLayers(b), sky: () => this.panelSky(b), about: () => this.panelAbout(b) }[this.tab] || (() => {}))();
  }

  row(parent, label, ctrl) {
    const r = el('div', 'row'); r.appendChild(el('label', null, label));
    const w = el('div'); w.style.flex = '1'; w.appendChild(ctrl); r.appendChild(w);
    parent.appendChild(r); return r;
  }
  toggle(parent, label, get, set) {
    const r = el('div', 'row'); r.appendChild(el('label', null, label));
    const sw = el('div', 'switch' + (get() ? ' on' : ''));
    sw.setAttribute('role', 'switch'); sw.setAttribute('aria-label', label); sw.tabIndex = 0;
    const flip = () => {
      set(!get()); sw.classList.toggle('on', get());
      sw.setAttribute('aria-checked', get() ? 'true' : 'false');
      this.app.invalidate();
    };
    sw.setAttribute('aria-checked', get() ? 'true' : 'false');
    sw.addEventListener('click', flip);
    sw.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault(); flip();
    });
    r.appendChild(sw); parent.appendChild(r); return sw;
  }
  slider(parent, label, min, max, step, get, set, fmt = v => v.toFixed(2)) {
    const r = el('div', 'row'); r.appendChild(el('label', null, label));
    const wrap = el('div'); wrap.style.flex = '1';
    const i = el('input'); i.type = 'range'; i.min = min; i.max = max; i.step = step; i.value = get();
    const v = el('div', 'val', fmt(+get())); v.style.fontSize = '11px'; v.style.textAlign = 'right';
    i.addEventListener('input', () => { set(+i.value); v.textContent = fmt(+i.value); this.app.invalidate(); });
    wrap.appendChild(i); r.appendChild(wrap); r.appendChild(v); parent.appendChild(r);
  }

  panelWhere(b) {
    const app = this.app, S = app.S;
    const searchbar = el('div', 'searchbar');
    const search = el('input'); search.type = 'search'; search.placeholder = 'Peaks, viewpoints, cafés, addresses…';
    search.autocomplete = 'off'; search.setAttribute('aria-label', 'Search places and points of interest');
    const searchBtn = el('button', 'btn primary', 'Search');
    searchbar.append(search, searchBtn);
    const sr = el('ul', 'list'); sr.style.maxHeight = '190px'; sr.style.overflowY = 'auto';
    const runSearch = async () => {
      const q = search.value.trim();
      if (q.length < 2) { this.toast('Enter at least two characters'); search.focus(); return; }
      searchBtn.disabled = true; searchBtn.textContent = 'Searching…';
      sr.innerHTML = '<li class="search-state">Searching OpenStreetMap…</li>';
      const hits = await app.geocode(q);
      searchBtn.disabled = false; searchBtn.textContent = 'Search'; sr.innerHTML = '';
      if (!hits.length) { sr.innerHTML = '<li class="search-state">No matches. Try a POI type, full address, or coordinates.</li>'; return; }
      for (const h of hits) {
        const li = el('li', 'search-result');
        const copy = el('div', 'result-copy');
        copy.appendChild(el('div', 'n', h.name));
        copy.appendChild(el('div', 'result-detail', h.detail || `${h.lat.toFixed(4)}, ${h.lon.toFixed(4)}`));
        li.appendChild(copy);
        const meta = el('div', 'result-meta');
        meta.appendChild(el('span', 'result-kind', (h.kind || 'place').replaceAll('_', ' ')));
        meta.appendChild(el('span', 'result-coords', `${h.lat.toFixed(3)}, ${h.lon.toFixed(3)}`));
        li.appendChild(meta); li.tabIndex = 0;
        const choose = () => { app.setLocation(h.lat, h.lon, h.name); this.renderSheet(); };
        li.addEventListener('click', choose);
        li.addEventListener('keydown', e => { if (e.key === 'Enter') choose(); });
        sr.appendChild(li);
      }
    };
    searchBtn.addEventListener('click', runSearch);
    search.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } });
    b.appendChild(searchbar); b.appendChild(sr);
    const searchNote = el('p', 'hint search-note');
    searchNote.append('Searches places and POIs via ');
    const osmLink = el('a', null, 'OpenStreetMap');
    osmLink.href = 'https://www.openstreetmap.org/copyright'; osmLink.target = '_blank'; osmLink.rel = 'noopener';
    searchNote.append(osmLink, '. Results are biased toward the current map area; coordinates also work.');
    b.appendChild(searchNote);

    const cr = el('div', 'grid2'); cr.style.marginTop = '8px';
    const la = el('input'); la.type = 'number'; la.step = '0.00001'; la.value = S.lat.toFixed(5);
    const lo = el('input'); lo.type = 'number'; lo.step = '0.00001'; lo.value = S.lon.toFixed(5);
    cr.appendChild(la); cr.appendChild(lo); b.appendChild(cr);
    const br = el('div', 'btnrow');
    const go = el('button', 'btn primary', 'Go to coordinates');
    go.addEventListener('click', () => { app.setLocation(+la.value, +lo.value, `${(+la.value).toFixed(4)}, ${(+lo.value).toFixed(4)}`); this.renderSheet(); });
    const gps = el('button', 'btn', '📍 Use my location');
    gps.addEventListener('click', () => app.useGPS());
    br.appendChild(go); br.appendChild(gps); b.appendChild(br);

    b.appendChild(el('h3', 'sec', 'Terrain'));
    const q = el('div', 'grid3');
    for (const k of ['fast', 'balanced', 'max']) {
      const p = el('div', 'pill' + (S.quality === k ? ' on' : ''), k);
      p.addEventListener('click', () => { S.quality = k; app.save(); this.renderSheet(); });
      q.appendChild(p);
    }
    b.appendChild(q);
    const lb = el('div', 'btnrow');
    const load = el('button', 'btn primary wide', S.terrainLoaded ? 'Reload terrain here' : 'Load terrain here');
    load.addEventListener('click', () => app.loadTerrain());
    lb.appendChild(load); b.appendChild(lb);
    this.toggle(b, 'Satellite imagery on terrain', () => S.useImagery, v => { S.useImagery = v; app.save(); if (v) app.loadImagery(); });
    const hint = el('p', 'hint', S.terrainLoaded
      ? `Loaded: ${S.terrainInfo}`
      : 'Terrain streams from open elevation tiles. Load it once per spot — it is then cached on the device for offline use in the field.');
    b.appendChild(hint);

    b.appendChild(el('h3', 'sec', 'Offline cache'));
    const cs = el('p', 'hint', 'checking…');
    b.appendChild(cs);
    cacheStats().then(s => cs.textContent = `${s.count} tiles cached · ${(s.bytes / 1048576).toFixed(1)} MB`);
    const cb = el('div', 'btnrow');
    const clr = el('button', 'btn', 'Clear cache');
    clr.addEventListener('click', async () => { await cacheClear(); this.toast('Tile cache cleared'); this.renderSheet(); });
    cb.appendChild(clr); b.appendChild(cb);

    b.appendChild(el('h3', 'sec', 'Presets'));
    let group = null;
    const ul = el('ul', 'list');
    for (const p of PRESETS) {
      if (p.g !== group) { group = p.g; const h = el('li'); h.style.pointerEvents = 'none'; h.appendChild(el('div', 'n', group)).style.color = 'var(--dim2)'; ul.appendChild(h); }
      const li = el('li');
      li.appendChild(el('div', 'n', p.n));
      const d = haversine(S.lat, S.lon, p.lat, p.lon) / 1000;
      li.appendChild(el('div', 'm', d < 1 ? 'here' : d.toFixed(0) + ' km'));
      li.addEventListener('click', () => { this.app.setLocation(p.lat, p.lon, p.n); this.renderSheet(); });
      ul.appendChild(li);
    }
    b.appendChild(ul);
  }

  panelWhen(b) {
    const app = this.app, S = app.S;
    const d = new Date(app.date.getTime() + S.tzMin * 60000);
    const di = el('input'); di.type = 'date';
    di.value = d.toISOString().slice(0, 10);
    di.addEventListener('change', () => {
      const [y, m, dd] = di.value.split('-').map(Number);
      const cur = new Date(app.date.getTime() + S.tzMin * 60000);
      const nd = Date.UTC(y, m - 1, dd, cur.getUTCHours(), cur.getUTCMinutes());
      app.setDate(new Date(nd - S.tzMin * 60000)); this.refresh();
    });
    this.row(b, 'Date', di);

    const tz = el('select');
    for (let o = -12 * 60; o <= 14 * 60; o += 30) {
      const opt = el('option', null, `UTC${o >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(o) / 60)).padStart(2, '0')}:${String(Math.abs(o) % 60).padStart(2, '0')}`);
      opt.value = o; if (o === S.tzMin) opt.selected = true; tz.appendChild(opt);
    }
    tz.addEventListener('change', () => { S.tzMin = +tz.value; app.save(); this.refresh(); });
    this.row(b, 'Time zone', tz);
    const br = el('div', 'btnrow');
    const dev = el('button', 'btn', 'Device time zone');
    dev.addEventListener('click', () => { S.tzMin = -new Date().getTimezoneOffset(); app.save(); this.renderSheet(); this.refresh(); });
    const sol = el('button', 'btn', 'Longitude (solar)');
    sol.addEventListener('click', () => { S.tzMin = Math.round(S.lon / 15) * 60; app.save(); this.renderSheet(); this.refresh(); });
    br.appendChild(dev); br.appendChild(sol); b.appendChild(br);

    this.slider(b, 'Playback speed', 0, 5, 1,
      () => [30, 120, 600, 1800, 3600, 10800].indexOf(S.speed),
      v => { S.speed = [30, 120, 600, 1800, 3600, 10800][v]; app.save(); },
      v => ['30×', '2 min/s', '10 min/s', '30 min/s', '1 h/s', '3 h/s'][v]);

    b.appendChild(el('h3', 'sec', 'Tonight'));
    const s = app.night, sum = app.summary;
    if (s) {
      const t = el('table', 'kv'); const add = (k, v, cls) => {
        const tr = el('tr'); tr.appendChild(el('td', null, k));
        const td = el('td'); if (cls) { const s2 = el('span', 'badge ' + cls, v); td.appendChild(s2); } else td.textContent = v;
        tr.appendChild(td); t.appendChild(tr);
      };
      const F = j => P.fmtTime(j, S.tzMin);
      add('Sunset', F(sum.sunset)); add('Civil dusk', F(sum.duskCivil));
      add('Nautical dusk', F(sum.duskNaut));
      add('Astronomical dusk', sum.hasAstroDark ? F(sum.duskAstro) : 'never', sum.hasAstroDark ? null : 'bad');
      add('Astronomical dawn', sum.hasAstroDark ? F(sum.dawnAstro) : 'never', sum.hasAstroDark ? null : 'bad');
      add('Sunrise', F(sum.sunrise));
      add('Darkest sun altitude', sum.darkestSunAlt.toFixed(1) + '°');
      add('Moonrise', sum.moonrise.map(F).join(', ') || '—');
      add('Moonset', sum.moonset.map(F).join(', ') || '—');
      add('Moon illumination', (sum.moonIllumMax * 100).toFixed(0) + '%');
      add('Core rises', F(sum.coreRise)); add('Core transit', `${F(sum.coreTransit)} · ${sum.coreMaxAlt.toFixed(0)}° · ${P.compass(sum.coreTransitAz)}`);
      add('Core sets', F(sum.coreSet));
      b.appendChild(t);
    }
  }

  panelCamera(b) {
    const app = this.app, S = app.S;
    const sel = el('select');
    for (const k of Object.keys(P.SENSORS)) { const o = el('option', null, k); o.value = k; if (k === S.sensor) o.selected = true; sel.appendChild(o); }
    sel.addEventListener('change', () => { S.sensor = sel.value; app.save(); app.invalidate(); this.renderSheet(); });
    this.row(b, 'Sensor', sel);

    const lg = el('div'); lg.style.display = 'grid';
    lg.style.gridTemplateColumns = 'repeat(6,1fr)'; lg.style.gap = '5px';
    for (const f of LENSES) {
      const p = el('div', 'pill' + (S.focal === f ? ' on' : ''), f);
      p.addEventListener('click', () => { S.focal = f; app.save(); app.invalidate(); this.renderSheet(); });
      lg.appendChild(p);
    }
    this.row(b, 'Focal length', lg);
    this.slider(b, 'Focal (fine)', 8, 200, 1, () => S.focal, v => { S.focal = v; app.invalidate(); }, v => v + ' mm');
    this.slider(b, 'Aperture f/', 1.2, 8, 0.1, () => S.fNumber, v => { S.fNumber = v; app.invalidate(); }, v => 'f/' + v.toFixed(1));
    this.slider(b, 'Megapixels', 8, 102, 1, () => S.mp, v => { S.mp = v; app.invalidate(); }, v => v + ' MP');
    this.toggle(b, 'Portrait orientation', () => S.portrait, v => { S.portrait = v; app.save(); });
    this.slider(b, 'View context zoom', 1, 3, 0.05, () => S.contextZoom, v => { S.contextZoom = v; }, v => v.toFixed(2) + '×');

    const e = P.exposureAdvice({ focal: S.focal, fNumber: S.fNumber, sensor: S.sensor, megapixels: S.mp, decl: app.coreDec || -29 });
    b.appendChild(el('h3', 'sec', 'What this lens gives you'));
    const t = el('table', 'kv'); const add = (k, v) => { const tr = el('tr'); tr.appendChild(el('td', null, k)); tr.appendChild(el('td', null, v)); t.appendChild(tr); };
    const hf = S.portrait ? e.vfov : e.hfov, vf = S.portrait ? e.hfov : e.vfov;
    add('Field of view', `${hf.toFixed(1)}° × ${vf.toFixed(1)}°`);
    add('Pixel pitch', e.pixelPitchUm.toFixed(2) + ' µm');
    add('NPF max shutter', e.npf.toFixed(1) + ' s');
    add('500 rule (optimistic)', e.rule500.toFixed(1) + ' s');
    add('Suggested ISO', 'ISO ' + e.suggestedISO);
    add('Frames for 4 min stack', Math.ceil(240 / e.npf));
    b.appendChild(t);
    const xb = el('div', 'btnrow');
    const ex = el('button', 'btn wide', '⤓ Save this view as a PNG');
    ex.addEventListener('click', () => this.app.exportFrame());
    xb.appendChild(ex); b.appendChild(xb);
    b.appendChild(el('p', 'hint', 'NPF accounts for aperture, focal length and pixel pitch and is the honest limit for pinpoint stars; the 500 rule is the old rule of thumb and will trail on a modern sensor. Both are shown at the core’s declination.'));
  }

  panelPlan(b) {
    const app = this.app, S = app.S;
    const sum = app.summary, s = app.night;
    if (s) {
      const wins = P.shootWindows(s, app.constraints());
      b.appendChild(el('h3', 'sec', 'Tonight’s windows'));
      if (!wins.length) {
        const why = [];
        if (!sum.hasAstroDark) why.push(`it never gets darker than ${sum.darkestSunAlt.toFixed(0)}° — no astronomical night at this latitude on this date`);
        if (sum.coreMaxAlt < S.coreMinAlt) why.push(`the core only reaches ${sum.coreMaxAlt.toFixed(0)}°`);
        if (sum.moonIllumMax > 0.5) why.push(`the moon is ${(sum.moonIllumMax * 100).toFixed(0)}% lit`);
        b.appendChild(el('p', 'hint', 'Nothing clears your constraints tonight' + (why.length ? ': ' + why.join('; ') : '') + '.'));
      } else {
        const t = el('table', 'kv');
        for (const w of wins) {
          const tr = el('tr');
          tr.appendChild(el('td', null, `${P.fmtTime(w.from, S.tzMin)} – ${P.fmtTime(w.to, S.tzMin)}`));
          tr.appendChild(el('td', null, `${P.fmtDur(w.minutes)} · core peaks ${w.peakAlt.toFixed(0)}° ${P.compass(w.peakAz)}`));
          t.appendChild(tr);
        }
        b.appendChild(t);
      }
    }

    b.appendChild(el('h3', 'sec', 'Foreground direction'));
    const az = el('div', 'row');
    az.appendChild(el('label', null, 'Target azimuth'));
    const azv = el('div', 'val', S.targetAz == null ? 'any' : `${S.targetAz.toFixed(0)}° ${P.compass(S.targetAz)}`);
    az.appendChild(azv); b.appendChild(az);
    const ab = el('div', 'btnrow');
    const use = el('button', 'btn primary', 'Use where I’m looking');
    use.addEventListener('click', () => { S.targetAz = app.view.az; app.save(); this.renderSheet(); });
    const clr = el('button', 'btn', 'Any direction');
    clr.addEventListener('click', () => { S.targetAz = null; app.save(); this.renderSheet(); });
    ab.appendChild(use); ab.appendChild(clr); b.appendChild(ab);
    this.slider(b, 'Azimuth tolerance', 10, 120, 5, () => S.azTol, v => { S.azTol = v; app.save(); }, v => '±' + v + '°');
    this.slider(b, 'Minimum core altitude', 0, 40, 1, () => S.coreMinAlt, v => { S.coreMinAlt = v; app.save(); }, v => v + '°');
    this.slider(b, 'Darkness required', -18, -8, 1, () => S.sunMax, v => { S.sunMax = v; app.save(); },
      v => v <= -18 ? 'astronomical (−18°)' : v <= -12 ? `nautical (${v}°)` : `${v}°`);
    this.slider(b, 'Moon tolerated up to', 0, 1, 0.05, () => S.moonIllumFree, v => { S.moonIllumFree = v; app.save(); }, v => (v * 100).toFixed(0) + '% lit');
    this.toggle(b, 'Require the core to clear the terrain', () => S.useTerrainHorizon, v => { S.useTerrainHorizon = v; app.save(); });

    b.appendChild(el('h3', 'sec', 'Best nights ahead'));
    const nb = el('div', 'btnrow');
    for (const d of [30, 60, 120]) {
      const p = el('button', 'btn', d + ' nights');
      p.addEventListener('click', () => { this.scanNights(d, res); });
      nb.appendChild(p);
    }
    b.appendChild(nb);
    const res = el('div'); b.appendChild(res);
    if (this._lastScan) this.renderScan(this._lastScan, res);
  }

  scanNights(days, host) {
    const app = this.app, S = app.S;
    host.innerHTML = '<p class="hint">scanning…</p>';
    setTimeout(() => {
      const start = new Date(app.date.getTime() + S.tzMin * 60000);
      const list = P.findBestNights(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())),
        days, S.lat, S.lon, S.tzMin, Object.assign(app.constraints(), { step: 10 }));
      this._lastScan = list;
      this.renderScan(list, host);
    }, 30);
  }
  renderScan(list, host) {
    const S = this.app.S;
    host.innerHTML = '';
    const good = list.filter(n => n.totalMinutes > 0).slice(0, 14);
    if (!good.length) { host.appendChild(el('p', 'hint', 'No nights in that range clear your constraints. Try relaxing the darkness requirement or the azimuth tolerance.')); return; }
    const ul = el('ul', 'list');
    for (const n of good) {
      const li = el('li');
      const left = el('div', 'n');
      left.appendChild(el('div', null, n.date.toUTCString().slice(0, 11)));
      const sub = el('div'); sub.style.color = 'var(--dim)'; sub.style.fontSize = '11px';
      sub.textContent = `${P.fmtTime(n.peak.from, S.tzMin)}–${P.fmtTime(n.peak.to, S.tzMin)} · core ${n.peak.peakAlt.toFixed(0)}° ${P.compass(n.peak.peakAz)}`;
      left.appendChild(sub);
      li.appendChild(left);
      const m = el('div', 'm');
      m.innerHTML = `${P.fmtDur(n.totalMinutes)}<br><span style="color:var(--dim2)">moon ${(n.peak.meanMoonIllum * 100).toFixed(0)}%</span>`;
      li.appendChild(m);
      li.addEventListener('click', () => { this.app.setJD(n.peak.peakJD); this.closeSheet(); });
      ul.appendChild(li);
    }
    host.appendChild(ul);
    host.appendChild(el('p', 'hint', 'Tap a night to jump the view to the moment the core is highest inside that window.'));
  }

  panelLayers(b) {
    const app = this.app, S = app.S;
    b.appendChild(el('p', 'panel-intro', 'Control what is drawn on the map and in the sky. Map data status is shown here, so a failed network request is never silent.'));
    const group = title => {
      b.appendChild(el('h3', 'sec', title));
      const card = el('div', 'layer-card'); b.appendChild(card); return card;
    };
    const saveFlag = (key, redrawSky = false) => v => {
      S[key] = v; app.save();
      if (redrawSky) app.recompute(); else app.invalidate();
    };

    const map = group('Map surface');
    this.toggle(map, 'Satellite imagery', () => S.useImagery, () => app.toggleSatellite());
    this.toggle(map, '3D terrain surface', () => S.showTerrain, saveFlag('showTerrain'));

    const osm = group('OpenStreetMap');
    this.toggle(osm, 'Roads & tracks', () => S.showRoads, v => app.setOSMLayer('roads', v));
    this.toggle(osm, 'Places & POIs', () => S.showPOIs, v => app.setOSMLayer('pois', v));
    const osmStatus = el('div', 'layer-data-status ' + (app._osmError ? 'bad' : app._osmLoading ? 'loading' : app.osmData ? 'ok' : ''));
    const statusCopy = el('div');
    statusCopy.appendChild(el('b', null, app._osmLoading ? 'Loading local map data…'
      : app._osmError ? 'Map data did not load'
      : app.osmData ? `${app.osmData.roads.length} roads · ${app.osmData.pois.length} POIs ready`
      : 'Waiting for map data'));
    statusCopy.appendChild(el('span', null, app._osmError || (app.osmData
      ? 'Projected directly onto the terrain mesh'
      : 'Enable either layer to load the current area')));
    osmStatus.appendChild(statusCopy);
    if (app._osmError || (!app.osmData && !app._osmLoading)) {
      const retry = el('button', 'btn', 'Retry');
      retry.addEventListener('click', () => app.loadOSMOverlays(true));
      osmStatus.appendChild(retry);
    }
    osm.appendChild(osmStatus);

    const sky = group('Sky');
    this.toggle(sky, 'Sun disc & label', () => S.showSun, saveFlag('showSun', true));
    this.toggle(sky, 'Moon phase & label', () => S.showMoon, saveFlag('showMoon', true));
    this.toggle(sky, 'Stars', () => S.showStars, saveFlag('showStars'));
    this.toggle(sky, 'Constellation figures', () => S.showFigures, saveFlag('showFigures'));
    this.toggle(sky, 'Alt-azimuth grid', () => S.showGrid, saveFlag('showGrid'));
    this.toggle(sky, 'Galactic equator', () => S.showGalactic, saveFlag('showGalactic'));
    this.toggle(sky, 'Core track for the night', () => S.showCorePath, saveFlag('showCorePath'));
    this.toggle(sky, 'Labels', () => S.showLabels, saveFlag('showLabels'));
    this.toggle(sky, 'Lens frame', () => S.showFrame, saveFlag('showFrame'));

    const chrome = group('Interface');
    const setChrome = (key, value) => { S[key] = value; app.save(); app.syncInterfaceChrome(); };
    this.toggle(chrome, 'Core status', () => S.showCoreChip, v => setChrome('showCoreChip', v));
    this.toggle(chrome, 'Sky darkness status', () => S.showDarknessChip, v => setChrome('showDarknessChip', v));
    this.toggle(chrome, 'Moon status', () => S.showMoonChip, v => setChrome('showMoonChip', v));
    this.toggle(chrome, 'Camera status', () => S.showCameraChip, v => setChrome('showCameraChip', v));
    this.toggle(chrome, 'Night timeline', () => S.showTimeline, v => setChrome('showTimeline', v));
    this.toggle(chrome, 'View & terrain status', () => S.showSceneStatus, v => setChrome('showSceneStatus', v));
    this.toggle(chrome, 'Gesture hints', () => S.showHints, v => setChrome('showHints', v));

    const advanced = el('button', 'btn wide display-settings', 'Display calibration & data sources');
    advanced.addEventListener('click', () => this.openSheet('sky'));
    b.appendChild(advanced);
  }

  panelSky(b) {
    const app = this.app, S = app.S;
    b.appendChild(el('p', 'panel-intro', 'Tune rendering and choose data providers. Layer visibility is managed separately from the Layers panel.'));
    const sq = el('select');
    SKY_QUALITY.forEach((q, i) => { const o = el('option', null, q.n); o.value = i; if (i === S.bortle) o.selected = true; sq.appendChild(o); });
    sq.addEventListener('change', () => {
      S.bortle = +sq.value; S.lightPol = SKY_QUALITY[S.bortle].lp; S.magLimit = SKY_QUALITY[S.bortle].mag;
      app.save(); app.invalidate();
    });
    this.row(b, 'Sky darkness', sq);
    this.slider(b, 'Exposure', 0.4, 4, 0.05, () => S.exposure, v => S.exposure = v, v => v.toFixed(2) + '×');
    this.slider(b, 'Milky Way strength', 0, 3, 0.05, () => S.mwGain, v => S.mwGain = v, v => v.toFixed(2));
    this.slider(b, 'Star brightness', 0.2, 3, 0.05, () => S.starGain, v => S.starGain = v, v => v.toFixed(2));
    this.slider(b, 'Foreground lift', 0, 0.35, 0.005, () => S.foregroundBoost, v => S.foregroundBoost = v, v => v.toFixed(3));
    this.slider(b, 'Terrain inspection light', 0, 1, 0.05, () => S.scoutLight, v => { S.scoutLight = v; app.save(); },
      v => v === 0 ? 'real light only' : (v * 100).toFixed(0) + '%');
    this.slider(b, 'Haze distance', 8000, 200000, 1000, () => S.haze, v => S.haze = v, v => (v / 1000).toFixed(0) + ' km');
    b.appendChild(el('h3', 'sec', 'Data sources'));
    const ds = el('select');
    for (const k of Object.keys(DEM_SOURCES)) { const o = el('option', null, DEM_SOURCES[k].name); o.value = k; if (k === S.demSource) o.selected = true; ds.appendChild(o); }
    ds.addEventListener('change', () => { S.demSource = ds.value; app.save(); this.renderSheet(); });
    this.row(b, 'Elevation', ds);
    if (DEM_SOURCES[S.demSource].needsKey) {
      const k = el('input'); k.type = 'text'; k.placeholder = 'API key'; k.value = S.demKey || '';
      k.addEventListener('change', () => { S.demKey = k.value.trim(); app.save(); });
      this.row(b, 'Key', k);
    }
    const is = el('select');
    for (const k of Object.keys(IMAGERY_SOURCES)) { const o = el('option', null, IMAGERY_SOURCES[k].name); o.value = k; if (k === S.imgSource) o.selected = true; is.appendChild(o); }
    is.addEventListener('change', () => { S.imgSource = is.value; app.save(); });
    this.row(b, 'Imagery', is);
    b.appendChild(el('h3', 'sec', 'Connection check'));
    const probeHost = el('div');
    const pb = el('div', 'btnrow');
    const probe = el('button', 'btn wide', 'Test every data source from this device');
    probe.addEventListener('click', async () => {
      probeHost.innerHTML = '<p class="hint">probing…</p>';
      const rows = await probeSources(S.lat, S.lon, { mapbox: S.demKey, maptiler: S.demKey });
      const t = el('table', 'kv');
      for (const r of rows) {
        const tr = el('tr');
        tr.appendChild(el('td', null, r.label));
        const td = el('td');
        const badge = el('span', 'badge ' + (r.ok ? 'ok' : 'bad'),
          r.ok ? `ok · ${r.ms} ms` : (r.error || `HTTP ${r.status}`));
        td.appendChild(badge); tr.appendChild(td); t.appendChild(tr);
      }
      probeHost.innerHTML = '';
      probeHost.appendChild(t);
      const bad = rows.filter(r => !r.ok && r.kind === 'elevation' && r.error !== 'no key set');
      probeHost.appendChild(el('p', 'hint', bad.length === rows.filter(r => r.kind === 'elevation').length
        ? 'No elevation host answered. If you are online, the network is blocking them — add a Mapbox or MapTiler key above, which uses a different domain.'
        : 'Pick a source that came back ok. The app also falls back automatically when the selected host is silent.'));
    });
    pb.appendChild(probe); b.appendChild(pb); b.appendChild(probeHost);

    const cb = el('div', 'btnrow');
    const full = el('button', 'btn wide', 'Download full star catalogue (~9 000 stars)');
    full.addEventListener('click', () => app.upgradeCatalog());
    cb.appendChild(full); b.appendChild(cb);
    b.appendChild(el('p', 'hint', app.catalogNote || ''));
  }

  panelAbout(b) {
    const app = this.app;
    b.innerHTML = `
      <p class="hint">Stand anywhere on Earth, at any hour of any night, and see what the camera will see: real terrain at 1:1 scale in front of an astronomically accurate sky.</p>
      <h3 class="sec">How accurate</h3>
      <p class="hint">Sun and Moon positions follow Meeus (ELP/VSOP truncations) and agree with the published reference cases to well under an arcsecond. Planets use the JPL Keplerian approximations, good to about an arcminute. Star positions are precessed from J2000 to the date you pick, and the Milky Way is drawn from exact galactic coordinates — the core sits where it really sits, to a fraction of a degree.</p>
      <p class="hint">The terrain is a real digital elevation model, sampled radially from your eye out to ${(app.S.rMax / 1000) | 0} km, with Earth curvature and standard atmospheric refraction applied, so a peak 60 km away sits at the altitude it really appears at.</p>
      <h3 class="sec">What is modelled, not measured</h3>
      <p class="hint">The Milky Way's brightness structure is a physical model (bulge, disk, Great Rift, Cygnus and Scutum clouds) rather than a photographic plate — its position is exact, its texture is representative. Faint filler stars below magnitude 5 are procedural and cosmetic; every named star is real. Sky brightness, haze and light pollution are visual approximations to help you judge a composition, not photometry.</p>
      <h3 class="sec">Credits</h3>
      <p class="hint">${app.attribution}</p>
      <p class="hint">Geocoding by Nominatim / OpenStreetMap. Built as a dependency-free progressive web app: add it to your home screen and it runs offline with whatever tiles you have cached.</p>
      <h3 class="sec">Gestures</h3>
      <p class="hint">Drag to look around · in 3D, Shift/right-drag or two-finger drag pans · pinch or scroll zooms · drag the timeline to scrub the night · ▶ animates time · ✥ points at the galactic core · ◎ uses the device compass.</p>`;
  }

  /* ---------- timeline ---------- */
  drawTimeline() {
    const app = this.app, S = app.S, s = app.night;
    const c = this.tl, x = this.tlx;
    const dpr = Math.min(2.5, devicePixelRatio || 1);
    const W = c.clientWidth, H = c.clientHeight;
    if (c.width !== W * dpr || c.height !== H * dpr) { c.width = W * dpr; c.height = H * dpr; }
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, W, H);
    if (!s) return;
    const t0 = s.t[0], t1 = s.t[s.n - 1], span = t1 - t0;
    const px = j => (j - t0) / span * W;
    const top = 6, bot = H - 16, hgt = bot - top;
    const ay = a => bot - Math.max(-18, Math.min(70, a)) / 88 * hgt - 18 / 88 * hgt;

    // twilight bands
    for (let i = 0; i < s.n - 1; i++) {
      const a = s.sunAlt[i];
      let col;
      if (a > 0) col = '#2a4a7a';
      else if (a > -6) col = '#24365c';
      else if (a > -12) col = '#182444';
      else if (a > -18) col = '#0f1830';
      else col = '#070c18';
      x.fillStyle = col;
      x.fillRect(px(s.t[i]), 0, W / (s.n - 1) + 1, H);
    }
    // shootable windows
    const wins = P.shootWindows(s, app.constraints());
    for (const w of wins) {
      const g = x.createLinearGradient(0, top, 0, bot);
      g.addColorStop(0, 'rgba(255,140,66,.30)'); g.addColorStop(1, 'rgba(255,140,66,.06)');
      x.fillStyle = g; x.fillRect(px(w.from), 0, px(w.to) - px(w.from), H);
      x.fillStyle = 'rgba(255,140,66,.9)'; x.fillRect(px(w.from), 0, 1.5, H);
      x.fillRect(px(w.to) - 1.5, 0, 1.5, H);
    }
    // horizon line
    x.strokeStyle = 'rgba(255,255,255,.22)'; x.lineWidth = 1;
    x.beginPath(); x.moveTo(0, ay(0)); x.lineTo(W, ay(0)); x.stroke();

    const curve = (arr, col, w, dash) => {
      x.strokeStyle = col; x.lineWidth = w; x.setLineDash(dash || []);
      x.beginPath();
      for (let i = 0; i < s.n; i++) { const X = px(s.t[i]), Y = ay(arr[i]); i ? x.lineTo(X, Y) : x.moveTo(X, Y); }
      x.stroke(); x.setLineDash([]);
    };
    curve(s.moonAlt, 'rgba(207,214,230,.55)', 1.2, [4, 3]);
    curve(s.sunAlt, 'rgba(255,196,84,.55)', 1.2);
    curve(s.gcAlt, '#ff8c42', 2);

    // hour ticks
    x.fillStyle = 'rgba(255,255,255,.42)'; x.font = '9px system-ui'; x.textAlign = 'center';
    for (let i = 0; i < s.n; i++) {
      const d = new Date((s.t[i] - 2440587.5) * 86400000 + S.tzMin * 60000);
      if (d.getUTCMinutes() === 0 && d.getUTCHours() % 3 === 0) {
        const X = px(s.t[i]);
        x.fillRect(X, H - 12, 1, 4);
        x.fillText(String(d.getUTCHours()).padStart(2, '0'), X, H - 3);
      }
    }
    // playhead
    const X = px(app.jd);
    x.strokeStyle = '#fff'; x.lineWidth = 1.5;
    x.beginPath(); x.moveTo(X, 0); x.lineTo(X, H - 14); x.stroke();
    x.fillStyle = '#fff'; x.beginPath(); x.arc(X, 8, 4, 0, 7); x.fill();
    // legend
    x.textAlign = 'left'; x.font = '9px system-ui';
    x.fillStyle = '#ff8c42'; x.fillText('core', 6, 12);
    x.fillStyle = 'rgba(255,196,84,.8)'; x.fillText('sun', 34, 12);
    x.fillStyle = 'rgba(207,214,230,.8)'; x.fillText('moon', 58, 12);
  }

  /* ---------- heads-up overlay ---------- */
  drawHUD() {
    const app = this.app, S = app.S, r = app.renderer;
    const c = this.hud, x = this.hx;
    const dpr = app.dpr, W = c.clientWidth, H = c.clientHeight;
    if (c.width !== W * dpr || c.height !== H * dpr) { c.width = W * dpr; c.height = H * dpr; }
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, W, H);
    x.font = '11px -apple-system,system-ui,sans-serif';
    x.textBaseline = 'middle';

    // horizon + cardinal marks
    const marks = [];
    for (let a = 0; a < 360; a += 15) marks.push(a);
    x.lineWidth = 1;
    for (const a of marks) {
      const d = app.azAltToVec(a, 0);
      const p = r.project(d); if (!p) continue;
      const major = a % 90 === 0, minor = a % 45 === 0;
      x.strokeStyle = major ? 'rgba(255,255,255,.55)' : 'rgba(255,255,255,.2)';
      x.beginPath(); x.moveTo(p[0], p[1] - (major ? 11 : 5)); x.lineTo(p[0], p[1] + (major ? 11 : 5)); x.stroke();
      if (major || minor) {
        x.fillStyle = major ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.4)';
        x.textAlign = 'center';
        x.fillText(P.compass(a), p[0], p[1] - 20);
      }
    }
    // altitude ladder along the view azimuth
    x.textAlign = 'left';
    for (let alt = -30; alt <= 90 && app.mode !== 'aerial'; alt += 10) {
      const d = app.azAltToVec(app.view.az, alt);
      const p = r.project(d); if (!p) continue;
      x.strokeStyle = alt === 0 ? 'rgba(255,255,255,.4)' : 'rgba(255,255,255,.13)';
      x.beginPath(); x.moveTo(W / 2 - 16, p[1]); x.lineTo(W / 2 + 16, p[1]); x.stroke();
      x.fillStyle = 'rgba(255,255,255,.35)';
      x.fillText(alt + '°', W / 2 + 21, p[1]);
    }

    // core track hour marks
    if (S.showCorePath && app.corePath) {
      for (const m of app.corePath.marks) {
        const p = r.project(m.dir); if (!p) continue;
        x.fillStyle = 'rgba(255,140,66,.85)';
        x.beginPath(); x.arc(p[0], p[1], 2.4, 0, 7); x.fill();
        x.fillStyle = 'rgba(255,140,66,.7)'; x.textAlign = 'left';
        x.fillText(m.label, p[0] + 6, p[1]);
      }
    }

    // labels
    if (S.showLabels) {
      for (const L of app.labels) {
        const p = r.project(L.dir); if (!p) continue;
        // keep labels clear of the top bar and the dock
        if (p[0] < 4 || p[0] > W - 6 || p[1] < 96 || p[1] > H - 150) continue;
        x.fillStyle = L.color;
        x.textAlign = 'left';
        if (L.ring) {
          x.strokeStyle = L.color; x.lineWidth = 1.4;
          x.beginPath(); x.arc(p[0], p[1], L.ring, 0, 7); x.stroke();
          if (L.cross) {
            x.beginPath();
            x.moveTo(p[0] - L.ring - 5, p[1]); x.lineTo(p[0] - L.ring + 3, p[1]);
            x.moveTo(p[0] + L.ring - 3, p[1]); x.lineTo(p[0] + L.ring + 5, p[1]);
            x.moveTo(p[0], p[1] - L.ring - 5); x.lineTo(p[0], p[1] - L.ring + 3);
            x.moveTo(p[0], p[1] + L.ring - 3); x.lineTo(p[0], p[1] + L.ring + 5);
            x.stroke();
          }
        }
        x.font = L.big ? '600 12px -apple-system,system-ui,sans-serif' : '11px -apple-system,system-ui,sans-serif';
        x.fillText(L.text, p[0] + (L.ring ? L.ring + 7 : 7), p[1]);
      }
    }

    // OpenStreetMap POIs are real terrain-space points, projected through the
    // same camera as the mesh. A small collision pass keeps dense areas legible.
    if (S.showPOIs && app.poiMarkers?.length) {
      const placed = [];
      for (const marker of app.poiMarkers) {
        const p = r.projectPoint(marker.world);
        if (!p || p[0] < 18 || p[0] > W - 18 || p[1] < 92 || p[1] > H - 155) continue;
        if (placed.some(q => Math.abs(q[0] - p[0]) < 92 && Math.abs(q[1] - p[1]) < 18)) continue;
        placed.push(p);
        const peak = marker.kind === 'peak' || marker.kind === 'viewpoint';
        x.fillStyle = peak ? 'rgba(214,255,82,.95)' : 'rgba(99,185,255,.95)';
        x.beginPath(); x.arc(p[0], p[1], peak ? 4 : 3, 0, Math.PI * 2); x.fill();
        x.strokeStyle = 'rgba(3,9,8,.85)'; x.lineWidth = 3;
        x.font = '600 10px Inter,system-ui,sans-serif'; x.textAlign = 'left';
        const name = marker.name.length > 28 ? marker.name.slice(0, 27) + '…' : marker.name;
        x.strokeText(name, p[0] + 7, p[1] + 3);
        x.fillStyle = 'rgba(241,247,244,.94)'; x.fillText(name, p[0] + 7, p[1] + 3);
      }
    }

    // scout bar
    const bar = document.getElementById('scoutbar');
    const aerial = app.mode === 'aerial';
    const showScout = aerial && !!app.pick;
    bar.hidden = !showScout;
    if (showScout) {
      const mapMode = app.aerialView === 'map';
      bar.classList.toggle('map-mode', mapMode);
      const t = document.getElementById('scoutTitle'), sub = document.getElementById('scoutSub');
      const stand = document.getElementById('scoutStand');
      if (app.pick) {
        const d = app.pick.groundDist;
        t.textContent = `${app.pick.elev.toFixed(0)} m · ${d < 1000 ? d.toFixed(0) + ' m' : (d / 1000).toFixed(2) + ' km'} ${P.compass(app.pick.az)}`;
        sub.textContent = `${app.pick.lat.toFixed(5)}, ${app.pick.lon.toFixed(5)} · ${(app.pick.elev - app.mesh.baseElev >= 0 ? '+' : '')}${(app.pick.elev - app.mesh.baseElev).toFixed(0)} m vs here`;
        stand.disabled = false;
      } else {
        t.textContent = mapMode ? 'Tap anywhere to choose your POV' : 'Tap the terrain to choose your POV';
        sub.textContent = mapMode
          ? `2D map · ${app.orbit.dist < 1000 ? app.orbit.dist.toFixed(0) + ' m' : (app.orbit.dist / 1000).toFixed(1) + ' km'} altitude · drag to pan`
          : `3D terrain · ${app.orbit.dist < 1000 ? app.orbit.dist.toFixed(0) + ' m' : (app.orbit.dist / 1000).toFixed(1) + ' km'} · ${P.compass(app.orbit.az)} · ${app.orbit.pitch.toFixed(0)}° down`;
        stand.disabled = true;
      }
      // the standing point, so you never lose yourself in the orbit
      const p0 = r.projectPoint ? r.projectPoint([0, 0, 0]) : null;
      if (p0 && p0[0] > 0 && p0[0] < W && p0[1] > 90 && p0[1] < H - 150) {
        x.strokeStyle = 'rgba(255,255,255,.9)'; x.lineWidth = 1.6;
        x.beginPath(); x.arc(p0[0], p0[1], 6, 0, 7); x.stroke();
        x.beginPath(); x.moveTo(p0[0], p0[1] - 14); x.lineTo(p0[0], p0[1] - 6); x.stroke();
        x.fillStyle = 'rgba(255,255,255,.85)'; x.textAlign = 'left'; x.font = '11px system-ui';
        x.fillText('you', p0[0] + 10, p0[1]);
      }
    }

    // lens frame
    if (S.showFrame && !aerial && S.contextZoom > 1.001) {
      const e = P.exposureAdvice({ focal: S.focal, fNumber: S.fNumber, sensor: S.sensor, megapixels: S.mp });
      const vf = S.portrait ? e.hfov : e.vfov, hf = S.portrait ? e.vfov : e.hfov;
      const tanY = Math.tan(app.view.vfovDeg * Math.PI / 360);
      const fh = Math.tan(vf * Math.PI / 360) / tanY * (H / 2);
      const fw = Math.tan(hf * Math.PI / 360) / (tanY * (W / H)) * (W / 2);
      x.strokeStyle = 'rgba(255,255,255,.75)'; x.lineWidth = 1.4;
      x.strokeRect(W / 2 - fw, H / 2 - fh, fw * 2, fh * 2);
      x.fillStyle = 'rgba(0,0,0,.30)';
      x.fillRect(0, 0, W, H / 2 - fh); x.fillRect(0, H / 2 + fh, W, H / 2 - fh + 1);
      x.fillRect(0, H / 2 - fh, W / 2 - fw, fh * 2); x.fillRect(W / 2 + fw, H / 2 - fh, W / 2 - fw + 1, fh * 2);
      x.fillStyle = 'rgba(255,255,255,.8)'; x.textAlign = 'left'; x.font = '10px system-ui';
      x.fillText(`${S.focal}mm · ${hf.toFixed(0)}×${vf.toFixed(0)}°`, W / 2 - fw + 5, H / 2 - fh + 10);
      // rule-of-thirds inside the frame
      x.strokeStyle = 'rgba(255,255,255,.12)'; x.lineWidth = 1;
      for (let i = 1; i < 3; i++) {
        x.beginPath(); x.moveTo(W / 2 - fw + fw * 2 * i / 3, H / 2 - fh); x.lineTo(W / 2 - fw + fw * 2 * i / 3, H / 2 + fh); x.stroke();
        x.beginPath(); x.moveTo(W / 2 - fw, H / 2 - fh + fh * 2 * i / 3); x.lineTo(W / 2 + fw, H / 2 - fh + fh * 2 * i / 3); x.stroke();
      }
    }

    // target azimuth marker
    if (S.targetAz != null) {
      const p = r.project(app.azAltToVec(S.targetAz, 0));
      if (p) {
        x.strokeStyle = 'rgba(95,168,255,.9)'; x.lineWidth = 2;
        x.beginPath(); x.moveTo(p[0], p[1] - 16); x.lineTo(p[0], p[1] + 16); x.stroke();
        x.fillStyle = 'rgba(95,168,255,.9)'; x.textAlign = 'center'; x.font = '10px system-ui';
        x.fillText('foreground', p[0], p[1] + 26);
      }
    }
  }
}
