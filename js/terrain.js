/* terrain.js — DEM tile fetching, elevation pyramid, and viewer-centric mesh.
 *
 * Elevation comes from open raster-DEM tiles (Terrarium encoding by default,
 * Mapbox Terrain-RGB optionally). Tiles are cached in IndexedDB so a location
 * scouted on wifi still works with no signal in the field.
 *
 * The mesh is polar and centred on the observer: fine rings underfoot, coarse
 * rings out to the horizon, which is the right sampling for a camera standing
 * on the ground. Earth curvature and standard atmospheric refraction are baked
 * into the vertex heights, so distant peaks sit where they really appear.
 */

import { DEG, RAD } from './astro.js';

export const R_EARTH = 6371000;
export const K_REFRACTION = 1.16;           // effective-radius factor, standard air
export const R_EFF = R_EARTH * K_REFRACTION;

/* ---------- tile sources ---------- */
export const DEM_SOURCES = {
  terrarium: {
    name: 'AWS Terrain Tiles',
    url: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
    decode: (r, g, b) => (r * 256 + g + b / 256) - 32768,
    maxZoom: 15, attribution: 'Elevation: AWS Terrain Tiles / Mapzen'
  },
  terrariumAlt: {
    name: 'AWS Terrain Tiles (alt host)',
    url: (z, x, y) => `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${z}/${x}/${y}.png`,
    decode: (r, g, b) => (r * 256 + g + b / 256) - 32768,
    maxZoom: 15, attribution: 'Elevation: AWS Terrain Tiles / Mapzen'
  },
  mapbox: {
    name: 'Mapbox Terrain-RGB (needs token)',
    url: (z, x, y, key) => `https://api.mapbox.com/v4/mapbox.terrain-rgb/${z}/${x}/${y}.pngraw?access_token=${key}`,
    decode: (r, g, b) => -10000 + (r * 65536 + g * 256 + b) * 0.1,
    maxZoom: 15, needsKey: true, attribution: 'Elevation: Mapbox'
  },
  maptiler: {
    name: 'MapTiler Terrain-RGB (needs key)',
    url: (z, x, y, key) => `https://api.maptiler.com/tiles/terrain-rgb-v2/${z}/${x}/${y}.webp?key=${key}`,
    decode: (r, g, b) => -10000 + (r * 65536 + g * 256 + b) * 0.1,
    maxZoom: 14, needsKey: true, attribution: 'Elevation: MapTiler'
  }
};

export const IMAGERY_SOURCES = {
  esri: {
    name: 'Esri World Imagery',
    url: (z, x, y) => `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    maxZoom: 19, attribution: 'Imagery: Esri, Maxar, Earthstar Geographics'
  },
  osm: {
    name: 'OpenStreetMap',
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    maxZoom: 19, attribution: '© OpenStreetMap contributors'
  },
  topo: {
    name: 'Esri Topographic',
    url: (z, x, y) => `https://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/${z}/${y}/${x}`,
    maxZoom: 19, attribution: 'Esri, USGS, NOAA'
  }
};

/* ---------- web mercator ---------- */
export function lonToTileX(lon, z) { return (lon + 180) / 360 * (1 << z); }
export function latToTileY(lat, z) {
  const s = Math.sin(lat * DEG);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * (1 << z);
}
export function tileXToLon(x, z) { return x / (1 << z) * 360 - 180; }
export function tileYToLat(y, z) {
  const n = Math.PI - 2 * Math.PI * y / (1 << z);
  return RAD * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}
/** Ground metres per tile pixel at a given latitude/zoom (256 px tiles). */
export function metresPerPixel(lat, z) {
  return 156543.03392 * Math.cos(lat * DEG) / (1 << z);
}

/** Destination point given start, bearing (deg from north) and distance (m). */
export function destPoint(lat, lon, bearingDeg, dist) {
  const d = dist / R_EARTH, br = bearingDeg * DEG;
  const p1 = lat * DEG, l1 = lon * DEG;
  const sp = Math.sin(p1), cp = Math.cos(p1), sd = Math.sin(d), cd = Math.cos(d);
  const p2 = Math.asin(sp * cd + cp * sd * Math.cos(br));
  const l2 = l1 + Math.atan2(Math.sin(br) * sd * cp, cd - sp * Math.sin(p2));
  return [p2 * RAD, ((l2 * RAD + 540) % 360) - 180];
}
/** Great-circle distance in metres. */
export function haversine(lat1, lon1, lat2, lon2) {
  const dp = (lat2 - lat1) * DEG, dl = (lon2 - lon1) * DEG;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}
/** Initial bearing in degrees from north. */
export function bearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * DEG, p2 = lat2 * DEG, dl = (lon2 - lon1) * DEG;
  return (Math.atan2(Math.sin(dl) * Math.cos(p2),
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * RAD + 360) % 360;
}

/* ---------- persistent tile cache ---------- */
const DB_NAME = 'astroscout-tiles', DB_STORE = 'tiles', DB_VERSION = 1;
let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((res, rej) => {
    if (typeof indexedDB === 'undefined') return rej(new Error('no indexedDB'));
    const rq = indexedDB.open(DB_NAME, DB_VERSION);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  }).catch(() => null);
  return dbPromise;
}
async function cacheGet(key) {
  const db = await openDB(); if (!db) return null;
  return new Promise(res => {
    const tx = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key);
    tx.onsuccess = () => res(tx.result || null); tx.onerror = () => res(null);
  });
}
async function cachePut(key, val) {
  const db = await openDB(); if (!db) return;
  try {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(val, key);
  } catch (e) { /* quota — not fatal */ }
}
export async function cacheStats() {
  const db = await openDB(); if (!db) return { count: 0, bytes: 0 };
  return new Promise(res => {
    let count = 0, bytes = 0;
    const st = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE);
    const cur = st.openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return res({ count, bytes });
      count++; bytes += (c.value && c.value.byteLength) || 0; c.continue();
    };
    cur.onerror = () => res({ count, bytes });
  });
}
export async function cacheClear() {
  const db = await openDB(); if (!db) return;
  db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).clear();
}

/* ---------- tile fetching / decoding ---------- */
const memTiles = new Map();          // url -> Float32Array | ImageBitmap
const inflight = new Map();

function drawToData(bitmap, size) {
  const c = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(size, size)
    : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0, size, size);
  return g.getImageData(0, 0, size, size).data;
}

async function fetchBytes(url, useCache = true) {
  if (useCache) {
    const hit = await cacheGet(url);
    if (hit) return hit;
  }
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      const buf = await res.arrayBuffer();
      if (useCache) cachePut(url, buf);
      return buf;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 180 * (attempt + 1)));
    }
  }
  throw lastError;
}

/** Fetch and decode one DEM tile into a Float32Array of elevations (metres). */
export async function fetchDemTile(src, z, x, y, key) {
  const n = 1 << z;
  x = ((x % n) + n) % n;
  if (y < 0 || y >= n) return null;
  const url = src.url(z, x, y, key);
  if (memTiles.has(url)) return memTiles.get(url);
  if (inflight.has(url)) return inflight.get(url);
  const p = (async () => {
    const buf = await fetchBytes(url);
    const bmp = await createImageBitmap(new Blob([buf]));
    const size = bmp.width || 256;
    const px = drawToData(bmp, size);
    bmp.close && bmp.close();
    const out = new Float32Array(size * size);
    let valid = 0;
    for (let i = 0, j = 0; i < out.length; i++, j += 4) {
      out[i] = src.decode(px[j], px[j + 1], px[j + 2]);
      // Terrarium uses -32768 for missing coverage. Do not let a formally
      // successful but empty high-zoom tile bury usable coarser terrain.
      if (Number.isFinite(out[i]) && out[i] > -12000 && out[i] < 10000) valid++;
    }
    if (!valid) return null;
    out.size = size;
    memTiles.set(url, out);
    return out;
  })().catch(err => { memTiles.set(url, null); return null; })
    .finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
}

/** Probe every configured source with a single tile, so a failure in the field
 *  tells you which host is unreachable rather than just "no tiles". */
export async function probeSources(lat, lon, keys = {}) {
  const z = 10, x = Math.floor(lonToTileX(lon, z)), y = Math.floor(latToTileY(lat, z));
  const out = [];
  const timed = async (label, url, kind) => {
    const t0 = performance.now();
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 9000);
      const res = await fetch(url, { mode: 'cors', credentials: 'omit', signal: ctl.signal, cache: 'no-store' });
      clearTimeout(timer);
      const buf = await res.arrayBuffer();
      out.push({ label, kind, ok: res.ok && buf.byteLength > 200, status: res.status,
        bytes: buf.byteLength, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      out.push({ label, kind, ok: false, error: e.name === 'AbortError' ? 'timed out' : (e.message || 'blocked'),
        ms: Math.round(performance.now() - t0) });
    }
  };
  for (const [k, src] of Object.entries(DEM_SOURCES)) {
    if (src.needsKey && !keys[k]) { out.push({ label: src.name, kind: 'elevation', ok: false, error: 'no key set' }); continue; }
    await timed(src.name, src.url(z, x, y, keys[k]), 'elevation');
  }
  for (const [k, src] of Object.entries(IMAGERY_SOURCES)) await timed(src.name, src.url(z, x, y), 'imagery');
  await timed('Nominatim search', 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=zermatt', 'search');
  return out;
}

/* ---------- elevation pyramid ---------- */
export class DemPyramid {
  /** levels: [{z, tiles:Map(key->Float32Array), x0,y0,nx,ny}] finest first */
  constructor() { this.levels = []; this.src = DEM_SOURCES.terrarium; this.key = null; }

  /** Plan and load the tiles needed for a viewer at (lat,lon) seeing `radius` m.
   *  onProgress(loaded, total). */
  async load(lat, lon, plan, { onProgress, signal } = {}) {
    this.lat = lat; this.lon = lon;
    this.levels = [];
    const jobs = [];
    for (const step of plan) {
      const z = Math.min(step.z, this.src.maxZoom);
      const cx = lonToTileX(lon, z), cy = latToTileY(lat, z);
      // tile span needed to cover +-radius metres
      const mpt = metresPerPixel(lat, z) * 256;
      const half = Math.max(0, Math.ceil(step.radius / mpt));
      const level = { z, x0: Math.floor(cx) - half, y0: Math.floor(cy) - half, n: half * 2 + 1, tiles: new Map(), radius: step.radius };
      this.levels.push(level);
      for (let dy = 0; dy < level.n; dy++) for (let dx = 0; dx < level.n; dx++) {
        jobs.push({ level, tx: level.x0 + dx, ty: level.y0 + dy, z });
      }
    }
    let done = 0;
    const total = jobs.length;
    const CONC = 8;
    let idx = 0;
    const worker = async () => {
      while (idx < jobs.length) {
        if (signal && signal.aborted) return;
        const j = jobs[idx++];
        const t = await fetchDemTile(this.src, j.z, j.tx, j.ty, this.key);
        if (t) j.level.tiles.set(j.tx + ',' + j.ty, t);
        done++;
        onProgress && onProgress(done, total);
      }
    };
    await Promise.all(Array.from({ length: CONC }, worker));
    this.loadedTiles = done;
    return this;
  }

  /** Bilinear elevation in metres, from the finest level that has the tile. */
  sample(lat, lon) {
    for (const lv of this.levels) {
      const fx = lonToTileX(lon, lv.z), fy = latToTileY(lat, lv.z);
      const tx = Math.floor(fx), ty = Math.floor(fy);
      const t = lv.tiles.get(tx + ',' + ty);
      if (!t) continue;
      const S = t.size;
      let px = (fx - tx) * S - 0.5, py = (fy - ty) * S - 0.5;
      const x0 = Math.floor(px), y0 = Math.floor(py);
      const ax = px - x0, ay = py - y0;
      const at = (X, Y) => {
        let cx = tx, cy = ty, sx = X, sy = Y;
        if (sx < 0) { cx--; sx += S; } else if (sx >= S) { cx++; sx -= S; }
        if (sy < 0) { cy--; sy += S; } else if (sy >= S) { cy++; sy -= S; }
        const tt = (cx === tx && cy === ty) ? t : lv.tiles.get(cx + ',' + cy);
        if (!tt) return t[Math.min(S - 1, Math.max(0, Y)) * S + Math.min(S - 1, Math.max(0, X))];
        return tt[sy * S + sx];
      };
      const h00 = at(x0, y0), h10 = at(x0 + 1, y0), h01 = at(x0, y0 + 1), h11 = at(x0 + 1, y0 + 1);
      const value = (h00 * (1 - ax) + h10 * ax) * (1 - ay) + (h01 * (1 - ax) + h11 * ax) * ay;
      if (Number.isFinite(value) && value > -12000 && value < 10000) return value;
      // A no-data pixel in a fine tile should fall through to the next level.
    }
    return 0;
  }
  get attribution() { return this.src.attribution; }
}

/** Default tile plan. `quality` scales how much is fetched. */
export function tilePlan(quality = 'balanced') {
  switch (quality) {
    case 'fast':  return [{ z: 12, radius: 8000 }, { z: 10, radius: 45000 }, { z: 8, radius: 140000 }];
    case 'max':   return [{ z: 14, radius: 9000 }, { z: 12, radius: 40000 }, { z: 10, radius: 110000 }, { z: 8, radius: 260000 }];
    default:      return [{ z: 13, radius: 9000 }, { z: 11, radius: 45000 }, { z: 9, radius: 180000 }];
  }
}

/* ---------- mesh construction ---------- */
/** Radial ring radii from r0 out to rMax with distance-proportional spacing. */
export function ringRadii(r0, rMax, growth, drMin, drMax) {
  const rs = [0];
  let r = r0;
  while (r < rMax) {
    rs.push(r);
    r += Math.min(drMax, Math.max(drMin, r * growth));
  }
  rs.push(rMax);
  return rs;
}

/**
 * Build the terrain mesh in render space: x = East, y = Up, z = South.
 * Returns typed arrays ready for WebGL plus a horizon profile.
 */
export function buildMesh(dem, lat, lon, opts = {}) {
  const {
    azSteps = 768, rMax = 160000, eyeHeight = 1.6,
    growth = 0.035, drMin = 8, drMax = 900, exaggeration = 1.0
  } = opts;
  const radii = ringRadii(6, rMax, growth, drMin, drMax);
  const NR = radii.length, NA = azSteps;
  const baseElev = dem.sample(lat, lon);
  const eyeY = baseElev + eyeHeight;

  const nVerts = NR * NA;
  const pos = new Float32Array(nVerts * 3);
  const geo = new Float32Array(nVerts * 2);      // lon/lat per vertex, for imagery lookup
  const nrm = new Float32Array(nVerts * 3);
  const elevArr = new Float32Array(nVerts);
  const horizon = new Float32Array(NA).fill(-90);   // max apparent altitude per azimuth
  const horizonDist = new Float32Array(NA);

  const cosA = new Float32Array(NA), sinA = new Float32Array(NA);
  for (let a = 0; a < NA; a++) {
    const th = a / NA * 2 * Math.PI;              // bearing from north, eastward
    sinA[a] = Math.sin(th); cosA[a] = Math.cos(th);
  }

  for (let i = 0; i < NR; i++) {
    const d = radii[i];
    const drop = d * d / (2 * R_EFF);
    for (let a = 0; a < NA; a++) {
      const k = i * NA + a;
      const [plat, plon] = destPoint(lat, lon, a / NA * 360, d);
      const h = d === 0 ? baseElev : dem.sample(plat, plon);
      const y = (h - baseElev) * exaggeration + baseElev - eyeY - drop;
      pos[k * 3] = d * sinA[a];
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = -d * cosA[a];
      geo[k * 2] = plon; geo[k * 2 + 1] = plat;
      elevArr[k] = h;
      if (d > 30) {
        const alt = Math.atan2(y, d) * RAD;
        if (alt > horizon[a]) { horizon[a] = alt; horizonDist[a] = d; }
      }
    }
  }

  // normals from the polar grid
  for (let i = 0; i < NR; i++) {
    for (let a = 0; a < NA; a++) {
      const k = i * NA + a;
      const kp = i * NA + (a + 1) % NA, km = i * NA + (a + NA - 1) % NA;
      const ki = Math.min(NR - 1, i + 1) * NA + a, kj = Math.max(0, i - 1) * NA + a;
      const ax = pos[kp * 3] - pos[km * 3], ay = pos[kp * 3 + 1] - pos[km * 3 + 1], az = pos[kp * 3 + 2] - pos[km * 3 + 2];
      const bx = pos[ki * 3] - pos[kj * 3], by = pos[ki * 3 + 1] - pos[kj * 3 + 1], bz = pos[ki * 3 + 2] - pos[kj * 3 + 2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const L = Math.hypot(nx, ny, nz) || 1;
      nx /= L; ny /= L; nz /= L;
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
      nrm[k * 3] = nx; nrm[k * 3 + 1] = ny; nrm[k * 3 + 2] = nz;
    }
  }

  // indices
  const quads = (NR - 1) * NA;
  const idx = quads * 6 > 65535 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
  let o = 0;
  for (let i = 0; i < NR - 1; i++) {
    for (let a = 0; a < NA; a++) {
      const a1 = (a + 1) % NA;
      const v00 = i * NA + a, v01 = i * NA + a1;
      const v10 = (i + 1) * NA + a, v11 = (i + 1) * NA + a1;
      idx[o++] = v00; idx[o++] = v10; idx[o++] = v11;
      idx[o++] = v00; idx[o++] = v11; idx[o++] = v01;
    }
  }
  return {
    pos, nrm, geo, elev: elevArr, idx, nVerts, nIdx: o,
    radii, azSteps: NA, rMax, baseElev, eyeY, eyeHeight,
    horizon, horizonDist, lat, lon
  };
}

/** Render-space ground height (metres, y) at a horizontal offset from the
 *  observer, using the same curvature and eye-height convention as buildMesh. */
export function groundYAt(mesh, dem, x, z) {
  const d = Math.hypot(x, z);
  if (d < 1e-6) return mesh.baseElev - mesh.eyeY;
  const az = (Math.atan2(x, -z) * RAD + 360) % 360;
  const [plat, plon] = destPoint(mesh.lat, mesh.lon, az, d);
  const h = dem.sample(plat, plon);
  return h - mesh.eyeY - d * d / (2 * R_EFF);
}

/** March a ray against the height field. origin and dir are render-space.
 *  Returns {x, z, y, dist, lat, lon, elev} or null. */
export function raycastTerrain(mesh, dem, origin, dir, maxDist) {
  const max = maxDist || mesh.rMax;
  let t = 2, prevT = 0, prevGap = null;
  while (t < max) {
    const px = origin[0] + dir[0] * t, py = origin[1] + dir[1] * t, pz = origin[2] + dir[2] * t;
    if (Math.hypot(px, pz) > mesh.rMax) break;
    const gap = py - groundYAt(mesh, dem, px, pz);
    if (prevGap !== null && prevGap > 0 && gap <= 0) {
      let a = prevT, b = t;
      for (let i = 0; i < 30; i++) {
        const m = (a + b) / 2;
        const mx = origin[0] + dir[0] * m, my = origin[1] + dir[1] * m, mz = origin[2] + dir[2] * m;
        (my - groundYAt(mesh, dem, mx, mz) > 0) ? a = m : b = m;
      }
      const hx = origin[0] + dir[0] * b, hy = origin[1] + dir[1] * b, hz = origin[2] + dir[2] * b;
      const d = Math.hypot(hx, hz);
      const az = (Math.atan2(hx, -hz) * RAD + 360) % 360;
      const [lat, lon] = destPoint(mesh.lat, mesh.lon, az, d);
      return { x: hx, y: hy, z: hz, dist: b, groundDist: d, az, lat, lon, elev: dem.sample(lat, lon) };
    }
    prevGap = gap; prevT = t;
    t += Math.max(4, t * 0.02);
  }
  return null;
}

/** Apparent altitude of the skyline at a given azimuth, degrees. */
export function horizonAltAt(mesh, azDeg) {
  const NA = mesh.azSteps;
  const f = ((azDeg % 360) + 360) % 360 / 360 * NA;
  const i0 = Math.floor(f) % NA, i1 = (i0 + 1) % NA, t = f - Math.floor(f);
  return mesh.horizon[i0] * (1 - t) + mesh.horizon[i1] * t;
}

/* ---------- satellite imagery composite ---------- */
/** Build one RGBA texture covering a square of `radius` metres around the
 *  observer, in web-mercator pixel space. Returns {canvas, bounds}. */
export async function buildImagery(src, lat, lon, radius, zoom, onProgress, key) {
  const z = Math.min(zoom, src.maxZoom);
  const mpt = metresPerPixel(lat, z) * 256;
  const half = Math.max(1, Math.ceil(radius / mpt));
  const cx = Math.floor(lonToTileX(lon, z)), cy = Math.floor(latToTileY(lat, z));
  const n = half * 2 + 1, S = 256;
  const size = n * S;
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(size, size)
    : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const g = canvas.getContext('2d');
  g.fillStyle = '#1a1c20'; g.fillRect(0, 0, size, size);
  let done = 0, loaded = 0, total = n * n;
  const jobs = [];
  for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) jobs.push([dx, dy]);
  let i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const [dx, dy] = jobs[i++];
      const tx = cx - half + dx, ty = cy - half + dy;
      const nn = 1 << z;
      if (ty < 0 || ty >= nn) { done++; continue; }
      try {
        const buf = await fetchBytes(src.url(z, ((tx % nn) + nn) % nn, ty, key));
        const bmp = await createImageBitmap(new Blob([buf]));
        g.drawImage(bmp, dx * S, dy * S, S, S);
        loaded++;
        bmp.close && bmp.close();
      } catch (e) { /* leave the hole */ }
      done++; onProgress && onProgress(done, total);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return {
    canvas,
    // mercator tile-space bounds of the composite
    x0: cx - half, y0: cy - half, n, z, size, loaded, total,
    lonToU: lonv => (lonToTileX(lonv, z) - (cx - half)) / n,
    latToV: latv => (latToTileY(latv, z) - (cy - half)) / n
  };
}
