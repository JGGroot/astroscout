"""Live data-source smoke test for Bruncu Spina, Sardinia.

This intentionally fetches the same Terrarium elevation and Esri imagery tiles
used by the browser app. It is a network integration check, not a unit test.
"""
from io import BytesIO
from urllib.request import Request, urlopen
import math
import time

from PIL import Image


LAT, LON = 40.01601, 9.30192
REFERENCE_ELEVATION_M = 1828


def tile_xy(z):
    n = 1 << z
    x = (LON + 180) / 360 * n
    s = math.sin(math.radians(LAT))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return x, y


def fetch(url):
    req = Request(url, headers={"User-Agent": "AstroScout terrain verification"})
    last_error = None
    for attempt in range(5):
        try:
            with urlopen(req, timeout=20) as response:
                return response.read(), response.headers.get_content_type()
        except OSError as error:
            last_error = error
            time.sleep(0.25 * (attempt + 1))
    raise last_error


def decode_height(pixel):
    r, g, b = pixel[:3]
    return r * 256 + g + b / 256 - 32768


print(f"Bruncu Spina: {LAT:.5f}, {LON:.5f} · reference {REFERENCE_ELEVATION_M} m")
summit_samples = []
for zoom in (14, 13, 12, 11, 10, 9, 8):
    fx, fy = tile_xy(zoom)
    tx, ty = math.floor(fx), math.floor(fy)
    url = f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{zoom}/{tx}/{ty}.png"
    raw, mime = fetch(url)
    image = Image.open(BytesIO(raw)).convert("RGB")
    px = min(image.width - 1, math.floor((fx - tx) * image.width))
    py = min(image.height - 1, math.floor((fy - ty) * image.height))
    height = decode_height(image.getpixel((px, py)))
    summit_samples.append(height)
    print(f"  DEM z{zoom:02} {image.width}×{image.height}: {height:7.1f} m · {len(raw):6} bytes")

fine_height = next(h for h in summit_samples if h > -12000)
assert abs(fine_height - REFERENCE_ELEVATION_M) < 80, (
    f"summit elevation {fine_height:.1f} m is too far from {REFERENCE_ELEVATION_M} m"
)

fx, fy = tile_xy(15)
tx, ty = math.floor(fx), math.floor(fy)
imagery_url = (
    "https://services.arcgisonline.com/ArcGIS/rest/services/"
    f"World_Imagery/MapServer/tile/15/{ty}/{tx}"
)
raw, mime = fetch(imagery_url)
image = Image.open(BytesIO(raw)).convert("RGB")
colors = image.resize((32, 32)).getcolors(32 * 32) or []
assert len(raw) > 1000 and len(colors) > 16, "satellite tile is missing or visually empty"
print(f"  SAT z15 {image.width}×{image.height}: {len(raw):7} bytes · {len(colors)} sampled colours")
print("PASS · summit elevation is plausible and satellite imagery contains visible detail")
