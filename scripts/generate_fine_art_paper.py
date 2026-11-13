"""Create reproducible fine-art paper grain from mathematical noise alone.

No reference images, input textures, or third-party Python packages are used.
Writes src/assets/fine-art-paper.png (560 x 440, 8-bit RGB).
This is separate from the canvas-weave generator so the two materials differ.
"""
from hashlib import sha256
from pathlib import Path
import random
import struct
import zlib

WIDTH, HEIGHT = 560, 440
SEED = 2026111202
OUTPUT = Path(__file__).resolve().parents[1] / "src/assets/fine-art-paper.png"
rng = random.Random(SEED)


def smooth(t):
    return t * t * (3.0 - 2.0 * t)


def make_layer(cols, rows, strength):
    """Periodic smooth value-noise lattice; edge positions wrap seamlessly."""
    grid = [rng.uniform(-1.0, 1.0) for _ in range(cols * rows)]
    xs = []
    for x in range(WIDTH):
        u = x * cols / WIDTH
        i = int(u)
        xs.append((i, (i + 1) % cols, smooth(u - i)))
    ys = []
    for y in range(HEIGHT):
        v = y * rows / HEIGHT
        i = int(v)
        ys.append((i, (i + 1) % rows, smooth(v - i)))
    return cols, grid, xs, ys, strength


# Broad pulp clouds, smaller paper fibers, subtle tooth and micrograin.
layers = [
    make_layer(4, 4, 5.0),
    make_layer(15, 12, 6.5),
    make_layer(55, 43, 10.0),
    make_layer(157, 121, 6.5),
]

scanlines = bytearray()
for y in range(HEIGHT):
    scanlines.append(0)  # PNG filter type 0, one row
    active = [(cols, grid, xs, ys[y], strength)
              for cols, grid, xs, ys, strength in layers]
    for x in range(WIDTH):
        value = 165.0
        for cols, grid, xs, (j0, j1, ty), strength in active:
            i0, i1, tx = xs[x]
            a = grid[j0 * cols + i0] * (1.0 - tx) + grid[j0 * cols + i1] * tx
            b = grid[j1 * cols + i0] * (1.0 - tx) + grid[j1 * cols + i1] * tx
            value += (a * (1.0 - ty) + b * ty) * strength
        # Soft fine granulation and rare dark cellulose specks.
        value += (rng.random() - rng.random()) * 16.0
        if rng.random() > 0.995:
            value -= 8.0
        gray = max(0, min(255, int(value + 0.5)))
        scanlines.extend((gray, gray, gray))


def chunk(kind, data):
    return (struct.pack(">I", len(data)) + kind + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff))


png = (b"\x89PNG\r\n\x1a\n"
       + chunk(b"IHDR", struct.pack(">IIBBBBB", WIDTH, HEIGHT, 8, 2, 0, 0, 0))
       + chunk(b"IDAT", zlib.compress(bytes(scanlines), level=9))
       + chunk(b"IEND", b""))
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.write_bytes(png)
print(f"Saved: {OUTPUT} ({WIDTH}x{HEIGHT}, RGB)")
print(f"SHA-256: {sha256(png).hexdigest()}")
