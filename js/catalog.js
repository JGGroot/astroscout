/* catalog.js — star data.
 *
 * Two tiers:
 *   1. A built-in list of the naked-eye anchor stars (J2000, from the Bright
 *      Star Catalogue), which ships with the app so it works offline on first
 *      run. Cross-checked against known angular separations in test/.
 *   2. An optional upgrade to a ~9000-star catalogue fetched once from a public
 *      CDN and cached in localStorage/IndexedDB. If it fails, tier 1 stands.
 *
 * Faint filler stars are generated procedurally with a density that follows
 * galactic latitude. They are cosmetic only, drawn below magnitude 5.5, and
 * are never used for any planning calculation.
 */

// [RA deg, Dec deg, mag, B-V, name]
export const BRIGHT_STARS = [
  [101.2871,-16.7161,-1.46,0.00,'Sirius'],      [95.9880,-52.6957,-0.72,0.15,'Canopus'],
  [219.9021,-60.8340,-0.27,0.71,'Rigil Kent.'], [213.9153,19.1824,-0.05,1.23,'Arcturus'],
  [279.2347,38.7837,0.03,0.00,'Vega'],          [79.1723,45.9980,0.08,0.80,'Capella'],
  [78.6345,-8.2017,0.12,-0.03,'Rigel'],         [114.8255,5.2250,0.34,0.42,'Procyon'],
  [24.4285,-57.2367,0.46,-0.16,'Achernar'],     [88.7929,7.4071,0.50,1.85,'Betelgeuse'],
  [210.9559,-60.3730,0.61,-0.23,'Hadar'],       [297.6958,8.8683,0.77,0.22,'Altair'],
  [186.6496,-63.0991,0.77,-0.24,'Acrux'],       [68.9802,16.5093,0.85,1.54,'Aldebaran'],
  [201.2983,-11.1613,0.98,-0.23,'Spica'],       [247.3519,-26.4320,1.09,1.83,'Antares'],
  [116.3290,28.0262,1.14,1.00,'Pollux'],        [344.4127,-29.6222,1.16,0.09,'Fomalhaut'],
  [310.3580,45.2803,1.25,0.09,'Deneb'],         [191.9303,-59.6888,1.25,-0.24,'Mimosa'],
  [152.0930,11.9672,1.35,-0.11,'Regulus'],      [104.6564,-28.9721,1.50,-0.21,'Adhara'],
  [113.6495,31.8883,1.58,0.03,'Castor'],        [187.7915,-57.1133,1.63,1.59,'Gacrux'],
  [263.4022,-37.1038,1.62,-0.22,'Shaula'],      [81.2828,6.3497,1.64,-0.22,'Bellatrix'],
  [81.5730,28.6075,1.65,-0.13,'Elnath'],        [138.2999,-69.7172,1.67,0.07,'Miaplacidus'],
  [84.0534,-1.2019,1.69,-0.18,'Alnilam'],       [332.0583,-46.9610,1.74,-0.07,'Alnair'],
  [85.1897,-1.9426,1.74,-0.20,'Alnitak'],       [193.5073,55.9598,1.77,-0.02,'Alioth'],
  [165.9319,61.7511,1.79,1.07,'Dubhe'],         [51.0807,49.8612,1.79,0.48,'Mirfak'],
  [107.0979,-26.3932,1.84,0.67,'Wezen'],        [276.0430,-34.3846,1.85,-0.03,'Kaus Australis'],
  [206.8852,49.3133,1.86,-0.19,'Alkaid'],       [264.3297,-42.9978,1.86,0.40,'Sargas'],
  [125.6285,-59.5095,1.86,1.19,'Avior'],        [89.8822,44.9474,1.90,0.08,'Menkalinan'],
  [252.1662,-69.0277,1.91,1.44,'Atria'],        [99.4280,16.3993,1.93,0.00,'Alhena'],
  [306.4119,-56.7351,1.94,-0.12,'Peacock'],     [37.9545,89.2641,1.98,0.60,'Polaris'],
  [95.6749,-17.9559,1.98,-0.24,'Mirzam'],       [141.8968,-8.6586,2.00,1.44,'Alphard'],
  [131.1759,-54.7086,1.96,0.04,'Alsephina'],    [154.9930,19.8415,2.08,1.13,'Algieba'],
  [31.7934,23.4624,2.00,1.15,'Hamal'],          [10.8975,-17.9866,2.04,1.02,'Diphda'],
  [283.8163,-26.2967,2.05,-0.22,'Nunki'],       [211.6707,-36.3700,2.06,1.01,'Menkent'],
  [2.0969,29.0904,2.06,-0.11,'Alpheratz'],      [17.4330,35.6206,2.06,1.58,'Mirach'],
  [86.9391,-9.6696,2.06,-0.17,'Saiph'],         [222.6764,74.1555,2.08,1.47,'Kochab'],
  [263.7336,12.5600,2.08,0.16,'Rasalhague'],    [47.0422,40.9556,2.12,-0.05,'Algol'],
  [30.9748,42.3297,2.10,1.37,'Almach'],         [177.2649,14.5721,2.14,0.09,'Denebola'],
  [14.1772,60.7167,2.15,-0.15,'Navi'],          [190.3793,-48.9599,2.17,-0.01,'Muhlifain'],
  [120.8961,-40.0031,2.25,-0.27,'Naos'],        [139.2725,-59.2751,2.21,0.18,'Aspidiske'],
  [233.6720,26.7147,2.22,-0.02,'Alphecca'],     [136.9990,-43.4326,2.21,1.66,'Suhail'],
  [305.5571,40.2567,2.23,0.68,'Sadr'],          [200.9814,54.9254,2.23,0.02,'Mizar'],
  [10.1268,56.5373,2.24,1.17,'Schedar'],        [269.1515,51.4889,2.23,1.52,'Eltanin'],
  [2.2945,59.1498,2.27,0.34,'Caph'],            [240.0834,-22.6217,2.29,-0.12,'Dschubba'],
  [252.5410,-34.2932,2.29,1.14,'Wei'],          [220.4823,-47.3881,2.30,-0.20,'Kakkab'],
  [218.8770,-42.1576,2.31,-0.19,'Eta Cen'],     [165.4603,56.3824,2.37,0.03,'Merak'],
  [221.2467,27.0742,2.37,0.97,'Izar'],          [326.0465,9.8750,2.39,1.53,'Enif'],
  [265.6220,-39.0299,2.41,-0.20,'Girtab'],      [6.5708,-42.3061,2.39,1.09,'Ankaa'],
  [178.4577,53.6948,2.44,0.04,'Phecda'],        [257.5946,-15.7249,2.43,0.06,'Sabik'],
  [345.9436,28.0828,2.42,1.67,'Scheat'],        [111.0238,-29.3031,2.45,-0.08,'Aludra'],
  [346.1902,15.2053,2.49,-0.04,'Markab'],       [319.6449,62.5856,2.45,0.22,'Alderamin'],
  [83.0016,-0.2991,2.23,-0.18,'Mintaka'],       [183.9515,-17.5419,2.59,-0.11,'Gienah'],
  [229.2517,-9.3829,2.61,-0.11,'Zubeneschamali'],[236.0670,6.4256,2.63,1.17,'Unukalhai'],
  [275.2485,-29.8281,2.70,1.38,'Kaus Media'],   [276.9930,-25.4217,2.81,1.03,'Kaus Borealis'],
  [292.6804,27.9597,3.05,1.09,'Albireo'],       [21.4538,60.2353,2.68,0.16,'Ruchbah'],
  [28.5988,63.6701,3.35,-0.15,'Segin'],         [84.9122,-34.0741,2.65,-0.12,'Phact'],
  [271.4520,-30.4241,2.98,1.00,'Alnasl'],       [262.6910,-37.2958,2.69,-0.22,'Lesath'],
  [285.6532,-29.8803,2.60,0.06,'Ascella'],      [284.4297,-26.9908,3.17,-0.11,'Phi Sgr'],
  [289.2760,-27.6704,3.32,1.18,'Tau Sgr'],      [183.7863,-58.7490,2.79,-0.19,'Imai'],
  [188.5967,-23.3967,2.65,1.32,'Gamma Crv'],    [187.4661,-16.5154,2.94,-0.11,'Algorab'],
  [206.8120,-11.1613,2.75,0.89,'Heze'],         [227.2083,-49.4260,2.75,-0.19,'Beta Lupi'],
  [152.6465,-12.3546,3.11,0.92,'Nu Hya'],       [199.7303,-23.1716,3.00,1.00,'Kraz'],
  [326.7602,-16.1274,3.27,0.08,'Sadalsuud'],    [311.5525,-25.2705,2.90,-0.09,'Deneb Algedi'],
  [340.6668,-46.8846,2.07,1.62,'Beta Gru'],     [318.2340,-38.4844,3.00,-0.07,'Gamma Gru'],
  [45.5698,4.0897,3.61,1.63,'Menkar'],          [64.9475,15.6276,3.53,0.18,'Ain'],
  [56.8710,24.1053,2.87,-0.09,'Alcyone'],       [279.2346,-8.2441,3.24,0.15,'Alshain'],
  [286.5625,4.8836,3.36,-0.06,'Zeta Aql'],      [296.2437,45.1308,2.87,-0.02,'Gienah Cygni'],
  [292.1804,27.9597,3.20,0.00,'Eta Cyg'],       [311.3222,33.9705,2.48,0.68,'Aljanah'],
  [303.5417,46.7440,3.79,1.02,'Rho Cyg'],       [284.7360,32.6896,3.24,1.02,'Delta Lyr'],
  [284.7359,32.5017,3.25,-0.05,'Sulafat'],      [281.1936,37.6051,3.52,0.00,'Sheliak']
];

/** Constellation stick figures, as pairs of indices into BRIGHT_STARS. */
export const FIGURES = (() => {
  const ix = {};
  BRIGHT_STARS.forEach((s, i) => { ix[s[4]] = i; });
  const seg = names => {
    const out = [];
    for (let i = 0; i + 1 < names.length; i += 2) {
      const a = ix[names[i]], b = ix[names[i + 1]];
      if (a !== undefined && b !== undefined) out.push(a, b);
    }
    return out;
  };
  const chain = names => {
    const out = [];
    for (let i = 0; i + 1 < names.length; i++) {
      const a = ix[names[i]], b = ix[names[i + 1]];
      if (a !== undefined && b !== undefined) out.push(a, b);
    }
    return out;
  };
  return [
    ...chain(['Betelgeuse','Alnitak','Alnilam','Mintaka','Bellatrix','Betelgeuse']),
    ...chain(['Mintaka','Rigel']), ...chain(['Alnitak','Saiph']),
    ...chain(['Alkaid','Mizar','Alioth','Phecda','Merak','Dubhe','Alioth']),
    ...chain(['Phecda','Merak']),
    ...chain(['Caph','Schedar','Navi','Ruchbah','Segin']),
    ...chain(['Deneb','Sadr','Aljanah']), ...chain(['Gienah Cygni','Sadr','Albireo']),
    ...chain(['Kaus Borealis','Kaus Media','Kaus Australis','Ascella','Nunki','Kaus Borealis']),
    ...chain(['Alnasl','Kaus Media']), ...chain(['Nunki','Tau Sgr','Ascella']),
    ...chain(['Dschubba','Antares','Wei','Sargas','Girtab','Shaula','Lesath']),
    ...chain(['Acrux','Gacrux']), ...chain(['Mimosa','Imai']),
    ...chain(['Regulus','Algieba','Denebola']),
    ...chain(['Castor','Pollux','Alhena']),
    ...chain(['Vega','Sheliak','Sulafat','Vega']),
    ...chain(['Altair','Alshain']), ...chain(['Altair','Zeta Aql']),
    ...chain(['Alpheratz','Mirach','Almach','Mirfak','Capella']),
    ...chain(['Alpheratz','Markab','Scheat','Alpheratz']), ...chain(['Markab','Enif']),
    ...chain(['Aldebaran','Elnath']), ...chain(['Sirius','Mirzam']),
    ...chain(['Sirius','Adhara','Wezen','Aludra']),
    ...chain(['Polaris','Kochab'])
  ];
})();

/** B-V colour index to linear RGB, roughly following blackbody appearance. */
export function bvToRGB(bv) {
  const t = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  // Planckian locus approximation
  let r, g, b;
  const x = Math.max(1000, Math.min(40000, t)) / 100;
  if (x <= 66) { r = 255; } else { r = 329.7 * Math.pow(x - 60, -0.1332); }
  if (x <= 66) { g = 99.47 * Math.log(x) - 161.12; } else { g = 288.12 * Math.pow(x - 60, -0.0755); }
  if (x >= 66) { b = 255; } else if (x <= 19) { b = 0; } else { b = 138.52 * Math.log(x - 10) - 305.04; }
  const c = v => Math.max(0, Math.min(1, v / 255));
  return [c(r), c(g), c(b)];
}

/** Deterministic filler stars: cosmetic background, density follows the plane. */
export function fillerStars(count, galToEq, rand = mulberry32(20260830)) {
  const out = [];
  let guard = 0;
  while (out.length < count && guard++ < count * 40) {
    const l = rand() * 360;
    // sample b with a heavy concentration toward the plane plus an isotropic floor
    const u = rand();
    let b;
    if (u < 0.62) b = gauss(rand) * 9;
    else b = Math.asin(rand() * 2 - 1) * 180 / Math.PI;
    if (Math.abs(b) > 90) continue;
    const { ra, dec } = galToEq(l, b);
    const mag = 5.2 + rand() * 1.6;
    out.push([ra, dec, mag, rand() * 1.4 - 0.2, null]);
  }
  return out;
}
function gauss(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand(); while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
export function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* ---------- optional full catalogue ---------- */
const CATALOG_URLS = [
  'https://cdn.jsdelivr.net/npm/d3-celestial@0.7.35/data/stars.6.json',
  'https://unpkg.com/d3-celestial@0.7.35/data/stars.6.json'
];
const LS_KEY = 'astroscout.catalog.v1';

/** Try to upgrade to a full BSC-derived catalogue. Resolves to an array in the
 *  same [ra,dec,mag,bv,name] shape, or null if unavailable. */
export async function loadFullCatalog({ timeoutMs = 12000 } = {}) {
  try {
    const cached = localStorage.getItem(LS_KEY);
    if (cached) return JSON.parse(cached);
  } catch (e) { /* ignore */ }
  for (const url of CATALOG_URLS) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      const res = await fetch(url, { signal: ctl.signal, mode: 'cors', credentials: 'omit' });
      clearTimeout(timer);
      if (!res.ok) continue;
      const gj = await res.json();
      if (!gj || !gj.features) continue;
      const out = [];
      for (const f of gj.features) {
        const c = f.geometry && f.geometry.coordinates;
        const p = f.properties || {};
        if (!c) continue;
        const ra = ((c[0] % 360) + 360) % 360, dec = c[1];
        const mag = typeof p.mag === 'number' ? p.mag : parseFloat(p.mag);
        if (!isFinite(mag) || mag > 6.5) continue;
        const bv = parseFloat(p.bv);
        out.push([ra, dec, mag, isFinite(bv) ? bv : 0.3, p.name || null]);
      }
      if (out.length > 1000) {
        try { localStorage.setItem(LS_KEY, JSON.stringify(out)); } catch (e) { /* too big */ }
        return out;
      }
    } catch (e) { /* try next */ }
  }
  return null;
}
