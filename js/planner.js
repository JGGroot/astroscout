/* planner.js — turning the astronomy into shooting decisions.
 *
 * A "night" runs from local noon to the following local noon, which is how
 * photographers actually talk about it: the night of the 12th includes 2 a.m.
 * on the 13th.
 */

import * as A from './astro.js';

export const DARK = { civil: -6, nautical: -12, astronomical: -18 };

/** Local-noon Julian Day for a calendar date at a given UTC offset (minutes). */
export function noonJD(y, m, d, tzMin) {
  return A.julianDay(new Date(Date.UTC(y, m, d, 12, 0, 0))) - tzMin / 1440;
}

/** Sample the whole night. step in minutes. */
export function sampleNight(jdNoon, lat, lon, { step = 4, horizonFn = null } = {}) {
  const n = Math.round(1440 / step) + 1;
  const t = new Float64Array(n), sunAlt = new Float32Array(n), sunAz = new Float32Array(n);
  const moonAlt = new Float32Array(n), moonAz = new Float32Array(n), moonIll = new Float32Array(n);
  const gcAlt = new Float32Array(n), gcAz = new Float32Array(n), gcClear = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const jd = jdNoon + i * step / 1440;
    t[i] = jd;
    const lst = A.lstDeg(jd, lon), jde = A.jdeFromJD(jd);
    const s = A.sunPosition(jde);
    let h = A.eqToHorizon(s.ra, s.dec, lst, lat);
    sunAlt[i] = h.alt; sunAz[i] = h.az;
    const mo = A.moonPosition(jde);
    h = A.eqToHorizon(mo.ra, mo.dec, lst, lat);
    // topocentric correction: the Moon is close enough for parallax to matter
    moonAlt[i] = h.alt - mo.parallax * Math.cos(h.alt * A.DEG);
    moonAz[i] = h.az;
    moonIll[i] = A.moonIllumination(jde).fraction;
    const g = A.gcAt(jd);
    h = A.eqToHorizon(g.ra, g.dec, lst, lat);
    gcAlt[i] = h.alt; gcAz[i] = h.az;
    gcClear[i] = horizonFn ? (h.alt > horizonFn(h.az) ? 1 : 0) : (h.alt > 0 ? 1 : 0);
  }
  return { t, n, step, sunAlt, sunAz, moonAlt, moonAz, moonIll, gcAlt, gcAz, gcClear, jdNoon, lat, lon };
}

function crossings(arr, t, level, rising) {
  const out = [];
  for (let i = 1; i < arr.length; i++) {
    const a = arr[i - 1] - level, b = arr[i] - level;
    if (rising ? (a < 0 && b >= 0) : (a > 0 && b <= 0)) {
      const f = a / (a - b);
      out.push(t[i - 1] + (t[i] - t[i - 1]) * f);
    }
  }
  return out;
}

/** Key event times for the night, as Julian Days. */
export function nightSummary(s) {
  const ev = {};
  ev.sunset = crossings(s.sunAlt, s.t, -0.833, false)[0];
  ev.sunrise = crossings(s.sunAlt, s.t, -0.833, true).pop();
  ev.duskCivil = crossings(s.sunAlt, s.t, DARK.civil, false)[0];
  ev.dawnCivil = crossings(s.sunAlt, s.t, DARK.civil, true).pop();
  ev.duskNaut = crossings(s.sunAlt, s.t, DARK.nautical, false)[0];
  ev.dawnNaut = crossings(s.sunAlt, s.t, DARK.nautical, true).pop();
  ev.duskAstro = crossings(s.sunAlt, s.t, DARK.astronomical, false)[0];
  ev.dawnAstro = crossings(s.sunAlt, s.t, DARK.astronomical, true).pop();
  ev.moonrise = crossings(s.moonAlt, s.t, 0, true);
  ev.moonset = crossings(s.moonAlt, s.t, 0, false);
  ev.coreRise = crossings(s.gcAlt, s.t, 0, true)[0];
  ev.coreSet = crossings(s.gcAlt, s.t, 0, false).pop();
  let best = -1, bi = 0;
  for (let i = 0; i < s.n; i++) if (s.gcAlt[i] > best) { best = s.gcAlt[i]; bi = i; }
  ev.coreTransit = s.t[bi]; ev.coreMaxAlt = best; ev.coreTransitAz = s.gcAz[bi];
  let minSun = 90;
  for (let i = 0; i < s.n; i++) minSun = Math.min(minSun, s.sunAlt[i]);
  ev.darkestSunAlt = minSun;
  ev.hasAstroDark = minSun < DARK.astronomical;
  ev.moonIllumMax = Math.max(...s.moonIll);
  return ev;
}

/**
 * Merge the constraints into shootable windows.
 * opts: { sunMax (deg), moonMax (deg, moon altitude ceiling), moonIllumFree,
 *         coreMinAlt, targetAz, azTol, useTerrain }
 */
export function shootWindows(s, opts = {}) {
  const {
    sunMax = DARK.astronomical, moonMaxAlt = 0, moonIllumFree = 0.10,
    coreMinAlt = 5, targetAz = null, azTol = 45, requireCore = true
  } = opts;
  const ok = new Uint8Array(s.n);
  for (let i = 0; i < s.n; i++) {
    let good = s.sunAlt[i] <= sunMax;
    if (good) good = (s.moonAlt[i] <= moonMaxAlt) || (s.moonIll[i] <= moonIllumFree);
    if (good && requireCore) {
      good = s.gcAlt[i] >= coreMinAlt && s.gcClear[i] === 1;
      if (good && targetAz !== null)
        good = Math.abs(A.normPM180(s.gcAz[i] - targetAz)) <= azTol;
    }
    ok[i] = good ? 1 : 0;
  }
  const win = [];
  let start = -1;
  for (let i = 0; i < s.n; i++) {
    if (ok[i] && start < 0) start = i;
    if ((!ok[i] || i === s.n - 1) && start >= 0) {
      const end = ok[i] ? i : i - 1;
      if (end > start) {
        let maxAlt = -90, maxI = start, sumIll = 0;
        for (let k = start; k <= end; k++) { if (s.gcAlt[k] > maxAlt) { maxAlt = s.gcAlt[k]; maxI = k; } sumIll += s.moonIll[k]; }
        win.push({
          from: s.t[start], to: s.t[end],
          minutes: (s.t[end] - s.t[start]) * 1440,
          peakJD: s.t[maxI], peakAlt: maxAlt, peakAz: s.gcAz[maxI],
          meanMoonIllum: sumIll / (end - start + 1)
        });
      }
      start = -1;
    }
  }
  return win;
}

/** When does the core cross a given azimuth? Returns [{jd, alt}] */
export function coreAzimuthCrossings(s, targetAz) {
  const out = [];
  for (let i = 1; i < s.n; i++) {
    const a = A.normPM180(s.gcAz[i - 1] - targetAz), b = A.normPM180(s.gcAz[i] - targetAz);
    if (Math.abs(a) < 90 && Math.abs(b) < 90 && ((a <= 0 && b > 0) || (a >= 0 && b < 0))) {
      const f = a / (a - b);
      const jd = s.t[i - 1] + (s.t[i] - s.t[i - 1]) * f;
      out.push({ jd, alt: s.gcAlt[i - 1] + (s.gcAlt[i] - s.gcAlt[i - 1]) * f });
    }
  }
  return out;
}

/** Rank nights over a date range. */
export function findBestNights(startDate, days, lat, lon, tzMin, opts = {}) {
  const out = [];
  for (let d = 0; d < days; d++) {
    const dt = new Date(startDate.getTime() + d * 86400000);
    const jdNoon = noonJD(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), tzMin);
    const s = sampleNight(jdNoon, lat, lon, { step: opts.step || 10, horizonFn: opts.horizonFn });
    const sum = nightSummary(s);
    const wins = shootWindows(s, opts);
    const total = wins.reduce((a, w) => a + w.minutes, 0);
    let peak = null;
    for (const w of wins) if (!peak || w.peakAlt > peak.peakAlt) peak = w;
    // score: usable minutes, weighted by how high the core gets and how dark it is
    const altW = peak ? Math.min(1, Math.max(0, peak.peakAlt / 35)) : 0;
    const moonW = peak ? 1 - 0.75 * Math.min(1, peak.meanMoonIllum) : 0;
    const alignW = (opts.targetAz != null && peak)
      ? Math.max(0, 1 - Math.abs(A.normPM180(peak.peakAz - opts.targetAz)) / 90) : 1;
    const score = total * (0.35 + 0.65 * altW) * (0.4 + 0.6 * moonW) * (0.5 + 0.5 * alignW);
    out.push({ date: dt, jdNoon, summary: sum, windows: wins, totalMinutes: total, score, peak });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/* ---------- exposure ---------- */
export const SENSORS = {
  'Full frame':   { w: 36, h: 24, crop: 1 },
  'APS-C (1.5x)': { w: 23.5, h: 15.6, crop: 1.5 },
  'APS-C (1.6x)': { w: 22.3, h: 14.9, crop: 1.6 },
  'Micro 4/3':    { w: 17.3, h: 13, crop: 2 },
  '1 inch':       { w: 13.2, h: 8.8, crop: 2.7 },
  'Phone (1/1.7")': { w: 7.6, h: 5.7, crop: 4.7 },
  'Medium format (44x33)': { w: 44, h: 33, crop: 0.79 }
};

export function exposureAdvice({ focal, fNumber, sensor, megapixels, decl = 0, accuracy = 'default' }) {
  const s = SENSORS[sensor] || SENSORS['Full frame'];
  const px = Math.sqrt(megapixels * 1e6 * (s.w / s.h));
  const k = accuracy === 'strict' ? 1 : accuracy === 'loose' ? 2 : 1.4;
  const npf = A.npfSeconds(focal, fNumber, s.w, px, decl, k);
  const r500 = A.rule500(focal, s.crop);
  const hfov = A.fovDeg(s.w, focal), vfov = A.fovDeg(s.h, focal);
  // rough ISO suggestion for a single untracked frame at f/N and t seconds
  const ev = Math.log2((fNumber * fNumber) / Math.max(0.5, npf));
  const iso = Math.min(12800, Math.max(800, Math.round(1600 * Math.pow(2, ev + 3.5) / 16 / 100) * 100));
  return { npf, rule500: r500, hfov, vfov, pixelPitchUm: s.w / px * 1000, suggestedISO: iso, sensor: s };
}

/* ---------- formatting ---------- */
export function fmtTime(jd, tzMin, withDate = false) {
  if (jd === undefined || jd === null || !isFinite(jd)) return '—';
  const d = new Date((jd - 2440587.5) * 86400000 + tzMin * 60000);
  const hh = String(d.getUTCHours()).padStart(2, '0'), mm = String(d.getUTCMinutes()).padStart(2, '0');
  if (!withDate) return `${hh}:${mm}`;
  return `${d.getUTCDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]} ${hh}:${mm}`;
}
export function fmtDur(min) {
  if (!isFinite(min) || min <= 0) return '—';
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}
export function compass(az) {
  const names = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return names[Math.round(((az % 360) + 360) % 360 / 22.5) % 16];
}
