#!/usr/bin/env python3
"""Bundle the ES modules, CSS and HTML into single-file builds.

Each module becomes a function body in a private registry, so module-local
names cannot collide. Emits:
  dist/astroscout.html  a complete document you can open straight off disk
  dist/artifact.html    the same page without the outer document tags
"""
import re, os, base64, json, pathlib

ROOT = pathlib.Path(__file__).parent
ORDER = ['astro', 'catalog', 'presets', 'planner', 'terrain', 'render', 'ui']
ENTRY = 'app'

EXPORT_RE = re.compile(r'^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)', re.M)
IMPORT_RE = re.compile(r'^import\s+([\s\S]+?)\s+from\s+[\'"]\./(\w+)\.js[\'"];?', re.M)

def convert(name):
    src = (ROOT / 'js' / f'{name}.js').read_text()
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
    css = (ROOT / 'css' / 'app.css').read_text()
    js = bundle_js()
    html = (ROOT / 'index.html').read_text()
    body = re.search(r'<body>(.*)</body>', html, re.S).group(1)
    # drop the module script tag and the service-worker registration
    body = re.sub(r'<script.*?</script>', '', body, flags=re.S).strip()
    icon = data_uri('icons/icon-192.png', 'image/png')

    head_extra = f'''<title>AstroScout — Milky Way shot planner</title>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,maximum-scale=1,user-scalable=no">
<meta name="theme-color" content="#07080c">
<link rel="icon" href="{icon}">
<style>
{css}
</style>'''

    inner = f'{head_extra}\n{body}\n<script>\n{js}\n</script>\n'

    (ROOT / 'dist').mkdir(exist_ok=True)
    (ROOT / 'dist' / 'artifact.html').write_text(
        inner.replace('<script>\n', '<script>\nwindow.__ASTROSCOUT_PREVIEW = true;\n', 1))
    full = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
            + head_extra + '\n</head>\n<body>\n' + body + '\n<script>\n' + js + '\n</script>\n</body>\n</html>\n')
    (ROOT / 'dist' / 'astroscout.html').write_text(full)
    print('dist/astroscout.html %.0f KB' % (len(full) / 1024))
    print('dist/artifact.html   %.0f KB' % (len(inner) / 1024))

build()
