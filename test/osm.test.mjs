import assert from 'node:assert/strict';
import { parseOSMFeatures } from '../js/osm.js';

const fixture = {
  elements: [
    { type: 'way', id: 10, tags: { highway: 'secondary', name: 'Mountain Road' }, geometry: [
      { lat: 40.0, lon: 9.3 }, { lat: 40.01, lon: 9.31 }
    ] },
    { type: 'node', id: 20, lat: 40.02, lon: 9.32, tags: { natural: 'peak', name: 'Test Peak', ele: '1810' } },
    { type: 'way', id: 30, center: { lat: 40.03, lon: 9.33 }, tags: { tourism: 'viewpoint', name: 'Belvedere' } },
    // Overpass union queries may return an object more than once.
    { type: 'node', id: 20, lat: 40.02, lon: 9.32, tags: { natural: 'peak', name: 'Test Peak' } },
    { type: 'node', id: 40, lat: 40.04, lon: 9.34, tags: { amenity: 'parking' } }
  ]
};

const parsed = parseOSMFeatures(fixture);
assert.equal(parsed.roads.length, 1);
assert.equal(parsed.roads[0].geometry.length, 2);
assert.equal(parsed.pois.length, 2);
assert.deepEqual(parsed.pois.map(p => p.kind), ['peak', 'viewpoint']);
assert.equal(parsed.pois[0].ele, 1810);
console.log('OSM overlay parser: 5 passed, 0 failed');
