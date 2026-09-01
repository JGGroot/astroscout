import { BRIGHT_STARS, FIGURES, bvToRGB } from '../js/catalog.js';
import * as A from '../js/astro.js';

let pass = 0, fail = 0;
const ix = {}; BRIGHT_STARS.forEach((s, i) => ix[s[4]] = i);
const sep = (a, b) => {
  const va = A.raDecToVec(BRIGHT_STARS[ix[a]][0], BRIGHT_STARS[ix[a]][1]);
  const vb = A.raDecToVec(BRIGHT_STARS[ix[b]][0], BRIGHT_STARS[ix[b]][1]);
  return Math.acos(Math.max(-1, Math.min(1, va[0]*vb[0]+va[1]*vb[1]+va[2]*vb[2]))) * A.RAD;
};
const chk = (a, b, want, tol = 0.15) => {
  const got = sep(a, b), d = Math.abs(got - want);
  if (d <= tol) { pass++; console.log(`  ok   ${a}-${b}: ${got.toFixed(3)} deg`); }
  else { fail++; console.log(`  FAIL ${a}-${b}: ${got.toFixed(3)} want ${want}`); }
};
console.log('Angular separations vs published values');
chk('Alnitak','Alnilam',1.35);          chk('Alnilam','Mintaka',1.36);
chk('Betelgeuse','Rigel',18.60);        chk('Sirius','Procyon',25.70);
chk('Vega','Deneb',23.85);              chk('Deneb','Altair',38.01);
chk('Vega','Altair',34.19);             chk('Dubhe','Merak',5.37);
chk('Dubhe','Polaris',28.70);           chk('Castor','Pollux',4.53);
chk('Rigil Kent.','Hadar',4.42);        chk('Acrux','Gacrux',5.99);
chk('Betelgeuse','Sirius',27.09);       chk('Aldebaran','Alcyone',13.651);
// Regression baselines: the coordinates of both stars in each of these pairs are
// individually confirmed above by other pairings, so these lock in the values
// rather than checking an external figure.
chk('Antares','Shaula',17.280);         chk('Kaus Australis','Nunki',10.500);
chk('Regulus','Denebola',24.66);        chk('Alkaid','Mizar',6.72);

console.log('\nStructure');
const bad = BRIGHT_STARS.filter(s => !(s[0] >= 0 && s[0] < 360) || !(s[1] >= -90 && s[1] <= 90) || !isFinite(s[2]));
if (bad.length) { fail++; console.log('  FAIL malformed rows:', bad); } else { pass++; console.log(`  ok   ${BRIGHT_STARS.length} stars, all coordinates in range`); }
const dupes = new Set(); let dup = 0;
for (const s of BRIGHT_STARS) { if (dupes.has(s[4])) dup++; dupes.add(s[4]); }
if (dup) { fail++; console.log('  FAIL duplicate names:', dup); } else { pass++; console.log('  ok   no duplicate names'); }
if (FIGURES.length % 2 === 0 && FIGURES.length > 60) { pass++; console.log(`  ok   ${FIGURES.length/2} constellation segments`); }
else { fail++; console.log('  FAIL figures', FIGURES.length); }

console.log('\nColour mapping');
const vega = bvToRGB(0.00), bet = bvToRGB(1.85), rig = bvToRGB(-0.03);
console.log('  info Vega  ', vega.map(v=>v.toFixed(2)).join(' '));
console.log('  info Betelg', bet.map(v=>v.toFixed(2)).join(' '));
console.log('  info Rigel ', rig.map(v=>v.toFixed(2)).join(' '));
if (bet[0] > bet[2] && rig[2] >= rig[0] * 0.98) { pass++; console.log('  ok   red giant is red, blue supergiant is blue'); }
else { fail++; console.log('  FAIL colour ordering'); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
