/* app.js — application state, the render loop, and everything that wires the
 * astronomy to the pixels. */

import * as A from './astro.js';
import * as P from './planner.js';
import { Renderer } from './render.js';
import { UI } from './ui.js';
import { BRIGHT_STARS, FIGURES, bvToRGB, fillerStars, loadFullCatalog } from './catalog.js';
import { SKY_QUALITY } from './presets.js';
import {
  DemPyramid, DEM_SOURCES, IMAGERY_SOURCES, tilePlan, buildMesh, horizonAltAt,
  buildImagery, destPoint, haversine, bearing, groundYAt, raycastTerrain
} from './terrain.js';

const DEFAULTS = {
  lat: 46.0207, lon: 7.7491, name: 'Zermatt, Switzerland',
  tzMin: 60, quality: 'balanced',
  focal: 20, fNumber: 2.8, sensor: 'Full frame', mp: 45, portrait: false, contextZoom: 1.4,
  bortle: 2, exposure: 1.0, mwGain: 1.0, starGain: 1.0, foregroundBoost: 0.02, haze: 60000,
  lightPol: 0.008, magLimit: 7.3,
  showStars: true, showFigures: true, showGrid: false, showGalactic: false,
  showCorePath: true, showLabels: true, showFrame: true, showTerrain: true,
  useImagery: false, demSource: 'terrarium', imgSource: 'esri', demKey: '',
  targetAz: null, azTol: 45, coreMinAlt: 5, sunMax: -18, moonIllumFree: 0.10,
  useTerrainHorizon: true, speed: 600, eyeHeight: 1.6, rMax: 160000, scoutLight: 0.55
};

const KEY = 'astroscout.state.v1';

class App {
  constructor() {
    this.S = Object.assign({}, DEFAULTS, this.load());
    this.date = new Date();
    this.view = { az: 180, alt: 12, roll: 0, vfovDeg: 60 };
    this.labels = [];
    this.dpr = Math.min(2.5, window.devicePixelRatio || 1);
    this.playing = false;
    this.dirty = true;
    this.mode = 'eye';
    this.orbit = { cx: 0, cz: 0, dist: 6000, az: 200, pitch: 38 };
    this.blend = 0;          // 0 = eye level, 1 = aerial
    this.pick = null;
    this.attribution = 'Elevation: AWS Terrain Tiles (Mapzen). Star data: Bright Star Catalogue positions, J2000.';
    this.catalogNote = 'Using the built-in bright-star list plus procedural filler. Download the full catalogue for ~9 000 real stars (needs a connection once; then cached).';
  }

  load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  save() { try { localStorage.setItem(KEY, JSON.stringify(this.S)); } catch (e) { } }

  async init() {
    const canvas = document.getElementById('gl');
    try {
      this.renderer = new Renderer(canvas);
    } catch (e) {
      document.getElementById('splash').innerHTML =
        `<div style="padding:24px"><div class="t">WebGL2 unavailable</div><div class="s">${e.message}<br><br>This app needs WebGL2. On iOS use Safari 15+, on Android use Chrome.</div></div>`;
      return;
    }
    this.ui = new UI(this);
    this.buildSky();
    this.bindInput();
    if (!this.S.tzMinSet) { this.S.tzMin = -new Date().getTimezoneOffset(); this.S.tzMinSet = true; }
    this.recomputeNight();
    this.recompute();
    this.loop();
    document.getElementById('splash').classList.add('gone');
    setTimeout(() => document.getElementById('splash').remove(), 600);
    // terrain is a network fetch, so it is opt-in on first run but automatic afterwards
    if (this.S.autoTerrain) this.loadTerrain();
    else this.ui.toast(window.__ASTROSCOUT_PREVIEW
      ? 'Preview build: the sky, timeline and planner are live. Terrain needs the deployed version.'
      : 'Open “Where” to load the terrain for this spot', 5200);
  }

  /* ---------- static sky geometry ---------- */
  buildSky() {
    const r = this.renderer;
    const stars = BRIGHT_STARS.concat(fillerStars(2600, A.galToEq));
    this.starList = stars;
    r.setStars(stars, bvToRGB, A.raDecToVec);

    // constellation figures
    const fig = [];
    for (let i = 0; i < FIGURES.length; i++) {
      const s = BRIGHT_STARS[FIGURES[i]];
      fig.push(...A.raDecToVec(s[0], s[1]));
    }
    r.setLines('figures', fig, { color: [0.42, 0.56, 0.86, 0.30], space: 'sky' });

    // galactic equator
    const ge = [];
    for (let l = 0; l <= 360; l += 2) {
      const q = A.galToEq(l % 360, 0);
      ge.push(...A.raDecToVec(q.ra, q.dec));
    }
    r.setLines('galactic', ge, { color: [1.0, 0.55, 0.26, 0.35], space: 'sky', mode: 'LINE_STRIP' });

    // alt-azimuth grid, in local space
    const grid = [];
    for (const alt of [0, 15, 30, 45, 60, 75]) {
      for (let a = 0; a < 360; a += 3) {
        grid.push(...this.azAltToVec(a, alt), ...this.azAltToVec(a + 3, alt));
      }
    }
    for (let a = 0; a < 360; a += 30) {
      for (let al = -6; al < 88; al += 3) {
        grid.push(...this.azAltToVec(a, al), ...this.azAltToVec(a, al + 3));
      }
    }
    r.setLines('grid', grid, { color: [1, 1, 1, 0.10], space: 'local' });
  }

  azAltToVec(az, alt) {
    const ca = Math.cos(alt * A.DEG);
    return [ca * Math.sin(az * A.DEG), Math.sin(alt * A.DEG), -ca * Math.cos(az * A.DEG)];
  }

  /* ---------- time ---------- */
  get jd() { return A.julianDay(this.date); }
  setDate(d) { this.date = d; this.checkNight(); this.recompute(); }
  setJD(jd) { this.setDate(A.dateFromJD(jd)); }
  togglePlay() { this.playing = !this.playing; document.getElementById('btnPlay').textContent = this.playing ? '⏸' : '▶'; }

  localDayKey() {
    const d = new Date(this.date.getTime() + this.S.tzMin * 60000);
    // a "night" is keyed by the noon it follows
    const shifted = new Date(d.getTime() - 12 * 3600000);
    return `${shifted.getUTCFullYear()}-${shifted.getUTCMonth()}-${shifted.getUTCDate()}`;
  }
  checkNight() { if (this.localDayKey() !== this._nightKey) this.recomputeNight(); }

  recomputeNight() {
    const S = this.S;
    this._nightKey = this.localDayKey();
    const d = new Date(this.date.getTime() + S.tzMin * 60000);
    const shifted = new Date(d.getTime() - 12 * 3600000);
    const jdNoon = P.noonJD(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), S.tzMin);
    this.night = P.sampleNight(jdNoon, S.lat, S.lon, { step: 4, horizonFn: this.horizonFn() });
    this.summary = P.nightSummary(this.night);
    this.buildCorePath();
  }

  horizonFn() {
    if (!this.S.useTerrainHorizon || !this.mesh) return null;
    return az => horizonAltAt(this.mesh, az);
  }

  constraints() {
    const S = this.S;
    return {
      sunMax: S.sunMax, moonIllumFree: S.moonIllumFree, coreMinAlt: S.coreMinAlt,
      targetAz: S.targetAz, azTol: S.azTol, horizonFn: this.horizonFn()
    };
  }

  buildCorePath() {
    const s = this.night, S = this.S;
    if (!s) return;
    const pts = [], marks = [];
    for (let i = 0; i < s.n; i++) {
      if (s.gcAlt[i] < -12) continue;
      const v = this.azAltToVec(s.gcAz[i], s.gcAlt[i]);
      pts.push(...v);
      const d = new Date((s.t[i] - 2440587.5) * 86400000 + S.tzMin * 60000);
      if (d.getUTCMinutes() === 0 && s.gcAlt[i] > -2)
        marks.push({ dir: v, label: String(d.getUTCHours()).padStart(2, '0') + ':00' });
    }
    this.corePath = { marks };
    this.renderer.setLines('corepath', pts, { color: [1, 0.55, 0.26, 0.55], space: 'local', mode: 'LINE_STRIP' });
  }

  /* ---------- per-instant state ---------- */
  recompute() {
    const S = this.S, jd = this.jd, jde = A.jdeFromJD(jd);
    const T = A.century(jde), lst = A.lstDeg(jd, S.lon);
    const M = A.skyMatrix(S.lat, lst, T);           // J2000 -> render
    const Mt = transpose3(M);
    // J2000 -> galactic
    const gz = A.raDecToVec(A.GAL_POLE_RA, A.GAL_POLE_DEC);
    const gx = A.raDecToVec(266.404996, -28.936175);
    const gy = cross(gz, gx);
    const G = [gx[0], gx[1], gx[2], gy[0], gy[1], gy[2], gz[0], gz[1], gz[2]];
    this.galMatrix = glMat3(A.mat3mul(G, Mt));
    this.skyMatrixGL = glMat3(M);

    const H = A.horizonMatrix(S.lat, lst);
    const toDir = (ra, dec) => A.mat3apply(H, A.raDecToVec(ra, dec));

    const sun = A.sunPosition(jde);
    const moon = A.moonPosition(jde);
    const ill = A.moonIllumination(jde);
    this.sun = sun; this.moon = moon; this.ill = ill;
    const sunDir = toDir(sun.ra, sun.dec);
    let moonDir = toDir(moon.ra, moon.dec);
    // topocentric parallax: lower the Moon by pi*cos(alt)
    const mAltGeo = Math.asin(moonDir[1]) * A.RAD;
    const mAlt = mAltGeo - moon.parallax * Math.cos(mAltGeo * A.DEG);
    const mAz = Math.atan2(moonDir[0], -moonDir[2]) * A.RAD;
    moonDir = this.azAltToVec(mAz, mAlt);
    const sunAlt = Math.asin(Math.max(-1, Math.min(1, sunDir[1]))) * A.RAD;

    this.sunDir = sunDir; this.moonDir = moonDir; this.sunAlt = sunAlt; this.moonAlt = mAlt;
    const gc = A.gcAt(jd);
    this.coreDir = toDir(gc.ra, gc.dec);
    this.coreDec = gc.dec;
    this.coreAlt = Math.asin(Math.max(-1, Math.min(1, this.coreDir[1]))) * A.RAD;
    this.coreAz = (Math.atan2(this.coreDir[0], -this.coreDir[2]) * A.RAD + 360) % 360;

    // sky brightness proxy, used to fade stars
    const day = smoothstep(-17, 1, sunAlt);
    const moonUp = smoothstep(-3, 8, mAlt);
    this.skyBright = Math.min(1, day * 1.0 + ill.fraction * moonUp * 0.35 + S.lightPol * 1.2);

    // bodies to draw
    const bodies = [{
      dir: sunDir, kind: 'sun', angularRadius: sun.angularRadius, color: [1.0, 0.93, 0.75],
      spriteScale: 2.4, minPx: 10
    }, {
      dir: moonDir, kind: 'moon', angularRadius: moon.angularRadius, color: [0.93, 0.93, 0.90],
      illum: ill.fraction, limbAngle: this.limbAngle(moonDir, ill.brightLimbPA, H),
      spriteScale: 2.2, minPx: 9
    }];
    this.planets = [];
    for (const name of A.PLANET_NAMES) {
      const p = A.planetPosition(name, jde);
      const dir = toDir(p.ra, p.dec);
      const col = { Mercury: [0.85, 0.82, 0.76], Venus: [1.0, 0.97, 0.86], Mars: [1.0, 0.62, 0.42],
        Jupiter: [1.0, 0.94, 0.80], Saturn: [0.98, 0.90, 0.68], Uranus: [0.66, 0.90, 0.95],
        Neptune: [0.60, 0.72, 1.0] }[name];
      bodies.push({ dir, kind: 'planet', angularRadius: Math.max(p.angularRadius, 0.02), color: col,
        spriteScale: 3.0, minPx: Math.max(2.5, 7 - p.mag) });
      p.dir = dir; p.alt = Math.asin(dir[1]) * A.RAD;
      this.planets.push(p);
    }
    this.bodies = bodies;
    this.buildLabels();
    this.dirty = true;
  }

  limbAngle(moonDir, pa, H) {
    // screen angle of the bright limb: north tangent rotated by the position angle
    const z = A.mat3apply(H, [0, 0, 1]);                 // celestial north pole, render space
    const e = normalize(cross(z, moonDir));
    const n = cross(moonDir, e);
    const t = [], c = Math.cos(pa * A.DEG), s = Math.sin(pa * A.DEG);
    for (let i = 0; i < 3; i++) t.push(n[i] * c + e[i] * s);
    const p0 = this.renderer.project(moonDir);
    const p1 = this.renderer.project(normalize([moonDir[0] + t[0] * 0.02, moonDir[1] + t[1] * 0.02, moonDir[2] + t[2] * 0.02]));
    if (!p0 || !p1) return 0;
    return -Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
  }

  buildLabels() {
    const S = this.S, out = [];
    out.push({
      dir: this.coreDir, text: `CORE  ${this.coreAlt.toFixed(0)}° ${P.compass(this.coreAz)}`,
      color: 'rgba(255,140,66,.95)', ring: 15, cross: true, big: true
    });
    out.push({
      dir: this.moonDir, text: `Moon ${(this.ill.fraction * 100).toFixed(0)}%${this.moonAlt < 0 ? ' (down)' : ''}`,
      color: this.moonAlt < 0 ? 'rgba(207,214,230,.42)' : 'rgba(207,214,230,.9)', ring: 9
    });
    out.push({
      dir: this.sunDir, text: this.sunAlt < 0 ? `Sun ${this.sunAlt.toFixed(0)}°` : 'Sun',
      color: this.sunAlt < 0 ? 'rgba(255,200,120,.45)' : 'rgba(255,200,120,.9)', ring: 9
    });
    for (const p of this.planets)
      if (p.mag < 3.2 && p.alt > -3)
        out.push({ dir: p.dir, text: p.name, color: 'rgba(255,220,180,.75)' });
    const M = A.mat3apply.bind(null, A.skyMatrix(S.lat, A.lstDeg(this.jd, S.lon), A.century(A.jdeFromJD(this.jd))));
    const starLabels = this.skyBright < 0.55;
    for (const s of BRIGHT_STARS) {
      if (s[2] > 1.65 || !starLabels) continue;
      const d = M(A.raDecToVec(s[0], s[1]));
      if (d[1] < -0.02) continue;
      out.push({ dir: d, text: s[4], color: 'rgba(210,225,255,.62)' });
    }
    this.labels = out;
  }

  /* ---------- terrain ---------- */
  async loadTerrain() {
    const S = this.S;
    if (this._loading) return;
    this._loading = true;
    this.ui.toast('Fetching elevation tiles…', 9000);
    try {
      const plan = tilePlan(S.quality);
      // try the chosen source, then the other keyless hosts, before giving up
      const order = [S.demSource, 'terrarium', 'terrariumAlt']
        .filter((v, i, a) => a.indexOf(v) === i && DEM_SOURCES[v])
        .filter(k => !DEM_SOURCES[k].needsKey || S.demKey);
      let dem = null;
      for (const key of order) {
        const d = new DemPyramid();
        d.src = DEM_SOURCES[key]; d.key = S.demKey;
        await d.load(S.lat, S.lon, plan, { onProgress: (a, b) => this.ui.progress(a / b) });
        if (d.levels.some(l => l.tiles.size)) {
          dem = d;
          if (key !== S.demSource) {
            S.demSource = key;
            this.ui.toast(`Switched to ${DEM_SOURCES[key].name} — the previous source did not respond`, 4500);
          }
          break;
        }
        this.ui.toast(`${DEM_SOURCES[key].name} returned nothing, trying the next source…`, 3000);
      }
      this.ui.progress(0);
      if (!dem) {
        const dummy = { levels: [] };
        dem = dummy;
      }
      if (!dem.levels.some(l => l.tiles.size)) {
        this.ui.toast(window.__ASTROSCOUT_PREVIEW
          ? 'This hosted preview is sandboxed and cannot fetch map tiles. Everything else — sky, timeline, planner — works here; run the deployed build for terrain.'
          : 'No elevation tiles could be fetched. Check the connection, or pick another source under Sky & terrain.', 7000);
        this._loading = false; return;
      }
      const azSteps = { fast: 512, balanced: 768, max: 1024 }[S.quality];
      const rMax = { fast: 100000, balanced: 160000, max: 240000 }[S.quality];
      S.rMax = rMax;
      const mesh = buildMesh(dem, S.lat, S.lon, {
        azSteps, rMax, eyeHeight: S.eyeHeight,
        drMax: S.quality === 'max' ? 700 : 900
      });
      this.dem = dem; this.mesh = mesh;
      this.renderer.setTerrain(mesh);
      let tiles = 0; dem.levels.forEach(l => tiles += l.tiles.size);
      S.terrainLoaded = true; S.autoTerrain = true;
      S.terrainInfo = `${tiles} tiles · ${(mesh.nVerts / 1000) | 0}k vertices · ${(rMax / 1000)} km radius · ground ${mesh.baseElev.toFixed(0)} m`;
      this.save();
      // snow/tree lines follow the local terrain so shading looks plausible anywhere
      const e = mesh.baseElev;
      this.snowLine = Math.max(600, e + 1400 - Math.abs(S.lat) * 22);
      this.treeLine = Math.max(200, this.snowLine - 900);
      this.recomputeNight();
      this.ui.toast(`Terrain loaded — ${tiles} tiles, horizon at ${(rMax / 1000)} km`, 3000);
      if (S.useImagery) this.loadImagery();
    } catch (e) {
      this.ui.toast('Terrain failed: ' + e.message, 5000);
    }
    this._loading = false;
    this.invalidate();
  }

  /** Two drapes: a wide coarse one for context, a sharp one for the foreground.
   *  A single level either blurs the near ground or costs hundreds of tiles. */
  async loadImagery() {
    const S = this.S;
    if (!S.useImagery) {
      this.renderer.setImagery(null, 'A'); this.renderer.setImagery(null, 'B');
      this.invalidate(); return;
    }
    const plans = {
      fast:     [{ z: 11, r: 25000, slot: 'A' }],
      balanced: [{ z: 11, r: 35000, slot: 'A' }, { z: 14, r: 4000, slot: 'B' }],
      max:      [{ z: 12, r: 20000, slot: 'A' }, { z: 15, r: 2800, slot: 'B' }]
    }[S.quality] || [];
    const src = IMAGERY_SOURCES[S.imgSource] || IMAGERY_SOURCES.esri;
    this.ui.toast('Fetching imagery…', 9000);
    try {
      for (const step of plans) {
        const img = await buildImagery(src, S.lat, S.lon, step.r, step.z,
          (d, t) => this.ui.progress(d / t));
        this.renderer.setImagery(img, step.slot);
        this.invalidate();
      }
      this.ui.progress(0);
      const px = { fast: 53, balanced: 6.6, max: 3.4 }[S.quality];
      this.ui.toast(`Imagery draped · about ${px} m per pixel in the foreground`, 3000);
    } catch (e) { this.ui.toast('Imagery failed: ' + e.message, 4000); }
    this.invalidate();
  }

  async upgradeCatalog() {
    this.ui.toast('Downloading star catalogue…', 8000);
    const cat = await loadFullCatalog();
    if (!cat) { this.ui.toast('Could not reach the catalogue CDN. The built-in stars are still accurate.', 5000); return; }
    const merged = cat.concat(fillerStars(400, A.galToEq));
    this.starList = merged;
    this.renderer.setStars(merged, bvToRGB, A.raDecToVec);
    this.catalogNote = `Full catalogue loaded: ${cat.length} real stars to magnitude 6.5, cached on this device.`;
    this.ui.toast(`${cat.length} stars loaded`, 3000);
    this.invalidate();
  }

  /* ---------- location ---------- */
  setLocation(lat, lon, name) {
    const S = this.S;
    S.lat = Math.max(-85, Math.min(85, lat)); S.lon = ((lon + 540) % 360) - 180;
    S.name = name || `${S.lat.toFixed(4)}, ${S.lon.toFixed(4)}`;
    S.terrainLoaded = false; S.terrainInfo = '';
    this.mesh = null; this.dem = null;
    this.renderer.clearTerrain();
    this.renderer.setImagery(null);
    this.save();
    this.recomputeNight(); this.recompute();
    this.ui.refresh();
    if (S.autoTerrain) this.loadTerrain();
  }

  async geocode(q) {
    // coordinates typed directly
    const m = q.match(/(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)/);
    const out = [];
    if (m) out.push({ name: `${m[1]}, ${m[2]}`, lat: +m[1], lon: +m[2] });
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&q=${encodeURIComponent(q)}`,
        { headers: { 'Accept': 'application/json' } });
      if (r.ok) {
        const j = await r.json();
        for (const h of j) out.push({ name: h.display_name, lat: +h.lat, lon: +h.lon });
      }
    } catch (e) { /* offline: presets and coordinates still work */ }
    return out;
  }

  useGPS() {
    if (!navigator.geolocation) return this.ui.toast('No geolocation on this device');
    this.ui.toast('Getting a fix…');
    navigator.geolocation.getCurrentPosition(
      p => { this.setLocation(p.coords.latitude, p.coords.longitude, 'My location'); this.ui.toast('Located'); },
      e => this.ui.toast('Location denied: ' + e.message, 4000),
      { enableHighAccuracy: true, timeout: 12000 });
  }

  /* ---------- view helpers ---------- */
  lookAtCore() {
    this.view.az = this.coreAz;
    this.view.alt = Math.max(2, Math.min(70, this.coreAlt));
    this.invalidate();
  }
  jumpToBest() {
    const w = P.shootWindows(this.night, this.constraints());
    if (w.length) { this.setJD(w[0].peakJD); this.ui.toast('Jumped to the core’s peak in tonight’s window'); }
    else if (this.summary.duskAstro) { this.setJD(this.summary.duskAstro); this.ui.toast('No window tonight — jumped to astronomical dusk'); }
    else if (this.summary.duskNaut) { this.setJD(this.summary.duskNaut); this.ui.toast('No astronomical dark tonight — jumped to nautical dusk'); }
    this.ui.refresh();
  }

  async toggleOrientation() {
    if (this._orient) {
      window.removeEventListener('deviceorientation', this._orient);
      window.removeEventListener('deviceorientationabsolute', this._orient);
      this._orient = null;
      document.getElementById('btnAR').classList.remove('on');
      return;
    }
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
        const p = await DeviceOrientationEvent.requestPermission();
        if (p !== 'granted') return this.ui.toast('Compass permission denied');
      }
    } catch (e) { return this.ui.toast('Compass unavailable'); }
    this._orient = ev => {
      let heading = ev.webkitCompassHeading != null ? ev.webkitCompassHeading
        : (ev.absolute && ev.alpha != null ? 360 - ev.alpha : null);
      if (heading == null) return;
      const so = (screen.orientation && screen.orientation.angle) || 0;
      this.view.az = (heading + so + 360) % 360;
      this.view.alt = Math.max(-80, Math.min(85, (ev.beta || 0) - 90 + (so === 0 ? 0 : 0)));
      this.dirty = true;
    };
    window.addEventListener('deviceorientationabsolute', this._orient, true);
    window.addEventListener('deviceorientation', this._orient, true);
    document.getElementById('btnAR').classList.add('on');
    this.ui.toast('Compass mode on — point the device at the horizon');
  }

  invalidate() { this.dirty = true; }

  toggleAerial(on) {
    const want = on === undefined ? this.mode !== 'aerial' : (on ? 'aerial' : 'eye') === 'aerial';
    if (want && !this.mesh) return this.ui.toast('Load the terrain first — there is nothing to fly over yet');
    if (want) {
      this._eyeAlt = this.view.alt;
      this._eyeAz = this.view.az;
      this.orbit.az = this.view.az;
      this.orbit.cx = 0; this.orbit.cz = 0;
      this.orbit.dist = Math.max(2500, Math.min(20000, this.mesh.rMax * 0.05));
      this.orbit.pitch = 38;
      this.mode = 'aerial';
      this.ui.toast('Scout view — drag to orbit, pinch to zoom, tap the ground to pick a spot');
    } else {
      this.mode = 'eye';
      this.view.az = this.orbit.az;
      this.view.alt = this._eyeAlt === undefined ? 10 : this._eyeAlt;
      this.pick = null;
      this.renderer.setWorldLine('pickring', null);
      this.renderer.setWorldLine('pickpin', null);
    }
    document.getElementById('btnAerial').classList.toggle('on', this.mode === 'aerial');
    this.ui.refresh();
    this.dirty = true;
  }

  /** Screen tap -> a point on the terrain. */
  pickAt(clientX, clientY) {
    if (!this.mesh || !this.dem) return;
    const rect = document.getElementById('stage').getBoundingClientRect();
    const v = this.renderer.view;
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
    const d = [
      v.fwd[0] + v.right[0] * ndcX * v.tanX + v.up[0] * ndcY * v.tanY,
      v.fwd[1] + v.right[1] * ndcX * v.tanX + v.up[1] * ndcY * v.tanY,
      v.fwd[2] + v.right[2] * ndcX * v.tanX + v.up[2] * ndcY * v.tanY
    ];
    const L = Math.hypot(d[0], d[1], d[2]);
    const hit = raycastTerrain(this.mesh, this.dem, this.view.pos || [0, 0, 0],
      [d[0] / L, d[1] / L, d[2] / L], this.mesh.rMax);
    if (!hit) {
      this.pick = null;
      this.renderer.setWorldLine('pickring', null);
      this.renderer.setWorldLine('pickpin', null);
      this.dirty = true; return;
    }
    this.pick = hit;
    // ring plus a pin, sized against the camera distance so it reads at any zoom
    const cam = this.view.pos || [0, 0, 0];
    const camDist = Math.hypot(hit.x - cam[0], hit.y - cam[1], hit.z - cam[2]);
    const rad = Math.max(25, camDist * 0.022);
    const pts = [];
    for (let i = 0; i <= 56; i++) {
      const t = i / 56 * Math.PI * 2;
      const x = hit.x + Math.cos(t) * rad, z = hit.z + Math.sin(t) * rad;
      pts.push(x, groundYAt(this.mesh, this.dem, x, z) + 6, z);
    }
    this.renderer.setWorldLine('pickring', pts, { color: [1, 0.85, 0.35, 0.95], mode: 'LINE_STRIP' });
    this.renderer.setWorldLine('pickpin',
      [hit.x, hit.y + 4, hit.z, hit.x, hit.y + rad * 2.6, hit.z],
      { color: [1, 0.85, 0.35, 0.9], mode: 'LINE_STRIP' });
    this.ui.refresh();
    this.dirty = true;
  }

  /** Move the observer to the picked point, reusing the elevation pyramid. */
  async standHere() {
    if (!this.pick || !this.dem) return;
    const S = this.S, p = this.pick;
    const fine = this.dem.levels[0];
    const far = haversine(this.dem.lat, this.dem.lon, p.lat, p.lon);
    S.lat = p.lat; S.lon = p.lon;
    S.name = `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
    this.save();
    if (fine && far > fine.radius * 0.55) {
      this.ui.toast('Outside the detailed tiles — fetching this area…');
      this.pick = null;
      this.renderer.setWorldLine('pickring', null);
      this.renderer.setWorldLine('pickpin', null);
      await this.loadTerrain();
      this.toggleAerial(false);
      return;
    }
    const t0 = performance.now();
    const azSteps = { fast: 512, balanced: 768, max: 1024 }[S.quality];
    const mesh = buildMesh(this.dem, S.lat, S.lon, {
      azSteps, rMax: S.rMax, eyeHeight: S.eyeHeight,
      drMax: S.quality === 'max' ? 700 : 900
    });
    this.mesh = mesh;
    this.renderer.setTerrain(mesh);
    this.pick = null;
    this.renderer.setWorldLine('pickring', null);
    this.renderer.setWorldLine('pickpin', null);
    this.orbit.cx = 0; this.orbit.cz = 0;
    this.recomputeNight();
    this.recompute();
    this.ui.toast(`Standing at ${mesh.baseElev.toFixed(0)} m · rebuilt in ${Math.round(performance.now() - t0)} ms`);
    this.ui.refresh();
  }

  /** Ground bearings from the standing point: where the core is now, and the
   *  foreground direction you locked in. Only rebuilt when they actually move. */
  updateGroundLines() {
    if (!this.mesh || !this.dem) return;
    const S = this.S;
    const key = `${this.coreAz.toFixed(1)}|${S.targetAz}|${Math.round(this.mesh.baseElev)}`;
    if (key === this._glKey) return;
    this._glKey = key;
    const ray = (az, color, name) => {
      const pts = [], max = Math.min(this.mesh.rMax * 0.6, 40000);
      for (let d = 0; d <= max; d += Math.max(60, d * 0.02)) {
        const x = d * Math.sin(az * A.DEG), z = -d * Math.cos(az * A.DEG);
        pts.push(x, groundYAt(this.mesh, this.dem, x, z) + 10, z);
      }
      this.renderer.setWorldLine(name, pts, { color, mode: 'LINE_STRIP' });
    };
    ray(this.coreAz, [1, 0.55, 0.26, 0.9], 'coreray');
    if (S.targetAz != null) ray(S.targetAz, [0.37, 0.66, 1, 0.85], 'targetray');
    else this.renderer.setWorldLine('targetray', null);
  }

  /** Flatten the scene plus the overlay into a PNG the user can keep. */
  exportFrame() {
    if (window.__ASTROSCOUT_PREVIEW) {
      this.ui.toast('Saving frames is disabled in this hosted preview — it works in the deployed build.', 4000);
      return;
    }
    const gl = document.getElementById('gl'), hud = document.getElementById('hud');
    const c = document.createElement('canvas');
    c.width = gl.width; c.height = gl.height;
    const x = c.getContext('2d');
    x.drawImage(gl, 0, 0);
    x.drawImage(hud, 0, 0, c.width, c.height);
    const S = this.S, d = new Date(this.date.getTime() + S.tzMin * 60000);
    const stamp = `${S.name} · ${d.toUTCString().slice(0, 22)} · ${Math.round(S.focal)}mm · core ${this.coreAlt.toFixed(0)}° ${P.compass(this.coreAz)}`;
    x.font = `${Math.round(c.height / 52)}px system-ui, sans-serif`;
    x.fillStyle = 'rgba(0,0,0,.55)';
    const w = x.measureText(stamp).width + 24;
    x.fillRect(10, c.height - 46, w, 34);
    x.fillStyle = '#fff'; x.textBaseline = 'middle';
    x.fillText(stamp, 22, c.height - 29);
    c.toBlob(b => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = `astroscout-${S.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${d.toISOString().slice(0, 16).replace(/[:T]/g, '')}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, 'image/png');
    this.ui.toast('Frame saved');
  }

  /* ---------- input ---------- */
  bindInput() {
    const stage = document.getElementById('stage');
    const pts = new Map();
    let lastDist = 0;
    stage.addEventListener('pointerdown', e => {
      if (e.target.closest('#dock,#sheet,#top')) return;
      pts.set(e.pointerId, e); stage.setPointerCapture(e.pointerId);
      this._moved = false; this._downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    stage.addEventListener('pointermove', e => {
      if (!pts.has(e.pointerId)) return;
      const prev = pts.get(e.pointerId);
      pts.set(e.pointerId, e);
      const dx = e.clientX - prev.clientX, dy = e.clientY - prev.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 3) this._moved = true;
      if (pts.size === 1 && this.mode === 'aerial') {
        this.orbit.az = ((this.orbit.az - dx * 0.35) % 360 + 360) % 360;
        this.orbit.pitch = Math.max(8, Math.min(88, this.orbit.pitch + dy * 0.25));
        this.dirty = true;
      } else if (pts.size === 1) {
        const degPerPx = this.view.vfovDeg / (this.renderer.h / this.dpr);
        this.view.az = ((this.view.az - dx * degPerPx) % 360 + 360) % 360;
        this.view.alt = Math.max(-85, Math.min(88, this.view.alt + dy * degPerPx));
        this.dirty = true;
      } else if (pts.size === 2) {
        const a = [...pts.values()];
        const d = Math.hypot(a[0].clientX - a[1].clientX, a[0].clientY - a[1].clientY);
        if (lastDist) this.zoom(d / lastDist);
        lastDist = d;
      }
    });
    const up = e => {
      if (!this._moved && this.mode === 'aerial' && this._downAt &&
          performance.now() - this._downAt.t < 600 && pts.has(e.pointerId)) {
        this.pickAt(e.clientX, e.clientY);
      }
      pts.delete(e.pointerId); if (pts.size < 2) lastDist = 0;
    };
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    stage.addEventListener('wheel', e => { e.preventDefault(); this.zoom(e.deltaY > 0 ? 0.92 : 1.087); }, { passive: false });
    window.addEventListener('keydown', e => {
      const k = e.key;
      if (k === 'ArrowLeft') this.view.az = (this.view.az - 2 + 360) % 360;
      else if (k === 'ArrowRight') this.view.az = (this.view.az + 2) % 360;
      else if (k === 'ArrowUp') this.view.alt = Math.min(88, this.view.alt + 2);
      else if (k === 'ArrowDown') this.view.alt = Math.max(-85, this.view.alt - 2);
      else if (k === '[') this.zoom(0.92);
      else if (k === ']') this.zoom(1.087);
      else if (k === ' ') { e.preventDefault(); this.togglePlay(); }
      else if (k === ',') this.setJD(this.jd - 1 / 144);
      else if (k === '.') this.setJD(this.jd + 1 / 144);
      else return;
      this.dirty = true;
    });
    window.addEventListener('resize', () => { this.dirty = true; });
  }
  zoom(f) {
    if (this.mode === 'aerial') {
      this.orbit.dist = Math.max(400, Math.min(this.mesh ? this.mesh.rMax * 0.75 : 90000, this.orbit.dist / f));
    } else {
      this.S.focal = Math.max(8, Math.min(400, this.S.focal * f));
    }
    this.dirty = true;
  }

  /* ---------- loop ---------- */
  loop() {
    const step = ts => {
      const dt = this._last ? (ts - this._last) / 1000 : 0;
      this._last = ts;
      if (this.playing && dt > 0) {
        this.date = new Date(this.date.getTime() + dt * this.S.speed * 1000);
        this.checkNight();
        this.recompute();
      }
      this.frame();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** Orbit camera: eye sits behind the look-at point, above the ground. */
  aerialCamera() {
    const o = this.orbit;
    const gy = this.mesh && this.dem ? groundYAt(this.mesh, this.dem, o.cx, o.cz) : 0;
    const p = o.pitch * A.DEG, a = o.az * A.DEG;
    const fwd = [Math.cos(p) * Math.sin(a), -Math.sin(p), -Math.cos(p) * Math.cos(a)];
    const eye = [o.cx - fwd[0] * o.dist, gy - fwd[1] * o.dist, o.cz - fwd[2] * o.dist];
    if (this.mesh && this.dem) {
      const floor = groundYAt(this.mesh, this.dem, eye[0], eye[2]) + 120;
      if (eye[1] < floor) eye[1] = floor;
    }
    return { pos: eye, az: o.az, alt: -o.pitch, height: eye[1] - gy };
  }

  frame() {
    const S = this.S, r = this.renderer;
    const stage = document.getElementById('stage');
    r.resize(stage.clientWidth, stage.clientHeight, this.dpr);
    const e = P.exposureAdvice({ focal: S.focal, fNumber: S.fNumber, sensor: S.sensor, megapixels: S.mp });
    const lensV = S.portrait ? e.hfov : e.vfov;

    // ease between the eye-level lens view and the orbit view
    const want = this.mode === 'aerial' ? 1 : 0;
    if (this.blend !== want) {
      const d = 0.09 * (want ? 1 : -1);
      this.blend = Math.max(0, Math.min(1, this.blend + d));
      this.dirty = true;
    }
    const k = this.blend * this.blend * (3 - 2 * this.blend);
    const cam = this.aerialCamera();
    this.view.aerial = this.blend > 0.02;
    this.view.camHeight = cam.height;
    if (k > 0) {
      this.view.pos = [cam.pos[0] * k, cam.pos[1] * k, cam.pos[2] * k];
      this.view.az = this.mode === 'aerial' ? cam.az : this.view.az;
      this.view.alt = this._eyeAlt === undefined ? this.view.alt
        : this._eyeAlt * (1 - k) + cam.alt * k;
      this.view.vfovDeg = Math.max(1.2, Math.min(150, lensV * S.contextZoom)) * (1 - k) + 58 * k;
    } else {
      this.view.pos = [0, 0, 0];
      this.view.vfovDeg = Math.max(1.2, Math.min(150, lensV * S.contextZoom));
    }

    const hidden = new Set();
    if (!S.showFigures || this.skyBright > 0.8) hidden.add('figures');
    if (!S.showGrid) hidden.add('grid');
    if (!S.showGalactic) hidden.add('galactic');
    if (!S.showCorePath || this.view.aerial) hidden.add('corepath');
    if (this.view.aerial) { hidden.add('grid'); }
    if (!this.view.aerial) {
      hidden.add('pickring'); hidden.add('pickpin');
      hidden.add('coreray'); hidden.add('targetray');
    }

    r.draw(this.view, {
      skyMatrix: this.skyMatrixGL, galMatrix: this.galMatrix,
      sunDir: this.sunDir, moonDir: this.moonDir,
      sunAlt: this.sunAlt, moonAlt: this.moonAlt, moonIllum: this.ill.fraction,
      mwGain: S.mwGain, lightPol: S.lightPol, exposure: S.exposure,
      lpColor: [1.0, 0.72, 0.42], skyBright: this.skyBright,
      starGain: S.starGain, magLimit: S.magLimit,
      showStars: S.showStars, showTerrain: S.showTerrain,
      haze: S.haze, foregroundBoost: S.foregroundBoost,
      useImagery: S.useImagery,
      scoutLight: k * S.scoutLight,
      snowLine: this.snowLine || 2600, treeLine: this.treeLine || 1800,
      hiddenLines: hidden
    }, this.bodies);
    if (this.view.aerial) this.updateGroundLines();

    this.ui.drawHUD();
    this.ui.drawTimeline();
    this.updateChips();
    this.dirty = false;
  }

  updateChips() {
    const S = this.S, sum = this.summary;
    const F = j => P.fmtTime(j, S.tzMin);
    const d = new Date(this.date.getTime() + S.tzMin * 60000);
    document.getElementById('clock').textContent =
      `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    document.getElementById('cdate').textContent =
      d.toUTCString().slice(0, 16) + ` · UTC${S.tzMin >= 0 ? '+' : ''}${(S.tzMin / 60).toFixed(1).replace('.0', '')}`;
    document.getElementById('placeName').textContent = S.name;
    document.getElementById('placeSub').textContent =
      `${S.lat.toFixed(4)}, ${S.lon.toFixed(4)}` + (this.mesh ? ` · ${this.mesh.baseElev.toFixed(0)} m` : ' · no terrain');

    const chips = [];
    const clear = this.mesh ? horizonAltAt(this.mesh, this.coreAz) : 0;
    const above = this.coreAlt > clear;
    chips.push(`<div class="chip core">CORE <b>${this.coreAlt.toFixed(0)}° ${P.compass(this.coreAz)}</b>${this.mesh ? ` · skyline ${clear.toFixed(0)}°` : ''}</div>`);
    chips.push(`<div class="chip ${this.sunAlt < -18 ? 'good' : this.sunAlt < -12 ? '' : 'warn'}">sun <b>${this.sunAlt.toFixed(0)}°</b> ${this.sunAlt < -18 ? 'astro dark' : this.sunAlt < -12 ? 'nautical' : this.sunAlt < -6 ? 'civil' : this.sunAlt < 0 ? 'twilight' : 'day'}</div>`);
    chips.push(`<div class="chip moon">moon <b>${(this.ill.fraction * 100).toFixed(0)}%</b> ${this.moonAlt > 0 ? `up ${this.moonAlt.toFixed(0)}°` : 'down'}</div>`);
    const e = P.exposureAdvice({ focal: S.focal, fNumber: S.fNumber, sensor: S.sensor, megapixels: S.mp, decl: this.coreDec });
    chips.push(`<div class="chip">${Math.round(S.focal)}mm f/${S.fNumber.toFixed(1)} · <b>${e.npf.toFixed(0)}s</b> · ISO ${e.suggestedISO}</div>`);
    if (!sum.hasAstroDark) chips.push(`<div class="chip warn">no astro dark tonight <b>(${sum.darkestSunAlt.toFixed(0)}°)</b></div>`);
    document.getElementById('chips').innerHTML = chips.join('');
  }
}

/* helpers */
function glMat3(m) { return new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]); }
function transpose3(m) { return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]; }
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
function smoothstep(a, b, x) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

UI.prototype.refresh = function () {
  if (this.sheet.classList.contains('open')) this.renderSheet();
  this.app.invalidate();
};

const app = new App();
window.app = app;
app.init();
