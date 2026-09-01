/* presets.js — known foregrounds worth standing in front of. */
export const PRESETS = [
  { g: 'UK', n: 'Old Man of Storr, Skye',      lat: 57.5070, lon: -6.1830 },
  { g: 'UK', n: 'Llyn Ogwen, Snowdonia',       lat: 53.1050, lon: -3.9990 },
  { g: 'UK', n: 'Wastwater, Lake District',    lat: 54.4470, lon: -3.2960 },
  { g: 'UK', n: 'Pen y Fan, Brecon Beacons',   lat: 51.8840, lon: -3.4370 },
  { g: 'UK', n: 'Mam Tor, Peak District',      lat: 53.3490, lon: -1.8100 },
  { g: 'UK', n: 'Haytor, Dartmoor',            lat: 50.5780, lon: -3.7530 },
  { g: 'UK', n: 'Kielder Forest',              lat: 55.2320, lon: -2.5940 },
  { g: 'UK', n: 'Orford Ness, Suffolk',        lat: 52.0850, lon:  1.5670 },
  { g: 'Alps', n: 'Matterhorn from Riffelsee', lat: 45.9840, lon:  7.7590 },
  { g: 'Alps', n: 'Tre Cime, Dolomites',       lat: 46.6180, lon: 12.3050 },
  { g: 'Alps', n: 'Lauterbrunnen',             lat: 46.5930, lon:  7.9090 },
  { g: 'Europe', n: 'Reine, Lofoten',          lat: 67.9330, lon: 13.0880 },
  { g: 'Europe', n: 'Kirkjufell, Iceland',     lat: 64.9270, lon: -23.3070 },
  { g: 'Europe', n: 'Mount Teide, Tenerife',   lat: 28.2723, lon: -16.6425 },
  { g: 'Europe', n: 'Cappadocia',              lat: 38.6430, lon: 34.8290 },
  { g: 'USA', n: 'Tunnel View, Yosemite',      lat: 37.7157, lon: -119.6773 },
  { g: 'USA', n: 'Reflection Lakes, Rainier',  lat: 46.7690, lon: -121.7318 },
  { g: 'USA', n: 'Schwabacher, Grand Teton',   lat: 43.7395, lon: -110.6807 },
  { g: 'USA', n: 'The Watchman, Zion',         lat: 37.1997, lon: -112.9878 },
  { g: 'USA', n: 'Zabriskie Point',            lat: 36.4200, lon: -116.8117 },
  { g: 'USA', n: 'Delicate Arch, Arches',      lat: 38.7436, lon: -109.4993 },
  { g: 'USA', n: 'Cathedral Rock, Sedona',     lat: 34.8200, lon: -111.7930 },
  { g: 'USA', n: 'Inspiration Point, Bryce',   lat: 37.6100, lon: -112.1660 },
  { g: 'USA', n: 'Mesa Arch, Canyonlands',     lat: 38.3887, lon: -109.8687 },
  { g: 'South', n: 'Uluru',                    lat: -25.3444, lon: 131.0369 },
  { g: 'South', n: 'Lake Tekapo, NZ',          lat: -43.8850, lon: 170.5220 },
  { g: 'South', n: 'Hooker Valley, Aoraki',    lat: -43.7060, lon: 170.0940 },
  { g: 'South', n: 'Deadvlei, Namibia',        lat: -24.7590, lon: 15.2920 },
  { g: 'South', n: 'Torres del Paine',         lat: -50.9420, lon: -72.9880 },
  { g: 'South', n: 'Valle de la Luna, Atacama',lat: -22.9110, lon: -68.2760 },
  { g: 'Asia', n: 'Mt Fuji from Kawaguchiko',  lat: 35.5170, lon: 138.7530 },
  { g: 'Asia', n: 'Kala Patthar, Everest',     lat: 27.9950, lon: 86.8280 },
  { g: 'Asia', n: 'Pangong Tso, Ladakh',       lat: 33.7500, lon: 78.6000 }
];

/** Rough Bortle-style presets for the light pollution dome. */
export const SKY_QUALITY = [
  { n: 'Bortle 1 — pristine',      lp: 0.000, mag: 7.6 },
  { n: 'Bortle 2 — truly dark',    lp: 0.008, mag: 7.3 },
  { n: 'Bortle 3 — rural',         lp: 0.022, mag: 6.9 },
  { n: 'Bortle 4 — rural/suburban',lp: 0.048, mag: 6.4 },
  { n: 'Bortle 5 — suburban',      lp: 0.095, mag: 5.9 },
  { n: 'Bortle 6 — bright suburb', lp: 0.170, mag: 5.4 },
  { n: 'Bortle 7 — suburban/urban',lp: 0.270, mag: 5.0 },
  { n: 'Bortle 8 — city',          lp: 0.420, mag: 4.4 }
];

export const LENSES = [8, 11, 14, 16, 20, 24, 28, 35, 50, 85, 135, 200];
