# Matte canvas texture

`../src/assets/canvas-weave-prototype.png` is a seamless, procedural 1024 × 1024
canvas-weave tile. The generator uses a fixed random seed and creates the
texture from noise fields; it does not read or embed a photograph or other
external image.

To regenerate the PNG on Windows, use Python 3.9 or later in a separate
environment. These packages are only for asset regeneration; the application
does not use Python and does not require them at runtime.

```powershell
python -m venv .venv-canvas
& .\.venv-canvas\Scripts\python.exe -m pip install -r scripts\requirements-matte-canvas.txt
& .\.venv-canvas\Scripts\python.exe scripts\generate_matte_canvas.py
```

The script writes the PNG directly to `src/assets/canvas-weave-prototype.png`.
Review the generated image before committing it. The ZIP supplied for this
replacement contained this generator and its matching PNG.

## Fine-art-paper texture

`../src/assets/fine-art-paper.png` is a separate 560 × 440 procedural paper
texture. It is generated independently from `generate_fine_art_paper.py` using
a fixed seed and Python's standard library only (no packages to install).
No photos, external textures, or reference image are read or embedded. The
generator creates soft cellulose-like grain, without a woven thread pattern.

From the repository root, run:

```powershell
python scripts\\generate_fine_art_paper.py
```

Or run `npm run texture:paper`. Regenerating the committed paper texture should
produce the same SHA-256; review any unexpected hash difference before release.

Both generated PNGs and their corresponding scripts must be included in the
source distribution. The original `fine-art-paper.png` (introduced in commit
`a25e7b7` without reproducible provenance) is replaced, not reused.
