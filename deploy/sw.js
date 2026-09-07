/* sw.js — offline shell plus an opportunistic tile cache. */
const VERSION = 'astroscout-flat-v7';
const SHELL = ['./', './index.html', './manifest.webmanifest?v=7',
  './icon-192.png', './icon-512.png', './icon-maskable.png'];
const TILE_HOSTS = ['s3.amazonaws.com', 'elevation-tiles-prod.s3.amazonaws.com',
  'services.arcgisonline.com', 'tile.openstreetmap.org',
  'api.mapbox.com', 'api.maptiler.com', 'cdn.jsdelivr.net', 'unpkg.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION)
    .then(c => Promise.allSettled(SHELL.map(url => c.add(url))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== VERSION && !k.endsWith('-tiles')).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin === location.origin) {
    e.respondWith(caches.match(e.request).then(hit => {
      const net = fetch(e.request).then(res => {
        if (res && res.ok) caches.open(VERSION).then(c => c.put(e.request, res.clone()));
        return res;
      }).catch(() => hit || new Response('Temporarily offline', { status: 503 }));
      return hit || net;
    }));
    return;
  }
  if (TILE_HOSTS.some(h => url.hostname.endsWith(h))) {
    e.respondWith(caches.open(VERSION + '-tiles').then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      try {
        const res = await fetch(e.request);
        if (res && (res.ok || res.type === 'opaque')) c.put(e.request, res.clone());
        return res;
      } catch (err) { return hit || Response.error(); }
    }));
  }
});
