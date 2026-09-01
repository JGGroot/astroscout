/* astro.js — astronomical engine for AstroScout
 * Zero dependencies. Works in browsers and in Node (ESM).
 *
 * Algorithms follow Jean Meeus, "Astronomical Algorithms", 2nd ed.
 *   - Sidereal time            ch. 12
 *   - Nutation & obliquity     ch. 22
 *   - Precession               ch. 21
 *   - Solar position           ch. 25
 *   - Lunar position (ELP tr.) ch. 47
 *   - Illuminated fraction     ch. 48
 * Planets use the JPL "Keplerian elements for approximate positions of the
 * major planets" (Standish), valid 1800-2050 to about an arcminute.
 */

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
const sin = Math.sin, cos = Math.cos, tan = Math.tan, atan2 = Math.atan2;
const asin = Math.asin, sqrt = Math.sqrt, abs = Math.abs, floor = Math.floor;

/* ---------- angle helpers ---------- */
export function norm360(x) { x = x % 360; return x < 0 ? x + 360 : x; }
export function norm2pi(x) { x = x % (2 * Math.PI); return x < 0 ? x + 2 * Math.PI : x; }
export function normPM180(x) { x = norm360(x); return x > 180 ? x - 360 : x; }
const sind = d => sin(d * DEG), cosd = d => cos(d * DEG), tand = d => tan(d * DEG);

/* ---------- time ---------- */
export const J2000 = 2451545.0;

/** Julian Day (UT) from a JS Date. */
export function julianDay(date) { return date.getTime() / 86400000 + 2440587.5; }
export function dateFromJD(jd) { return new Date((jd - 2440587.5) * 86400000); }

/** Approximate TT-UT1 in seconds. Flat ~69s through the 2020s; Espenak/Meeus
 *  polynomials outside that. Sub-second accuracy is irrelevant here (1 s of
 *  time = 15 arcsec of Earth rotation) but the shape matters for old dates. */
export function deltaT(jd) {
  const y = 2000 + (jd - J2000) / 365.25;
  if (y >= 2015 && y <= 2035) return 69.0 + 0.10 * (y - 2020);
  if (y >= 2005 && y < 2015) { const t = y - 2000; return 62.92 + 0.32217 * t + 0.005589 * t * t; }
  if (y > 2035 && y <= 2150) { const u = (y - 1820) / 100; return -20 + 32 * u * u - 0.5628 * (2150 - y); }
  if (y >= 1986 && y < 2005) { const t = y - 2000; return 63.86 + 0.3345 * t - 0.060374 * t * t + 0.0017275 * t * t * t + 0.000651814 * t ** 4 + 0.00002373599 * t ** 5; }
  const u = (y - 1820) / 100; return -20 + 32 * u * u;
}
/** Julian Ephemeris Day (TT) from Julian Day (UT). */
export function jdeFromJD(jd) { return jd + deltaT(jd) / 86400; }
export function century(jde) { return (jde - J2000) / 36525; }

/** Greenwich apparent sidereal time, degrees. */
export function gast(jd, T) {
  const t = T !== undefined ? T : (jd - J2000) / 36525;
  let th = 280.46061837 + 360.98564736629 * (jd - J2000)
    + 0.000387933 * t * t - t * t * t / 38710000;
  const { dpsi } = nutation(t);
  th += dpsi * cosd(obliquityTrue(t));
  return norm360(th);
}
/** Local apparent sidereal time, degrees east-positive longitude. */
export function lstDeg(jd, lonDeg) { return norm360(gast(jd) + lonDeg); }

/* ---------- obliquity & nutation ---------- */
export function nutation(T) {
  const om = 125.04452 - 1934.136261 * T + 0.0020708 * T * T + T * T * T / 450000;
  const L = 280.4665 + 36000.7698 * T;
  const Lp = 218.3165 + 481267.8813 * T;
  const dpsi = (-17.20 * sind(om) - 1.32 * sind(2 * L) - 0.23 * sind(2 * Lp) + 0.21 * sind(2 * om)) / 3600;
  const deps = (9.20 * cosd(om) + 0.57 * cosd(2 * L) + 0.10 * cosd(2 * Lp) - 0.09 * cosd(2 * om)) / 3600;
  return { dpsi, deps, omega: om };
}
export function obliquityMean(T) {
  return 23.439291111 - (46.8150 * T + 0.00059 * T * T - 0.001813 * T * T * T) / 3600;
}
export function obliquityTrue(T) { return obliquityMean(T) + nutation(T).deps; }

/* ---------- coordinate conversions ---------- */
/** Ecliptic (lambda,beta in deg) -> equatorial (ra,dec in deg). */
export function eclToEq(lambda, beta, eps) {
  const sl = sind(lambda), cl = cosd(lambda), sb = sind(beta), cb = cosd(beta);
  const se = sind(eps), ce = cosd(eps);
  const ra = norm360(atan2(sl * ce - (sb / cb) * se, cl) * RAD);
  const dec = asin(sb * ce + cb * se * sl) * RAD;
  return { ra, dec };
}

/** Equatorial-of-date -> horizon. Returns altitude/azimuth in degrees,
 *  azimuth measured from North increasing eastward. */
export function eqToHorizon(ra, dec, lstD, latD) {
  const H = (lstD - ra) * DEG, sd = sind(dec), cd = cosd(dec);
  const sp = sind(latD), cp = cosd(latD);
  const alt = asin(sp * sd + cp * cd * cos(H)) * RAD;
  const az = norm360(atan2(-cd * sin(H), -sp * cd * cos(H) + cp * sd) * RAD);
  return { alt, az };
}

/** Refraction correction (Bennett) in degrees, added to true altitude. */
export function refraction(altDeg) {
  if (altDeg < -1.5) return 0;
  return (1 / tand(altDeg + 7.31 / (altDeg + 4.4))) / 60;
}

/** Precession rotation of a J2000 unit vector to the mean equinox of date. */
export function precessionMatrix(T) {
  const s = 1 / 3600;
  const z1 = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T ** 3) * s;   // zeta
  const z2 = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T ** 3) * s;   // z
  const th = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T ** 3) * s;   // theta
  const cz1 = cosd(z1), sz1 = sind(z1), cz2 = cosd(z2), sz2 = sind(z2), ct = cosd(th), st = sind(th);
  return [
    cz1 * ct * cz2 - sz1 * sz2, -sz1 * ct * cz2 - cz1 * sz2, -st * cz2,
    cz1 * ct * sz2 + sz1 * cz2, -sz1 * ct * sz2 + cz1 * cz2, -st * sz2,
    cz1 * st, -sz1 * st, ct
  ];
}
export function mat3mul(a, b) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++)
    o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}
export function mat3apply(m, v) {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
          m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
          m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

/** Matrix taking an equatorial-of-date unit vector to render space
 *  (x = East, y = Up, z = South). */
export function horizonMatrix(latD, lstD) {
  const th = lstD * DEG, cp = cosd(latD), sp = sind(latD), ct = cos(th), st = sin(th);
  // hour-angle frame: x = meridian on equator, y = West, z = NCP
  const A = [ct, st, 0, st, -ct, 0, 0, 0, 1];
  const B = [0, -1, 0, cp, 0, sp, sp, 0, -cp];
  return mat3mul(B, A);
}
/** Full J2000 -> render space matrix (precession + Earth rotation). */
export function skyMatrix(latD, lstD, T) {
  return mat3mul(horizonMatrix(latD, lstD), precessionMatrix(T));
}
export function raDecToVec(ra, dec) {
  const cd = cosd(dec);
  return [cd * cosd(ra), cd * sind(ra), sind(dec)];
}
export function vecToAltAz(v) {
  const alt = asin(Math.max(-1, Math.min(1, v[1]))) * RAD;
  const az = norm360(atan2(v[0], -v[2]) * RAD);
  return { alt, az };
}
/** Convenience: equatorial-of-date -> render-space unit vector. */
export function eqToVec(ra, dec, latD, lstD) {
  return mat3apply(horizonMatrix(latD, lstD), raDecToVec(ra, dec));
}

/* ---------- galactic coordinates (J2000) ---------- */
export const GAL_POLE_RA = 192.85948, GAL_POLE_DEC = 27.12825, GAL_LON_NCP = 122.93192;
/** Sagittarius A*, J2000 — the physical centre of the Galaxy and what this app
 *  reports as "the core". It sits at l = -0.056, b = -0.046, i.e. 0.07 deg from
 *  the formal origin of galactic coordinates, which is far inside the visual
 *  size of the bulge. */
export const GC_RA = 266.41684, GC_DEC = -29.00781;
/** Formal origin of galactic coordinates (l=0, b=0) in J2000: 266.405, -28.936 */

export function galToEq(l, b) {
  const sdp = sind(GAL_POLE_DEC), cdp = cosd(GAL_POLE_DEC);
  const sb = sind(b), cb = cosd(b), sl = sind(GAL_LON_NCP - l), cl = cosd(GAL_LON_NCP - l);
  const dec = asin(sdp * sb + cdp * cb * cl) * RAD;
  const ra = norm360(atan2(cb * sl, cdp * sb - sdp * cb * cl) * RAD + GAL_POLE_RA);
  return { ra, dec };
}
export function eqToGal(ra, dec) {
  const sdp = sind(GAL_POLE_DEC), cdp = cosd(GAL_POLE_DEC);
  const sd = sind(dec), cd = cosd(dec), sa = sind(ra - GAL_POLE_RA), ca = cosd(ra - GAL_POLE_RA);
  const b = asin(sdp * sd + cdp * cd * ca) * RAD;
  const l = norm360(GAL_LON_NCP - atan2(cd * sa, cdp * sd - sdp * cd * ca) * RAD);
  return { l, b };
}

/* ---------- Sun (Meeus ch. 25) ---------- */
export function sunPosition(jde) {
  const T = century(jde);
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
  const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * sind(M)
    + (0.019993 - 0.000101 * T) * sind(2 * M) + 0.000289 * sind(3 * M);
  const trueLon = L0 + C, v = M + C;
  const R = 1.000001018 * (1 - e * e) / (1 + e * cosd(v));
  const om = 125.04 - 1934.136 * T;
  const lambda = trueLon - 0.00569 - 0.00478 * sind(om);
  const eps = obliquityMean(T) + 0.00256 * cosd(om);
  const { ra, dec } = eclToEq(lambda, 0, eps);
  return { lambda: norm360(lambda), beta: 0, R, ra, dec, name: 'Sun', angularRadius: 0.2666 / R };
}

/* ---------- Moon (Meeus ch. 47) ---------- */
// D, M, M', F, sigma-l (1e-6 deg), sigma-r (1e-3 km)
const MOON_LR = [
  [0,0,1,0,6288774,-20905355],[2,0,-1,0,1274027,-3699111],[2,0,0,0,658314,-2955968],
  [0,0,2,0,213618,-569925],[0,1,0,0,-185116,48888],[0,0,0,2,-114332,-3149],
  [2,0,-2,0,58793,246158],[2,-1,-1,0,57066,-152138],[2,0,1,0,53322,-170733],
  [2,-1,0,0,45758,-204586],[0,1,-1,0,-40923,-129620],[1,0,0,0,-34720,108743],
  [0,1,1,0,-30383,104755],[2,0,0,-2,15327,10321],[0,0,1,2,-12528,0],
  [0,0,1,-2,10980,79661],[4,0,-1,0,10675,-34782],[0,0,3,0,10034,-23210],
  [4,0,-2,0,8548,-21636],[2,1,-1,0,-7888,24208],[2,1,0,0,-6766,30824],
  [1,0,-1,0,-5163,-8379],[1,1,0,0,4987,-16675],[2,-1,1,0,4036,-12831],
  [2,0,2,0,3994,-10445],[4,0,0,0,3861,-11650],[2,0,-3,0,3665,14403],
  [0,1,-2,0,-2689,-7003],[2,0,-1,2,-2602,0],[2,-1,-2,0,2390,10056],
  [1,0,1,0,-2348,6322],[2,-2,0,0,2236,-9884],[0,1,2,0,-2120,5751],
  [0,2,0,0,-2069,0],[2,-2,-1,0,2048,-4950],[2,0,1,-2,-1773,4130],
  [2,0,0,2,-1595,0],[4,-1,-1,0,1215,-3958],[0,0,2,2,-1110,0],
  [3,0,-1,0,-892,3258],[2,1,1,0,-810,2616],[4,-1,-2,0,759,-1897],
  [0,2,-1,0,-713,-2117],[2,2,-1,0,-700,2354],[2,1,-2,0,691,0],
  [2,-1,0,-2,596,0],[4,0,1,0,549,-1423],[0,0,4,0,537,-1117],
  [4,-1,0,0,520,-1571],[1,0,-2,0,-487,-1739],[2,1,0,-2,-399,0],
  [0,0,2,-2,-381,-4421],[1,1,1,0,351,0],[3,0,-2,0,-340,0],
  [4,0,-3,0,330,0],[2,-1,2,0,327,0],[0,2,1,0,-323,1165],
  [1,1,-1,0,299,0],[2,0,3,0,294,0],[2,0,-1,-2,0,8752]
];
// D, M, M', F, sigma-b (1e-6 deg)
const MOON_B = [
  [0,0,0,1,5128122],[0,0,1,1,280602],[0,0,1,-1,277693],[2,0,0,-1,173237],
  [2,0,-1,1,55413],[2,0,-1,-1,46271],[2,0,0,1,32573],[0,0,2,1,17198],
  [2,0,1,-1,9266],[0,0,2,-1,8822],[2,-1,0,-1,8216],[2,0,-2,-1,4324],
  [2,0,1,1,4200],[2,1,0,-1,-3359],[2,-1,-1,1,2463],[2,-1,0,1,2211],
  [2,-1,-1,-1,2065],[0,1,-1,-1,-1870],[4,0,-1,-1,1828],[0,1,0,1,-1794],
  [0,0,0,3,-1749],[0,1,-1,1,-1565],[1,0,0,1,-1491],[0,1,1,1,-1475],
  [0,1,1,-1,-1410],[0,1,0,-1,-1344],[1,0,0,-1,-1335],[0,0,3,1,1107],
  [4,0,0,-1,1021],[4,0,-1,1,833],[0,0,1,-3,777],[4,0,-2,1,671],
  [2,0,0,-3,607],[2,0,2,-1,596],[2,-1,1,-1,491],[2,0,-2,1,-451],
  [0,0,3,-1,439],[2,0,2,1,422],[2,0,-3,-1,421],[2,1,-1,1,-366],
  [2,1,0,1,-351],[4,0,0,1,331],[2,-1,1,1,315],[2,-2,0,-1,302],
  [0,0,1,3,-283],[2,1,1,-1,-229],[1,1,0,-1,223],[1,1,0,1,223],
  [0,1,-2,-1,-220],[2,1,-1,-1,-220],[1,0,1,1,-185],[2,-1,-2,-1,181],
  [0,1,2,1,-177],[4,0,-2,-1,176],[4,-1,-1,-1,166],[1,0,1,-1,-164],
  [4,0,1,-1,132],[1,0,-1,-1,-119],[4,-1,0,-1,115],[2,-2,0,1,107]
];

export function moonPosition(jde) {
  const T = century(jde);
  const Lp = 218.3164477 + 481267.88123421 * T - 0.0015786 * T * T + T ** 3 / 538841 - T ** 4 / 65194000;
  const D = 297.8501921 + 445267.1114034 * T - 0.0018819 * T * T + T ** 3 / 545868 - T ** 4 / 113065000;
  const M = 357.5291092 + 35999.0502909 * T - 0.0001536 * T * T + T ** 3 / 24490000;
  const Mp = 134.9633964 + 477198.8675055 * T + 0.0087414 * T * T + T ** 3 / 69699 - T ** 4 / 14712000;
  const F = 93.2720950 + 483202.0175233 * T - 0.0036539 * T * T - T ** 3 / 3526000 + T ** 4 / 863310000;
  const A1 = 119.75 + 131.849 * T, A2 = 53.09 + 479264.290 * T, A3 = 313.45 + 481266.484 * T;
  const E = 1 - 0.002516 * T - 0.0000074 * T * T;

  let sl = 0, sr = 0, sb = 0;
  for (const [d, m, mp, f, cl, cr] of MOON_LR) {
    const arg = d * D + m * M + mp * Mp + f * F;
    const e = m === 0 ? 1 : (abs(m) === 1 ? E : E * E);
    sl += cl * e * sind(arg); sr += cr * e * cosd(arg);
  }
  for (const [d, m, mp, f, cb] of MOON_B) {
    const arg = d * D + m * M + mp * Mp + f * F;
    const e = m === 0 ? 1 : (abs(m) === 1 ? E : E * E);
    sb += cb * e * sind(arg);
  }
  sl += 3958 * sind(A1) + 1962 * sind(Lp - F) + 318 * sind(A2);
  sb += -2235 * sind(Lp) + 382 * sind(A3) + 175 * sind(A1 - F) + 175 * sind(A1 + F)
      + 127 * sind(Lp - Mp) - 115 * sind(Lp + Mp);

  const lambda = norm360(Lp + sl / 1e6);
  const beta = sb / 1e6;
  const delta = 385000.56 + sr / 1000;              // km
  const parallax = asin(6378.14 / delta) * RAD;     // equatorial horizontal parallax
  const { dpsi } = nutation(T);
  const eps = obliquityTrue(T);
  const { ra, dec } = eclToEq(lambda + dpsi, beta, eps);
  return { lambda, beta, delta, parallax, ra, dec, name: 'Moon', angularRadius: 0.2725 * parallax };
}

/** Illuminated fraction, phase angle and position angle of the bright limb. */
export function moonIllumination(jde) {
  const s = sunPosition(jde), m = moonPosition(jde);
  const R = s.R * 149597870.7;
  const psi = Math.acos(sind(m.beta) * 0 + cosd(m.beta) * cosd(m.lambda - s.lambda));
  const i = atan2(R * sin(psi), m.delta - R * cos(psi));
  const k = (1 + cos(i)) / 2;
  // position angle of bright limb (Meeus 48.5)
  const chi = atan2(cosd(s.dec) * sind(s.ra - m.ra),
    sind(s.dec) * cosd(m.dec) - cosd(s.dec) * sind(m.dec) * cosd(s.ra - m.ra)) * RAD;
  // waxing if the moon's elongation east of the sun is 0..180
  const elong = norm360(m.lambda - s.lambda);
  const waxing = elong < 180;
  return { fraction: k, phaseAngle: i * RAD, brightLimbPA: norm360(chi), elongation: elong, waxing,
    age: elong / 360 * 29.530588853, name: phaseName(elong) };
}
export function phaseName(elong) {
  if (elong < 11.25 || elong >= 348.75) return 'New';
  if (elong < 78.75) return 'Waxing crescent';
  if (elong < 101.25) return 'First quarter';
  if (elong < 168.75) return 'Waxing gibbous';
  if (elong < 191.25) return 'Full';
  if (elong < 258.75) return 'Waning gibbous';
  if (elong < 281.25) return 'Last quarter';
  return 'Waning crescent';
}

/* ---------- planets (JPL approximate elements) ---------- */
const PLANETS = {
  Mercury: [0.38709927,0.20563593,7.00497902,252.25032350,77.45779628,48.33076593,
            0.00000037,0.00001906,-0.00594749,149472.67411175,0.16047689,-0.12534081, -0.42, 2440],
  Venus:   [0.72333566,0.00677672,3.39467605,181.97909950,131.60246718,76.67984255,
            0.00000390,-0.00004107,-0.00078890,58517.81538729,0.00268329,-0.27769418, -4.40, 6052],
  Earth:   [1.00000261,0.01671123,-0.00001531,100.46457166,102.93768193,0.0,
            0.00000562,-0.00004392,-0.01294668,35999.37244981,0.32327364,0.0, 0, 6378],
  Mars:    [1.52371034,0.09339410,1.84969142,-4.55343205,-23.94362959,49.55953891,
            0.00001847,0.00007882,-0.00813131,19140.30268499,0.44441088,-0.29257343, -1.52, 3396],
  Jupiter: [5.20288700,0.04838624,1.30439695,34.39644051,14.72847983,100.47390909,
            -0.00011607,-0.00013253,-0.00183714,3034.74612775,0.21252668,0.20469106, -9.40, 71492],
  Saturn:  [9.53667594,0.05386179,2.48599187,49.95424423,92.59887831,113.66242448,
            -0.00125060,-0.00050991,0.00193609,1222.49362201,-0.41897216,-0.28867794, -8.88, 60268],
  Uranus:  [19.18916464,0.04725744,0.77263783,313.23810451,170.95427630,74.01692503,
            -0.00196176,-0.00004397,-0.00242939,428.48202785,0.40805281,0.04240589, -7.19, 25559],
  Neptune: [30.06992276,0.00859048,1.77004347,-55.12002969,44.96476227,131.78422574,
            0.00026291,0.00005105,0.00035372,218.45945325,-0.32241464,-0.00508664, -6.87, 24764]
};
export const PLANET_NAMES = ['Mercury','Venus','Mars','Jupiter','Saturn','Uranus','Neptune'];

export function heliocentric(name, T) {
  const p = PLANETS[name];
  const a = p[0] + p[6] * T, e = p[1] + p[7] * T, I = p[2] + p[8] * T;
  const L = p[3] + p[9] * T, w = p[4] + p[10] * T, om = p[5] + p[11] * T;
  const wp = w - om;                       // argument of perihelion
  let M = norm360(L - w); if (M > 180) M -= 360;
  let E = M + (e * RAD) * sind(M);
  for (let i = 0; i < 12; i++) {
    const dM = M - (E - e * RAD * sind(E));
    E += dM / (1 - e * cosd(E));
  }
  const xp = a * (cosd(E) - e), yp = a * sqrt(1 - e * e) * sind(E);
  const cw = cosd(wp), sw = sind(wp), co = cosd(om), so = sind(om), ci = cosd(I), si = sind(I);
  return [
    (cw * co - sw * so * ci) * xp + (-sw * co - cw * so * ci) * yp,
    (cw * so + sw * co * ci) * xp + (-sw * so + cw * co * ci) * yp,
    (sw * si) * xp + (cw * si) * yp
  ];
}

export function planetPosition(name, jde) {
  const T = century(jde);
  let pv = heliocentric(name, T);
  const ev = heliocentric('Earth', T);
  // one light-time iteration
  let dx = pv[0]-ev[0], dy = pv[1]-ev[1], dz = pv[2]-ev[2];
  let dist = sqrt(dx*dx+dy*dy+dz*dz);
  pv = heliocentric(name, T - (dist * 0.0057755183 / 36525));
  dx = pv[0]-ev[0]; dy = pv[1]-ev[1]; dz = pv[2]-ev[2];
  dist = sqrt(dx*dx+dy*dy+dz*dz);
  const lambda = norm360(atan2(dy, dx) * RAD);
  const beta = asin(dz / dist) * RAD;
  // JPL elements are referred to the J2000 ecliptic and equinox, so convert
  // with the J2000 obliquity and then precess to the equinox of date, which is
  // the frame everything else in this module speaks.
  const j2 = eclToEq(lambda, beta, 23.43929111);
  const v = mat3apply(precessionMatrix(T), raDecToVec(j2.ra, j2.dec));
  const ra = norm360(atan2(v[1], v[0]) * RAD), dec = asin(v[2]) * RAD;
  const r = sqrt(pv[0]**2 + pv[1]**2 + pv[2]**2);
  const ph = Math.acos(Math.max(-1, Math.min(1, (r*r + dist*dist - (ev[0]**2+ev[1]**2+ev[2]**2)) / (2*r*dist)))) * RAD;
  const mag = PLANETS[name][12] + 5 * Math.log10(r * dist) + 0.013 * ph + 1e-6 * ph ** 3;
  const angularRadius = (PLANETS[name][13] / (dist * 149597870.7)) * RAD;
  return { name, ra, dec, lambda, beta, dist, mag, angularRadius, phase: ph };
}

/* ---------- rise / set / transit ---------- */
/** Generic event finder. bodyFn(jd) -> {ra,dec} equatorial of date.
 *  h0 = altitude of the event in degrees (e.g. -0.8333 for the solar limb).
 *  Scans [jd0, jd0+span] and returns crossings plus the transit. */
export function findEvents(bodyFn, jd0, span, latD, lonD, h0, stepMin = 4) {
  const step = stepMin / 1440;
  const altAt = jd => {
    const b = bodyFn(jd);
    let hh = h0;
    if (b.parallax) hh = 0.7275 * b.parallax - 0.5667;
    const { alt } = eqToHorizon(b.ra, b.dec, lstDeg(jd, lonD), latD);
    return alt - hh;
  };
  const rises = [], sets = [];
  let prev = altAt(jd0), prevJd = jd0;
  let maxAlt = -90, maxJd = jd0;
  for (let jd = jd0 + step; jd <= jd0 + span + 1e-9; jd += step) {
    const cur = altAt(jd);
    if (cur > maxAlt) { maxAlt = cur; maxJd = jd; }
    if (prev < 0 && cur >= 0) rises.push(bisect(altAt, prevJd, jd));
    else if (prev > 0 && cur <= 0) sets.push(bisect(altAt, prevJd, jd));
    prev = cur; prevJd = jd;
  }
  return { rises, sets, transit: maxJd, maxAlt: maxAlt + h0, alwaysUp: rises.length === 0 && sets.length === 0 && prev > 0, alwaysDown: rises.length === 0 && sets.length === 0 && prev < 0 };
}
function bisect(f, a, b) {
  let fa = f(a);
  for (let i = 0; i < 40; i++) {
    const m = (a + b) / 2, fm = f(m);
    if ((fa < 0) === (fm < 0)) { a = m; fa = fm; } else b = m;
  }
  return (a + b) / 2;
}

export const sunAt = jd => sunPosition(jdeFromJD(jd));
export const moonAt = jd => moonPosition(jdeFromJD(jd));
export const gcAt = jd => {
  const T = century(jdeFromJD(jd));
  const v = mat3apply(precessionMatrix(T), raDecToVec(GC_RA, GC_DEC));
  return { ra: norm360(atan2(v[1], v[0]) * RAD), dec: asin(v[2]) * RAD };
};

/** Twilight / night structure for a given local night, starting at jd0 (UT). */
export function nightEvents(jd0, latD, lonD) {
  const span = 1.0;
  const sunEv = h => findEvents(sunAt, jd0, span, latD, lonD, h, 4);
  const day = sunEv(-0.8333), civil = sunEv(-6), naut = sunEv(-12), astro = sunEv(-18);
  const moon = findEvents(moonAt, jd0, span, latD, lonD, 0, 4);
  const gc = findEvents(gcAt, jd0, span, latD, lonD, 0, 4);
  return { day, civil, naut, astro, moon, gc };
}

/* ---------- exposure helpers ---------- */
/** NPF rule: max shutter before trailing.
 *  t = (35*aperture + 30*pixelPitch) / focalLength, pixelPitch in microns. */
export function npfSeconds(focalMm, fNumber, sensorWidthMm, pixelsWide, decDeg = 0, k = 1) {
  const pitch = sensorWidthMm / pixelsWide * 1000;
  const base = k * (16.856 * fNumber + 0.0997 * focalMm + 13.713 * pitch) / (focalMm * Math.max(0.2, cosd(decDeg)));
  return base;
}
export function rule500(focalMm, cropFactor = 1) { return 500 / (focalMm * cropFactor); }

/** Field of view in degrees for a rectilinear lens. */
export function fovDeg(sensorMm, focalMm) { return 2 * Math.atan2(sensorMm / 2, focalMm) * RAD; }
