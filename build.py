#!/usr/bin/env python3
"""Bundle the ES modules, CSS and HTML into single-file builds.

Each module becomes a function body in a private registry, so module-local
names cannot collide. Emits:
  dist/astroscout.html  a complete document you can open straight off disk
  dist/artifact.html    the same page without the outer document tags
"""
import re, os, base64, json, pathlib

ROOT = pathlib.Path(__file__).parent
ORDER = ['astro', 'catalog', 'presets', 'planner', 'terrain', 'osm', 'render', 'ui']
ENTRY = 'app'

EXPORT_RE = re.compile(r'^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)', re.M)
IMPORT_RE = re.compile(r'^import\s+([\s\S]+?)\s+from\s+[\'"]\./(\w+)\.js[\'"];?', re.M)

def convert(name):
    src = (ROOT / 'js' / f'{name}.js').read_text(encoding='utf-8')
    exports = EXPORT_RE.findall(src)
    imports = []
    def sub_import(m):
        clause, mod = m.group(1).strip(), m.group(2)
        if clause.startswith('*'):
            alias = clause.split('as')[1].strip()
            imports.append(f'const {alias} = __M[{mod!r}];')
        else:
            names = clause.strip('{} \t')
            imports.append('const { %s } = __M[%r];' % (names, mod))
        return ''
    body = IMPORT_RE.sub(sub_import, src)
    body = re.sub(r'^export\s+', '', body, flags=re.M)
    ret = 'return { %s };' % ', '.join(exports) if exports else 'return {};'
    return ('__M[%r] = (function(){\n%s\n%s\n%s\n})();\n'
            % (name, '\n'.join(imports), body, ret))

def bundle_js():
    out = ['(function(){', '"use strict";', 'const __M = {};']
    for m in ORDER:
        out.append(convert(m))
    out.append(convert(ENTRY).replace('__M[%r] = ' % ENTRY, ''))
    out.append('})();')
    return '\n'.join(out)

def data_uri(path, mime):
    return f'data:{mime};base64,' + base64.b64encode((ROOT / path).read_bytes()).decode()

def build():
    css = (ROOT / 'css' / 'app.css').read_text(encoding='utf-8')
    js = bundle_js()
    html = (ROOT / 'index.html').read_text(encoding='utf-8')
    body = re.search(r'<body>(.*)</body>', html, re.S).group(1)
    # drop the module script tag and the service-worker registration
    body = re.sub(r'<script.*?</script>', '', body, flags=re.S).strip()
    icon = data_uri('icons/icon-192.png', 'image/png')

    head_extra = f'''<title>AstroScout — explore Earth after dark</title>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,maximum-scale=1,user-scalable=no">
<meta name="theme-color" content="#07080c">
<link rel="icon" href="{icon}">
<style>
{css}
</style>'''

    inner = f'{head_extra}\n{body}\n<script>\n{js}\n</script>\n'

    (ROOT / 'dist').mkdir(exist_ok=True)
    (ROOT / 'dist' / 'artifact.html').write_text(
        inner.replace('<script>\n', '<script>\nwindow.__ASTROSCOUT_PREVIEW = true;\n', 1), encoding='utf-8')
    full = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
            + head_extra + '\n</head>\n<body>\n' + body + '\n<script>\n' + js + '\n</script>\n</body>\n</html>\n')
    (ROOT / 'dist' / 'astroscout.html').write_text(full, encoding='utf-8')
    print('dist/astroscout.html %.0f KB' % (len(full) / 1024))
    print('dist/artifact.html   %.0f KB' % (len(inner) / 1024))

build()

def build_deploy():
    """A flat, five-file bundle: everything a static host needs, no
    subdirectories, so it can be multi-selected and uploaded from a phone."""
    import shutil
    d = ROOT / 'deploy'
    d.mkdir(exist_ok=True)
    css = (ROOT / 'css' / 'app.css').read_text(encoding='utf-8')
    js = bundle_js()
    html = (ROOT / 'index.html').read_text(encoding='utf-8')
    body = re.search(r'<body>(.*)</body>', html, re.S).group(1)
    body = re.sub(r'<script.*?</script>', '', body, flags=re.S).strip()

    page = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>AstroScout — explore Earth after dark</title>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,maximum-scale=1,user-scalable=no">
<meta name="description" content="Real 1:1 terrain under an astronomically accurate sky. Plan Milky Way compositions over mountains.">
<meta name="theme-color" content="#07080c">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="AstroScout">
<link rel="manifest" href="manifest.webmanifest?v=5">
<link rel="apple-touch-icon" href="icon-192.png">
<link rel="icon" href="icon-192.png">
<style>
{css}
</style>
</head>
<body>
{body}
<script>
{js}
</script>
<script>
if ('serviceWorker' in navigator) {{
  addEventListener('load', () => navigator.serviceWorker.register('sw.js?v=5').catch(() => {{}}));
}}
</script>
</body>
</html>
'''
    (d / 'index.html').write_text(page, encoding='utf-8')

    manifest = {
        "name": "AstroScout — Explore Earth after dark",
        "short_name": "AstroScout",
        "description": "Real 1:1 terrain under an astronomically accurate sky, for planning Milky Way landscape photography.",
        "start_url": "./index.html", "scope": "./", "display": "standalone",
        "orientation": "any", "background_color": "#06100e", "theme_color": "#06100e",
        "categories": ["photo", "utilities", "travel"],
        "icons": [
            {"src": "icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
            {"src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
            {"src": "icon-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"}
        ]
    }
    (d / 'manifest.webmanifest').write_text(json.dumps(manifest, indent=2), encoding='utf-8')

    sw = '''/* sw.js — offline shell plus an opportunistic tile cache. */
const VERSION = 'astroscout-flat-v5';
const SHELL = ['./', './index.html', './manifest.webmanifest?v=5',
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
'''
    (d / 'sw.js').write_text(sw, encoding='utf-8')
    for n in ['icon-192.png', 'icon-512.png', 'icon-maskable.png']:
        shutil.copy(ROOT / 'icons' / n, d / n)
    total = sum(f.stat().st_size for f in d.iterdir())
    print('deploy/: %d files, %.0f KB total' % (len(list(d.iterdir())), total / 1024))

build_deploy()
