import * as P from '../js/planner.js';
import * as A from '../js/astro.js';
let pass=0, fail=0;
const chk=(n,c,info='')=>{ if(c){pass++;console.log('  ok  ',n,info);} else {fail++;console.log('  FAIL',n,info);} };

console.log('Night at Yosemite Valley (37.745,-119.593) UTC-7, 2026-08-15');
const jd = P.noonJD(2026,7,15,-420);
const s = P.sampleNight(jd, 37.745, -119.593, {step:4});
const sum = P.nightSummary(s);
const T = j => P.fmtTime(j,-420);
console.log('   sunset', T(sum.sunset), '| astro dusk', T(sum.duskAstro), '| astro dawn', T(sum.dawnAstro), '| sunrise', T(sum.sunrise));
console.log('   core transit', T(sum.coreTransit), 'at', sum.coreMaxAlt.toFixed(1)+'° az', sum.coreTransitAz.toFixed(0)+'°');
console.log('   moonrise', sum.moonrise.map(T).join(','), 'moonset', sum.moonset.map(T).join(','), 'illum', (sum.moonIllumMax*100).toFixed(0)+'%');
chk('sunset is in the evening', new Date((sum.sunset-2440587.5)*86400000-420*60000).getUTCHours()===19+0 || T(sum.sunset).startsWith('19') || T(sum.sunset).startsWith('20'), T(sum.sunset));
chk('astro dark exists in August at 37N', sum.hasAstroDark);
chk('core transits due south-ish', Math.abs(A.normPM180(sum.coreTransitAz-180))<3, sum.coreTransitAz.toFixed(2)+'°');
chk('core max altitude ≈ 90-lat+dec', Math.abs(sum.coreMaxAlt-(90-37.745-29.0))<1.2, sum.coreMaxAlt.toFixed(2));
const w = P.shootWindows(s,{});
console.log('   windows:', w.map(x=>`${T(x.from)}-${T(x.to)} (${P.fmtDur(x.minutes)}, peak ${x.peakAlt.toFixed(0)}°)`).join('; ')||'none');
chk('at least one shootable window', w.length>0);

console.log('\nMildenhall, Suffolk (52.36,0.48) BST — June has no astro dark');
const jdUK = P.noonJD(2026,5,21,60);
const sUK = P.sampleNight(jdUK, 52.36, 0.48, {step:5});
const sumUK = P.nightSummary(sUK);
console.log('   darkest sun altitude:', sumUK.darkestSunAlt.toFixed(2)+'°');
chk('no astronomical darkness at midsummer in Suffolk', !sumUK.hasAstroDark, sumUK.darkestSunAlt.toFixed(1)+'°');
const wUK = P.shootWindows(sUK,{});
chk('and therefore no astro-dark window', wUK.length===0);
const wUK2 = P.shootWindows(sUK,{sunMax:-12});
console.log('   with a nautical-dark relaxation:', wUK2.map(x=>`${P.fmtTime(x.from,60)}-${P.fmtTime(x.to,60)}`).join('; ')||'none');

console.log('\nSeptember in Suffolk should be usable');
const sSep = P.sampleNight(P.noonJD(2026,8,20,60), 52.36, 0.48, {step:5});
const sumSep = P.nightSummary(sSep);
chk('astro dark returns by late September', sumSep.hasAstroDark, sumSep.darkestSunAlt.toFixed(1)+'°');
console.log('   core transit', P.fmtTime(sumSep.coreTransit,60), 'alt', sumSep.coreMaxAlt.toFixed(1)+'°');

console.log('\nSouthern hemisphere: the core passes overhead at Uluru (-25.34,131.04)');
const sAU = P.sampleNight(P.noonJD(2026,6,10,570), -25.344, 131.036, {step:5});
const sumAU = P.nightSummary(sAU);
console.log('   core transit alt', sumAU.coreMaxAlt.toFixed(1)+'° az', sumAU.coreTransitAz.toFixed(0)+'°');
chk('core nearly overhead from -25 latitude', sumAU.coreMaxAlt>85, sumAU.coreMaxAlt.toFixed(1));

console.log('\nBest-nights ranking, next 45 nights at Yosemite');
const best = P.findBestNights(new Date(Date.UTC(2026,7,20)), 45, 37.745, -119.593, -420, {step:10, targetAz:190});
for (const b of best.slice(0,5))
  console.log('  ', b.date.toISOString().slice(0,10), P.fmtDur(b.totalMinutes).padStart(7),
    'peak', (b.peak?b.peak.peakAlt.toFixed(0):'-')+'°', 'moon', b.peak?(b.peak.meanMoonIllum*100).toFixed(0)+'%':'-', 'score', b.score.toFixed(0));
chk('ranking returns 45 nights', best.length===45);
chk('top night beats the median', best[0].score >= best[22].score);
chk('top nights have little moon', best[0].peak.meanMoonIllum < 0.5, (best[0].peak.meanMoonIllum*100).toFixed(0)+'%');

console.log('\nExposure');
const e = P.exposureAdvice({focal:20, fNumber:2.8, sensor:'Full frame', megapixels:45, decl:-29});
console.log('   20mm f/2.8 FF 45MP:', e.npf.toFixed(1)+'s NPF,', e.rule500.toFixed(1)+'s 500-rule, FoV', e.hfov.toFixed(0)+'x'+e.vfov.toFixed(0)+'°, pitch', e.pixelPitchUm.toFixed(2)+'µm');
chk('NPF is stricter than the 500 rule', e.npf < e.rule500);
chk('20mm horizontal FoV ≈ 84°', Math.abs(e.hfov-83.97)<0.5, e.hfov.toFixed(2));
chk('45MP FF pixel pitch ≈ 4.4µm', Math.abs(e.pixelPitchUm-4.4)<0.4, e.pixelPitchUm.toFixed(2));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
