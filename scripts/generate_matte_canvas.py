"""Generate the procedural matte canvas texture used by Irotona.

No original or reference photo is read, embedded, or copied.
Dependencies: numpy, scipy, Pillow (see requirements-matte-canvas.txt).
Run from the repository root: python scripts/generate_matte_canvas.py
The PNG is written to src/assets/canvas-weave-prototype.png.
"""
from pathlib import Path
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

N = 1024
SEED = 20261112
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'src' / 'assets'
OUT.mkdir(parents=True, exist_ok=True)
rng = np.random.default_rng(SEED)

# All random fields and threads repeat continuously at the tile boundary.
def noise(sigma_y, sigma_x, strength=1):
    a = gaussian_filter(rng.standard_normal((N, N), dtype=np.float32),
                        (sigma_y, sigma_x), mode='wrap')
    a -= a.mean()
    a /= max(1e-6, a.std())
    return a * strength

def dist_to_center(f):
    return (f + .5) % 1 - .5

y, x = np.indices((N, N), dtype=np.float32)

# Imperceptible local wander: real threads are not flawlessly straight.
wx = (noise(8, 14, 0.42) + noise(28, 3, 0.18) + noise(50, 60, 0.20))
wy = (noise(11, 6, 0.36) + noise(4, 29, 0.18) + noise(70, 60, 0.18))
xx = x + wx
yy = y + wy

# Tight weave: narrow warp every ~6 px, slightly longer weft rhythm ~13 px.
warp_count, weft_count = 166, 78
pitch_x, pitch_y = N / warp_count, N / weft_count
cx = xx / pitch_x
cy = yy / pitch_y
fx = dist_to_center(cx)
fy = dist_to_center(cy)
column = np.floor(cx + .5).astype(np.int32)
row = np.floor(cy + .5).astype(np.int32)
checker = ((column + row) & 1).astype(np.float32)

# Tonal base: fiber/pulp micrograins + soft uneven fabric dye.
base = (236.5 + noise(75, 80, 5.5) + noise(23, 30, 3.5)
        + noise(4.0, 14.0, 4.0) + noise(12.0, 3.2, 3.4)
        + noise(.75, .8, 10.6))

# Soft pale raised fibers, no shiny specular rim or plastic bevels.
vertical_belly = np.exp(-.5 * (fx / .29) ** 2)
horizontal_belly = np.exp(-.5 * (fy / .31) ** 2)
base += 5.2 * vertical_belly + 3.0 * horizontal_belly

# Thin darker creases running along (and between) the vertical yarns.
# Offset crease slightly so the geometry isn't a rigid grid.
crease_x = np.exp(-.5 * ((fx + .25 + .017 * noise(1.3, 2.5)) / .085) ** 2)
crease_x2 = np.exp(-.5 * ((fx - .28) / .13) ** 2)

# Dashed stitch-shadow on vertical warps, interrupted at weft crossings.
# Long irregular strands, rather than regular thick embossed squares.
duty = (np.cos(2 * np.pi * (fy - .045)) + 1) / 2
on = np.clip((duty - .11) / .58, 0, 1)
on = on**.7
brightness_var = np.clip(1 + noise(2.2, 2.0, .26), .55, 1.42)
base -= (31 + 41 * on) * crease_x * brightness_var
base -= 11.5 * crease_x2 * (.5 + .5 * on)

# Fine weft threads: soft broken horizontal flecks between warp strands.
crease_y = np.exp(-.5 * ((fy + .28 + noise(2.8, 1.4, .011)) / .078) ** 2)
short_dash = np.clip(.38 + .48 * np.cos(2 * np.pi * (fx + .07)) + .25 * noise(1, 1.8), 0, 1)
base -= 34.0 * crease_y * short_dash

# Tiny dark fiber-shadow at the interlacing points, alternating naturally.
contact = np.exp(-.5 * ((fx + .12) / .13) ** 2) * np.exp(-.5 * ((fy - .18) / .16) ** 2)
base -= (9 + 7 * checker) * contact

# Irregular natural fiber flecks at multiple lengths, and soft cellulose grain.
base += noise(.65, 2.1, 3.3) + noise(2.4, .65, 2.6)

# Very occasional short fibers. Sparse, matte, barely visible.
# Wrapped endpoints ensure the last and first pixels of the tile match.
fleck_field = (noise(.6, 1.4, 1) + noise(1.4, .6, .8))
base -= np.clip(fleck_field - 1.45, 0, 2.5) * 2.5

# Compress highlights instead of glossy clipping. Neutral grey-white canvas.
gray = np.clip(base, 95, 255).astype(np.uint8)
image = Image.fromarray(gray, 'L').convert('RGB')
output = OUT / 'canvas-weave-prototype.png'
image.save(output, optimize=True)
print('Saved:', output)
print('Stats:', np.mean(gray),np.std(gray),np.percentile(gray,[1, 5, 25, 50, 75, 95, 99]))
