import * as A from '../js/astro.js';

let pass = 0, fail = 0;
const near = (name, got, want, tol, unit='') => {
  const d = Math.abs(got - want);
  if (d <= tol) { pass++; console.log(`  ok   ${name}: ${got.toFixed(6)}${unit} (Δ${d.toExponential(2)})`); }
  else { fail++; console.log(`  FAIL ${name}: got ${got.toFixed(6)}${unit} want ${want}${unit} Δ${d.toFixed(6)}`); }
};
const hdr = s => console.log('\n' + s);

/* --- Meeus 12.a: 1987 April 10, 0h UT --- */
hdr('Sidereal time (Meeus 12.a / 12.b)');
const jd87 = 2446895.5;
near('GAST 1987-04-10 0h UT', A.gast(jd87), 197.69223, 2e-4, ' deg'); // 13h10m46.1351s apparent
near('GAST 1987-04-10 19:21 UT', A.gast(2446895.5 + (19 + 21/60)/24), 128.73687, 2e-3, ' deg');

/* --- Meeus 25.b: sun, JDE 2448908.5 (1992 Oct 13.0 TD) --- */
hdr('Sun (Meeus 25.b, JDE 2448908.5)');
const s = A.sunPosition(2448908.5);
near('apparent longitude', s.lambda, 199.90895, 0.01, ' deg');
near('radius vector', s.R, 0.99766, 1e-4, ' AU');
near('apparent RA', s.ra, 198.38083, 0.02, ' deg');
near('apparent Dec', s.dec, -7.78507, 0.02, ' deg');

/* --- Meeus 47.a: moon, JDE 2448724.5 (1992 April 12.0 TD) --- */
hdr('Moon (Meeus 47.a, JDE 2448724.5)');
const m = A.moonPosition(2448724.5);
near('geometric longitude', m.lambda, 133.162655, 5e-5, ' deg'); // apparent = +nutation = 133.167265
near('geocentric latitude', m.beta, -3.229126, 0.002, ' deg');
near('distance', m.delta, 368409.7, 2, ' km');
near('horizontal parallax', m.parallax, 0.991990, 0.0005, ' deg');
near('apparent RA', m.ra, 134.688470, 0.01, ' deg');
near('apparent Dec', m.dec, 13.768368, 0.01, ' deg');

/* --- Meeus 48.a: illuminated fraction, same instant --- */
hdr('Moon illumination (Meeus 48.a)');
const il = A.moonIllumination(2448724.5);
near('phase angle', il.phaseAngle, 69.0756, 0.05, ' deg');
near('illuminated fraction', il.fraction, 0.6786, 0.002);

/* --- galactic transform round trip --- */
hdr('Galactic coordinates');
const g = A.eqToGal(A.GC_RA, A.GC_DEC);   // Sgr A*
near('Sgr A* galactic l', A.normPM180(g.l), -0.056, 0.005, ' deg');
near('Sgr A* galactic b', g.b, -0.046, 0.005, ' deg');
const back = A.galToEq(0, 0);              // formal l=0 b=0
near('l=0,b=0 -> RA', back.ra, 266.405, 1e-3, ' deg');
near('l=0,b=0 -> Dec', back.dec, -28.936, 1e-3, ' deg');
const rt = A.eqToGal(back.ra, back.dec);
near('round-trip l', A.normPM180(rt.l), 0, 1e-9, ' deg');
near('round-trip b', rt.b, 0, 1e-9, ' deg');
// Polaris-ish check: north galactic pole must map to l undefined but b=+90
near('NGP b', A.eqToGal(A.GAL_POLE_RA, A.GAL_POLE_DEC).b, 90, 1e-6, ' deg');
// Cygnus (Deneb, 310.358 +45.280) sits on the galactic plane, l~84 b~2
const den = A.eqToGal(310.3580, 45.2803);
near('Deneb galactic l', den.l, 84.28, 0.3, ' deg');
near('Deneb galactic b', den.b, 2.0, 0.3, ' deg');

/* --- horizon transform: the sun must be due south at local solar noon --- */
hdr('Horizon transform');
{
  // Greenwich, 2026-06-21. Find solar transit and check azimuth ~180, alt = 90-lat+decl
  const lat = 51.4778, lon = -0.0015;
  const jd0 = A.julianDay(new Date(Date.UTC(2026, 5, 21, 0, 0, 0)));
  const ev = A.findEvents(A.sunAt, jd0, 1, lat, lon, -0.8333, 2);
  const st = A.sunAt(ev.transit);
  const h = A.eqToHorizon(st.ra, st.dec, A.lstDeg(ev.transit, lon), lat);
  near('solstice noon azimuth at Greenwich', h.az, 180, 0.3, ' deg');
  near('solstice noon altitude', h.alt, 90 - lat + st.dec, 0.05, ' deg');
  const sunset = A.dateFromJD(ev.sets[0]);
  console.log('  info sunset (UTC):', sunset.toISOString(), '-> expect ~20:21 UTC');
  const sunrise = A.dateFromJD(ev.rises[0]);
  console.log('  info sunrise (UTC):', sunrise.toISOString(), '-> expect ~03:43 UTC');
}

/* --- vector path must agree with the trig path --- */
hdr('Matrix vs trigonometric horizon');
{
  const lat = -33.9, lon = 18.4, jd = A.julianDay(new Date(Date.UTC(2026, 7, 30, 22, 14, 0)));
  const lst = A.lstDeg(jd, lon);
  let worst = 0;
  for (let i = 0; i < 200; i++) {
    const ra = Math.random() * 360, dec = (Math.random() * 2 - 1) * 89;
    const t = A.eqToHorizon(ra, dec, lst, lat);
    const v = A.vecToAltAz(A.eqToVec(ra, dec, lat, lst));
    const dAz = Math.abs(A.normPM180(t.az - v.az)) * Math.cos(t.alt * A.DEG);
    worst = Math.max(worst, Math.abs(t.alt - v.alt), dAz);
  }
  near('max disagreement over 200 random points', worst, 0, 1e-9, ' deg');
}

/* --- precession sanity: 100 years of general precession ~ 1.396 deg --- */
hdr('Precession');
{
  const v0 = A.raDecToVec(0, 0);
  const v1 = A.mat3apply(A.precessionMatrix(1.0), v0);
  const ang = Math.acos(v0[0]*v1[0]+v0[1]*v1[1]+v0[2]*v1[2]) * A.RAD;
  near('J2000 equinox point moved in 100 yr', ang, 1.3970, 0.002, ' deg');
}

/* --- planets: rough positions on a known date --- */
hdr('Planets (JPL approximate elements)');
{
  const jde = A.jdeFromJD(A.julianDay(new Date(Date.UTC(2026, 0, 1, 0, 0, 0))));
  for (const p of A.PLANET_NAMES) {
    const q = A.planetPosition(p, jde);
    console.log(`  info ${p.padEnd(8)} RA ${(q.ra/15).toFixed(3)}h  Dec ${q.dec.toFixed(2)}  dist ${q.dist.toFixed(3)} AU  mag ${q.mag.toFixed(1)}`);
  }
  // Earth-Sun geometry: the Sun's geocentric longitude must equal Earth's
  // heliocentric longitude + 180.
  const ev = A.heliocentric('Earth', A.century(jde));
  const earthLon = Math.atan2(ev[1], ev[0]) * A.RAD;
  const sun = A.sunPosition(jde);
  // JPL elements sit in the J2000 frame; Meeus' solar longitude is of date, so
  // the two differ by general precession (1.397 deg/century) plus the
  // Earth/EMB offset. Cross-checking the whole Kepler path against Meeus:
  const prec = 1.39696 * A.century(jde) + 0.000139 * A.century(jde) ** 2;
  near('Sun lon (Meeus) vs EMB+180 precessed', A.normPM180(earthLon + 180 + prec - sun.lambda), 0, 0.01, ' deg');
  // and the same check done through the full planet pipeline, in equatorial
  const sunViaPlanets = (() => {
    const e = A.heliocentric('Earth', A.century(jde));
    const lam = Math.atan2(-e[1], -e[0]) * A.RAD, bet = Math.asin(-e[2] / Math.hypot(...e)) * A.RAD;
    const j2 = A.eclToEq(lam, bet, 23.43929111);
    const v = A.mat3apply(A.precessionMatrix(A.century(jde)), A.raDecToVec(j2.ra, j2.dec));
    return { ra: A.norm360(Math.atan2(v[1], v[0]) * A.RAD), dec: Math.asin(v[2]) * A.RAD };
  })();
  const sep = Math.acos(A.raDecToVec(sunViaPlanets.ra, sunViaPlanets.dec)
    .reduce((acc, c, i) => acc + c * A.raDecToVec(sun.ra, sun.dec)[i], 0)) * A.RAD;
  near('Sun position: Kepler pipeline vs Meeus', sep, 0, 0.02, ' deg');
}

/* --- moon phases in 2026 (reference: new moons) --- */
hdr('Moon phase timing 2026');
{
  // Solve for successive new moons through 2026 and check the mean synodic month.
  const news = [];
  let jd = A.julianDay(new Date('2026-01-01T00:00Z'));
  let prevEl = A.normPM180(A.moonIllumination(A.jdeFromJD(jd)).elongation);
  for (let i = 1; i < 5 * 366 * 24; i++) {
    const t = jd + i / 24;
    const el = A.normPM180(A.moonIllumination(A.jdeFromJD(t)).elongation);
    if (prevEl < 0 && el > 0) {
      let a = t - 1 / 24, b = t;
      for (let k = 0; k < 40; k++) {
        const mm = (a + b) / 2;
        (A.normPM180(A.moonIllumination(A.jdeFromJD(mm)).elongation) < 0) ? a = mm : b = mm;
      }
      news.push((a + b) / 2);
    }
    prevEl = el;
  }
  for (const n of news.slice(0, 4)) console.log('  info new moon:', A.dateFromJD(n).toISOString().slice(0, 16).replace('T', ' '), 'UTC');
  const n = news.length - 1;
  const mean = (news[n] - news[0]) / n;
  // endpoint phase makes the sample mean noisy at the 0.008 d level, so this is
  // a loose sanity band; the sharp check is the absolute instant below.
  near('mean synodic month over ' + n + ' lunations', mean, 29.530588, 0.01, ' d');
  const jan = news.find(v => Math.abs(v - A.julianDay(new Date('2026-01-18T19:52Z'))) < 1);
  near('new moon 2026-01-18 vs 19:52 UTC', (jan - A.julianDay(new Date('2026-01-18T19:52Z'))) * 1440, 0, 5, ' min');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
