import { clipPaletteCanvas, resizeMarkerCanvas } from "./marker-canvas.js";
import { gamutClamp, hexToRgb, lin2s, oklabToLinear, rgb2oklch, rgbToHex } from "./oklch.js";

export const WIDTH = 280;
export const HEIGHT = 220;
const INSET = 8;
const SKEW = 26;
const SPAN = WIDTH - SKEW - 2 * INSET;
const DEPTH = HEIGHT - 2 * INSET;
const EPSILON = 1e-8;
const clamp01 = (n) => Math.max(0, Math.min(n, 1));
const wrapHue = (h) => ((h % 360) + 360) % 360;

export function planePoint(hue, vertical) {
  return [INSET + SKEW * vertical + SPAN * hue / 360, INSET + DEPTH * (1 - vertical)];
}

export function planeCoordinates(x, y) {
  const vertical = 1 - (y - INSET) / DEPTH;
  const hue = 360 * (x - INSET - SKEW * vertical) / SPAN;
  return [hue, vertical];
}

// Find the first sRGB boundary at this lightness and hue in linear RGB.
export function maxPlaneChroma(L, hue) {
  const radians = hue * Math.PI / 180;
  return maxChromaInDirection(L, Math.cos(radians), Math.sin(radians));
}

function maxChromaInDirection(L, a, b) {
  if (L <= 0 || L >= 1) return 0;
  let low = 0, high = 0.5;
  for (let i = 0; i < 16; i++) {
    const mid = (low + high) / 2;
    const rgb = oklabToLinear(L, mid * a, mid * b);
    if (rgb.every((v) => v >= 0 && v <= 1)) low = mid;
    else high = mid;
  }
  return low;
}

const directions = Array.from({ length: SPAN + 1 }, (_, col) => {
  const angle = col * 2 * Math.PI / SPAN;
  return [Math.cos(angle), Math.sin(angle)];
});
let fullChromaLimits;

function fullLimits() {
  // Gamut boundaries in the full view depend only on the pixel's hue and
  // lightness. Reuse them while the chroma slider is moving.
  fullChromaLimits ??= Array.from({ length: DEPTH + 1 }, (_, row) =>
    Float32Array.from(directions, ([a, b]) => maxChromaInDirection(1 - row / DEPTH, a, b)),
  );
  return fullChromaLimits;
}

export class PlaneSurface {
  constructor(canvas, overlay) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    this.markerCanvas = overlay;
    if (overlay) {
      overlay.width = WIDTH;
      overlay.height = HEIGHT;
    }
    this.overlay = overlay?.getContext("2d");
  }

  resizeMarker(dpr = 1) {
    if (resizeMarkerCanvas(this.canvas, this.markerCanvas, this.overlay, dpr)) this.drawMarker();
  }

  setGamutWarning() {}
  getSelectedPoint() { return this.point; }

  drawMarker() {
    const ctx = this.overlay || this.ctx;
    if (this.overlay) ctx.clearRect(0, 0, WIDTH, HEIGHT);
    else if (this.image) ctx.putImageData(this.image, 0, 0);
    ctx.beginPath();
    ctx.arc(...this.point, 5, 0, Math.PI * 2);
    ctx.fillStyle = this.hex;
    ctx.fill();
    ctx.strokeStyle = "#161616";
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

export class FullPlane extends PlaneSurface {
  constructor(canvas, overlay) {
    super(canvas, overlay);
    this.axis = 0;
    this.setCurrentColor("#808080");
  }

  render(axis) {
    if (this.image && this.axis === axis) return;
    this.axis = axis;
    const limits = fullLimits();
    const image = this.ctx.createImageData(WIDTH, HEIGHT);
    // Paint past the outline with its edge colors. The browser's vector
    // clip resolves coverage at display DPI without blending in black pixels.
    for (let row = -2; row <= DEPTH + 2; row++) {
      const vertical = clamp01(1 - row / DEPTH);
      const shift = Math.round(INSET + SKEW * (1 - row / DEPTH));
      const rowLimits = limits[Math.max(0, Math.min(DEPTH, row))];
      for (let x = -2; x <= SPAN + 2; x++) {
        const col = Math.max(0, Math.min(SPAN, x));
        const i = ((row + INSET) * WIDTH + x + shift) * 4;
        const C = axis * rowLimits[col];
        const [a, b] = directions[col];
        const [r, g, blue] = oklabToLinear(vertical, C * a, C * b);
        image.data[i] = lin2s(r) * 255;
        image.data[i + 1] = lin2s(g) * 255;
        image.data[i + 2] = lin2s(blue) * 255;
        image.data[i + 3] = 255;
      }
    }
    this.image = image;
    this.ctx.putImageData(image, 0, 0);
    clipPaletteCanvas(this.canvas, [planePoint(0, 0), planePoint(360, 0), planePoint(360, 1), planePoint(0, 1)]);
    this.drawMarker();
  }

  rgbToAxis(r, g, b) {
    const [L, C, hue] = rgb2oklch(r, g, b);
    return relativeChroma(L, C, hue);
  }

  axisRange() { return [0, 1]; }

  setCurrentColor(hex, point) {
    this.hex = hex;
    if (point) {
      this.point = point;
    } else {
      const [L, C, hue] = rgb2oklch(...hexToRgb(hex));
      this.point = planePoint(C > 1e-6 ? hue : 0, clamp01(L));
    }
    this.drawMarker();
  }

  clampPoint(x, y) {
    // Keep the hue under the cursor while projecting back to the visible edge.
    const [hue, vertical] = planeCoordinates(x, y);
    const h = Math.max(0, Math.min(hue, 360));
    return planePoint(h, clamp01(vertical));
  }

  colorAtAxis(axis) {
    const [hue, vertical] = planeCoordinates(...this.point);
    const L = clamp01(vertical);
    return rgbToHex(...gamutClamp(L, axis * maxPlaneChroma(L, hue), hue));
  }

  pickAt(x, y) {
    const [hue, vertical] = planeCoordinates(x, y);
    if (hue < -EPSILON || hue > 360 + EPSILON || vertical < -EPSILON ||
        vertical > 1 + EPSILON) return null;
    this.point = [x, y];
    return this.colorAtAxis(this.axis);
  }

  adjustPoint(hueDelta, verticalDelta) {
    const [hue, vertical] = planeCoordinates(...this.point);
    const nextHue = hueDelta ? wrapHue(hue + hueDelta) : hue;
    return planePoint(nextHue, clamp01(vertical + verticalDelta));
  }
}

function relativeChroma(L, C, hue) {
  if (C <= 1e-6) return 0;
  const max = maxPlaneChroma(L, hue);
  return max > 0 ? clamp01(C / max) : 0;
}
