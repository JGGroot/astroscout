/* osm.js — small, on-demand OpenStreetMap overlays via Overpass.
 *
 * This deliberately requests only the local area currently being inspected.
 * It does not crawl raster tiles or prefetch regions for offline use. */

// Both are current public global instances listed by the OSM project. The
// community main instance is intentionally the fallback because it is often
// overloaded; Private.coffee explicitly permits project use without a quota.
const ENDPOINTS = [
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter'
];
const ROAD_TYPES = 'motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|track';
const mem = new Map();

function centreOf(element) {
  if (Number.isFinite(element.lat) && Number.isFinite(element.lon)) return [element.lat, element.lon];
  if (element.center && Number.isFinite(element.center.lat) && Number.isFinite(element.center.lon)) {
    return [element.center.lat, element.center.lon];
  }
  const g = element.geometry;
  if (!g || !g.length) return null;
  let lat = 0, lon = 0, n = 0;
  for (const p of g) if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) {
    lat += p.lat; lon += p.lon; n++;
  }
  return n ? [lat / n, lon / n] : null;
}

function poiKind(tags) {
  if (tags.natural === 'peak') return 'peak';
  if (tags.tourism === 'viewpoint') return 'viewpoint';
  if (tags.tourism === 'alpine_hut' || tags.amenity === 'shelter') return 'shelter';
  if (tags.amenity === 'parking') return 'parking';
  if (tags.amenity === 'drinking_water') return 'water';
  if (tags.place) return 'place';
  if (tags.historic) return 'historic';
  return tags.tourism || tags.amenity || tags.natural || 'poi';
}

/** Turn an Overpass response into compact, renderer-friendly features. */
export function parseOSMFeatures(json) {
  const roads = [], pois = [], seen = new Set();
  for (const e of json?.elements || []) {
    const id = `${e.type}/${e.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const tags = e.tags || {};
    if (tags.highway && Array.isArray(e.geometry) && e.geometry.length > 1) {
      roads.push({
        id, kind: tags.highway, name: tags.name || tags.ref || '',
        geometry: e.geometry.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon))
          .map(p => [p.lat, p.lon])
      });
    }
    if (tags.name && (tags.tourism || tags.amenity || tags.natural || tags.historic || tags.place)) {
      const c = centreOf(e);
      if (c) pois.push({ id, name: tags.name, kind: poiKind(tags), lat: c[0], lon: c[1], ele: +(tags.ele || NaN) });
    }
  }
  return { roads, pois };
}

function query(lat, lon, radius) {
  return `[out:json][timeout:20];(
way(around:${radius},${lat},${lon})["highway"~"^(${ROAD_TYPES})$"];
nwr(around:${radius},${lat},${lon})["name"]["tourism"];
nwr(around:${radius},${lat},${lon})["name"]["amenity"~"^(parking|shelter|drinking_water|restaurant|cafe)$"];
nwr(around:${radius},${lat},${lon})["name"]["natural"~"^(peak|saddle|spring|cave_entrance)$"];
nwr(around:${radius},${lat},${lon})["name"]["historic"];
nwr(around:${radius},${lat},${lon})["name"]["place"~"^(city|town|village|hamlet|locality)$"];
);out tags center geom;`;
}

/** Fetch a bounded local overlay. Results are cached for this session and in
 * localStorage for 24 hours to be polite to the public Overpass instance. */
export async function fetchOSMFeatures(lat, lon, radius = 8000) {
  const key = `astroscout.osm.v1:${lat.toFixed(2)}:${lon.toFixed(2)}:${radius}`;
  if (mem.has(key)) return mem.get(key);
  try {
    const cached = JSON.parse(localStorage.getItem(key));
    if (cached && Date.now() - cached.at < 86400000 && cached.data) {
      mem.set(key, cached.data); return cached.data;
    }
  } catch (e) { /* cache is optional */ }

  let lastError;
  for (const endpoint of ENDPOINTS) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const url = `${endpoint}?data=${encodeURIComponent(query(lat, lon, radius))}`;
      const response = await fetch(url, {
        mode: 'cors', credentials: 'omit', signal: ctl.signal,
        referrerPolicy: 'strict-origin-when-cross-origin',
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) throw new Error(`Overpass HTTP ${response.status}`);
      const data = parseOSMFeatures(await response.json());
      mem.set(key, data);
      try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), data })); } catch (e) { /* quota */ }
      return data;
    } catch (e) {
      lastError = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('No Overpass endpoint responded');
}
