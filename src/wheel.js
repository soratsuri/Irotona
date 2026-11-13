import { resizeMarkerCanvas } from "./marker-canvas.js";
import { OklabPlane } from "./oklab-plane.js";
import { FullPlane, maxPlaneChroma } from "./lightness-plane.js";
import {
  oklch2rgb,
  gamutClamp,
  rgb2oklch,
  MAX_CHROMA,
  rgbToHex,
  hexToRgb,
} from "./oklch.js";
import { hsv2rgb, rgb2hsv, hsl2rgb, rgb2hsl } from "./color-models.js";
import { lab2rgb, lab2rgbRaw, rgb2lab } from "./lab.js";

export const WHEEL_RADIUS = 140;

// -------- common helpers --------

const LAB_AB_RANGE = 256;
const LAB_AB_MIN = -128;
const LAB_AB_MAX = 128;

// Screen-angle → hue mapping. Chosen so that blue sits at the bottom of the
// wheel, matching the OKLCH formula (and loosely CSP's own color-circle
// orientation: yellow near the top, blue near the bottom).
const HUE_OFFSET_DEG = 150;

function screenAngleDegToHue360(angleDeg) {
  return (((HUE_OFFSET_DEG - angleDeg) % 360) + 360) % 360;
}
function hue360ToScreenAngleRad(h360) {
  return ((HUE_OFFSET_DEG - h360) * Math.PI) / 180;
}

const clamp01 = (value) => Math.max(0, Math.min(1, value));

function pointFromMarker(marker) {
  if (Array.isArray(marker)) return { x: marker[0], y: marker[1] };
  return { x: marker.x, y: marker.y };
}

function pointForPolar(hue360, radius) {
  const angle = hue360ToScreenAngleRad(hue360);
  return {
    x: WHEEL_RADIUS + radius * Math.cos(angle),
    y: WHEEL_RADIUS - radius * Math.sin(angle),
  };
}

function selectedPointArray(point) {
  return [point.x, point.y];
}

function setupCanvas(canvas) {
  canvas.width = WHEEL_RADIUS * 2;
  canvas.height = WHEEL_RADIUS * 2;
}

// Compute (dx, dy, dist, angleDeg) for pixel (x,y) once.
function polar(x, y) {
  const dx = x - WHEEL_RADIUS;
  const dy = y - WHEEL_RADIUS;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const angle = (Math.atan2(-dy, dx) * 180) / Math.PI;
  return [dx, dy, dist, angle];
}

// Write an RGBA pixel into an ImageData.data array.
function putPx(d, i, r, g, b) {
  d[i] = Math.max(0, Math.min(255, Math.round(r * 255)));
  d[i + 1] = Math.max(0, Math.min(255, Math.round(g * 255)));
  d[i + 2] = Math.max(0, Math.min(255, Math.round(b * 255)));
  d[i + 3] = 255;
}

function putBg(d, i) {
  d[i] = 0;
  d[i + 1] = 0;
  d[i + 2] = 0;
  d[i + 3] = 0;
}

// Draw center dot + marker for a wheel. `marker` is either
// { distPx, screenAngleRad } (derived from the current color) or
// { x, y } (explicit pixel coords, used during drag so the marker tracks the
// cursor exactly — matters for OKLCH where gamut-clamp shrinks chroma and the
// derived position drifts inward from the rim).
function drawOverlay(ctx, currentHex, marker) {
  const cx = WHEEL_RADIUS;
  const cy = WHEEL_RADIUS;

  ctx.beginPath();
  ctx.arc(cx, cy, 6, 0, Math.PI * 2);
  ctx.fillStyle = currentHex;
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1;
  ctx.stroke();

  if (!marker) return;
  let mx, my;
  if (marker.x != null) {
    mx = marker.x;
    my = marker.y;
  } else {
    mx = cx + marker.distPx * Math.cos(marker.screenAngleRad);
    my = cy - marker.distPx * Math.sin(marker.screenAngleRad);
  }
  ctx.beginPath();
  ctx.arc(mx, my, 4, 0, Math.PI * 2);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2;
  ctx.stroke();
}

function labAtPoint(x, y) {
  const size = WHEEL_RADIUS * 2;
  const a = (x / (size - 1)) * LAB_AB_RANGE + LAB_AB_MIN;
  const b = LAB_AB_MAX - (y / (size - 1)) * LAB_AB_RANGE;
  return [a, b];
}

function pointForLab(a, b) {
  const size = WHEEL_RADIUS * 2;
  const clamp = (v) => Math.max(0, Math.min(size - 1, v));
  return {
    x: clamp(((a - LAB_AB_MIN) / LAB_AB_RANGE) * (size - 1)),
    y: clamp(((LAB_AB_MAX - b) / LAB_AB_RANGE) * (size - 1)),
  };
}

// -------- OKLCH wheel --------

function renderOklchImage(L, gamutWarning) {
  const size = WHEEL_RADIUS * 2;
  const img = new ImageData(size, size);
  const d = img.data;
  const limits = new Map();

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const [, , dist, angle] = polar(x, y);
      if (dist > WHEEL_RADIUS + 2) {
        putBg(d, i);
        continue;
      }
      const hue = ((150 - angle) % 360 + 360) % 360;
      const chroma = Math.min(dist / WHEEL_RADIUS, 1) * MAX_CHROMA;
      const [r0, g0, b0] = oklch2rgb(L, chroma, hue);
      const fits =
        r0 >= -0.002 && r0 <= 1.002 &&
        g0 >= -0.002 && g0 <= 1.002 &&
        b0 >= -0.002 && b0 <= 1.002;
      if (!fits && gamutWarning) {
        d[i] = 80; d[i + 1] = 80; d[i + 2] = 82; d[i + 3] = 255;
        continue;
      }
      let r, g, b;
      if (fits) { r = r0; g = g0; b = b0; }
      else {
        const bin = Math.round(hue * 2);
        if (!limits.has(bin)) limits.set(bin, maxPlaneChroma(L, bin / 2));
        [r, g, b] = oklch2rgb(L, Math.min(chroma, limits.get(bin)), hue);
      }
      putPx(d, i, r, g, b);
    }
  }
  return img;
}

class OklchWheel {
  constructor(canvas, overlay) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    setupCanvas(canvas);
    if (overlay) setupCanvas(overlay);
    this.overlay = overlay?.getContext("2d");
    this.cachedImage = null;
    this.currentL = 0.65;
    this.gamutWarning = false;
    this.currentHex = "#808080";
    this.selectedPoint = this._pointForHex(this.currentHex);
  }
  render(L) {
    if (this.cachedImage && this.currentL === L && this.renderedWarning === this.gamutWarning) return;
    this.currentL = L;
    this.renderedWarning = this.gamutWarning;
    this.cachedImage = renderOklchImage(L, this.gamutWarning);
    if (this.overlay) this.ctx.putImageData(this.cachedImage, 0, 0);
    this._draw();
  }
  setGamutWarning(on, rerender = true) {
    this.gamutWarning = on;
    if (rerender) this.render(this.currentL);
  }
  setCurrentColor(hex, markerAt) {
    this.currentHex = hex;
    this.selectedPoint = markerAt
      ? pointFromMarker(markerAt)
      : this._pointForHex(hex);
    this._draw();
  }
  _pointForHex(hex) {
    const [r, g, b] = hexToRgb(hex);
    const [, chroma, hue] = rgb2oklch(r, g, b);
    return pointForPolar(
      hue,
      Math.min(chroma / MAX_CHROMA, 1) * WHEEL_RADIUS,
    );
  }
  getSelectedPoint() { return selectedPointArray(this.selectedPoint); }
  colorAtAxis(L) {
    const [, , dist, angle] = polar(this.selectedPoint.x, this.selectedPoint.y);
    const hue = screenAngleDegToHue360(angle);
    const chroma = Math.min(dist / WHEEL_RADIUS, 1) * MAX_CHROMA;
    return rgbToHex(...gamutClamp(clamp01(L), chroma, hue));
  }
  _draw() {
    if (this.overlay) this.overlay.clearRect(0, 0, this.canvas.width, this.canvas.height);
    else if (this.cachedImage) this.ctx.putImageData(this.cachedImage, 0, 0);
    drawOverlay(this.overlay || this.ctx, this.currentHex, this.selectedPoint);
  }
  pickAt(x, y) {
    const [, , dist, angle] = polar(x, y);
    if (dist > WHEEL_RADIUS - 1) return null;
    this.selectedPoint = { x, y };
    const hue = ((150 - angle) % 360 + 360) % 360;
    const chroma = Math.min(dist / WHEEL_RADIUS, 1) * MAX_CHROMA;
    const [r, g, b] = gamutClamp(this.currentL, chroma, hue);
    return rgbToHex(r, g, b);
  }
  rgbToAxis(r, g, b) { return rgb2oklch(r, g, b)[0]; }
}

// -------- HSV wheel (angle=hue, radial=saturation, L=value) --------

function renderHsvImage(V) {
  const size = WHEEL_RADIUS * 2;
  const img = new ImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const [, , dist, angle] = polar(x, y);
      if (dist > WHEEL_RADIUS + 2) { putBg(d, i); continue; }
      const hue = screenAngleDegToHue360(angle) / 360;
      const sat = Math.min(dist / WHEEL_RADIUS, 1);
      const [r, g, b] = hsv2rgb(hue, sat, V);
      putPx(d, i, r, g, b);
    }
  }
  return img;
}

class HsvWheel {
  constructor(canvas, overlay) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    setupCanvas(canvas);
    if (overlay) setupCanvas(overlay);
    this.overlay = overlay?.getContext("2d");
    this.cachedImage = null;
    this.currentL = 1.0; // "L" = V for HSV
    this.currentHex = "#ffffff";
    this.selectedPoint = this._pointForHex(this.currentHex);
  }
  render(L) {
    this.currentL = L;
    this.cachedImage = renderHsvImage(L);
    if (this.overlay) this.ctx.putImageData(this.cachedImage, 0, 0);
    this._draw();
  }
  setGamutWarning(_on) {}
  setCurrentColor(hex, markerAt) {
    this.currentHex = hex;
    this.selectedPoint = markerAt
      ? pointFromMarker(markerAt)
      : this._pointForHex(hex);
    this._draw();
  }
  _pointForHex(hex) {
    const [r, g, b] = hexToRgb(hex);
    const [hue, saturation] = rgb2hsv(r, g, b);
    return pointForPolar(hue * 360, Math.min(saturation, 1) * WHEEL_RADIUS);
  }
  getSelectedPoint() { return selectedPointArray(this.selectedPoint); }
  colorAtAxis(V) {
    const [, , dist, angle] = polar(this.selectedPoint.x, this.selectedPoint.y);
    const hue = screenAngleDegToHue360(angle) / 360;
    const saturation = Math.min(dist / WHEEL_RADIUS, 1);
    return rgbToHex(...hsv2rgb(hue, saturation, clamp01(V)));
  }
  _draw() {
    if (this.overlay) this.overlay.clearRect(0, 0, this.canvas.width, this.canvas.height);
    else if (this.cachedImage) this.ctx.putImageData(this.cachedImage, 0, 0);
    drawOverlay(this.overlay || this.ctx, this.currentHex, this.selectedPoint);
  }
  pickAt(x, y) {
    const [, , dist, angle] = polar(x, y);
    if (dist > WHEEL_RADIUS - 1) return null;
    this.selectedPoint = { x, y };
    const hue = screenAngleDegToHue360(angle) / 360;
    const sat = Math.min(1, dist / WHEEL_RADIUS);
    const [r, g, b] = hsv2rgb(hue, sat, this.currentL);
    return rgbToHex(r, g, b);
  }
  rgbToAxis(r, g, b) { return rgb2hsv(r, g, b)[2]; }
}

// -------- HSL wheel (angle=hue, radial=saturation, L=lightness) --------

function renderHslImage(L) {
  const size = WHEEL_RADIUS * 2;
  const img = new ImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const [, , dist, angle] = polar(x, y);
      if (dist > WHEEL_RADIUS + 2) { putBg(d, i); continue; }
      const hue = screenAngleDegToHue360(angle) / 360;
      const sat = Math.min(dist / WHEEL_RADIUS, 1);
      const [r, g, b] = hsl2rgb(hue, sat, L);
      putPx(d, i, r, g, b);
    }
  }
  return img;
}

class HslWheel {
  constructor(canvas, overlay) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    setupCanvas(canvas);
    if (overlay) setupCanvas(overlay);
    this.overlay = overlay?.getContext("2d");
    this.cachedImage = null;
    this.currentL = 0.5;
    this.currentHex = "#808080";
    this.selectedPoint = this._pointForHex(this.currentHex);
  }
  render(L) {
    if (this.cachedImage && this.currentL === L) return;
    this.currentL = L;
    this.cachedImage = renderHslImage(L);
    if (this.overlay) this.ctx.putImageData(this.cachedImage, 0, 0);
    this._draw();
  }
  setGamutWarning(_on) {}
  setCurrentColor(hex, markerAt) {
    this.currentHex = hex;
    this.selectedPoint = markerAt
      ? pointFromMarker(markerAt)
      : this._pointForHex(hex);
    this._draw();
  }
  _pointForHex(hex) {
    const [r, g, b] = hexToRgb(hex);
    const [hue, saturation] = rgb2hsl(r, g, b);
    return pointForPolar(hue * 360, Math.min(saturation, 1) * WHEEL_RADIUS);
  }
  getSelectedPoint() { return selectedPointArray(this.selectedPoint); }
  colorAtAxis(L) {
    const [, , dist, angle] = polar(this.selectedPoint.x, this.selectedPoint.y);
    const hue = screenAngleDegToHue360(angle) / 360;
    const saturation = Math.min(dist / WHEEL_RADIUS, 1);
    return rgbToHex(...hsl2rgb(hue, saturation, clamp01(L)));
  }
  _draw() {
    if (this.overlay) this.overlay.clearRect(0, 0, this.canvas.width, this.canvas.height);
    else if (this.cachedImage) this.ctx.putImageData(this.cachedImage, 0, 0);
    drawOverlay(this.overlay || this.ctx, this.currentHex, this.selectedPoint);
  }
  pickAt(x, y) {
    const [, , dist, angle] = polar(x, y);
    if (dist > WHEEL_RADIUS - 1) return null;
    this.selectedPoint = { x, y };
    const hue = screenAngleDegToHue360(angle) / 360;
    const sat = Math.min(1, dist / WHEEL_RADIUS);
    const [r, g, b] = hsl2rgb(hue, sat, this.currentL);
    return rgbToHex(r, g, b);
  }
  rgbToAxis(r, g, b) { return rgb2hsl(r, g, b)[2]; }
}

// -------- Photoshop-style Lab wheel (x=a, y=b, slider/current color=L) --------

function renderLabImage(L, gamutWarning) {
  const size = WHEEL_RADIUS * 2;
  const img = new ImageData(size, size);
  const d = img.data;
  const labL = L * 100;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const [a, b] = labAtPoint(x, y);
      const raw = lab2rgbRaw(labL, a, b);
      const fits = raw.every((v) => v >= -0.002 && v <= 1.002);
      if (!fits && gamutWarning) {
        d[i] = 78; d[i + 1] = 78; d[i + 2] = 82; d[i + 3] = 255;
        continue;
      }
      const [r, g, bl] = fits ? raw : lab2rgb(labL, a, b);
      putPx(d, i, r, g, bl);
    }
  }
  return img;
}

class LabWheel {
  constructor(canvas, overlay) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    setupCanvas(canvas);
    if (overlay) setupCanvas(overlay);
    this.overlay = overlay?.getContext("2d");
    this.cachedImage = null;
    this.currentL = 0.5;
    this.gamutWarning = false;
    this.currentHex = "#808080";
    this.selectedPoint = this._pointForHex(this.currentHex);
  }
  render(L) {
    if (this.cachedImage && this.currentL === L && this.renderedWarning === this.gamutWarning) return;
    this.currentL = L;
    this.renderedWarning = this.gamutWarning;
    this.cachedImage = renderLabImage(L, this.gamutWarning);
    if (this.overlay) this.ctx.putImageData(this.cachedImage, 0, 0);
    this._draw();
  }
  setGamutWarning(on, rerender = true) {
    this.gamutWarning = on;
    if (rerender) this.render(this.currentL);
  }
  setCurrentColor(hex, markerAt) {
    this.currentHex = hex;
    this.selectedPoint = markerAt
      ? pointFromMarker(markerAt)
      : this._pointForHex(hex);
    this._draw();
  }
  _pointForHex(hex) {
    const [r, g, b] = hexToRgb(hex);
    const [, a, labB] = rgb2lab(r, g, b);
    return pointForLab(a, labB);
  }
  getSelectedPoint() { return selectedPointArray(this.selectedPoint); }
  colorAtAxis(L) {
    const [a, b] = labAtPoint(this.selectedPoint.x, this.selectedPoint.y);
    return rgbToHex(...lab2rgb(clamp01(L) * 100, a, b));
  }
  _draw() {
    if (this.overlay) this.overlay.clearRect(0, 0, this.canvas.width, this.canvas.height);
    else if (this.cachedImage) this.ctx.putImageData(this.cachedImage, 0, 0);
    drawOverlay(this.overlay || this.ctx, this.currentHex, this.selectedPoint);
  }
  pickAt(x, y) {
    const size = WHEEL_RADIUS * 2;
    if (x < 0 || y < 0 || x >= size || y >= size) return null;
    this.selectedPoint = { x, y };
    const [a, b] = labAtPoint(x, y);
    const [r, g, bl] = lab2rgb(this.currentL * 100, a, b);
    return rgbToHex(r, g, bl);
  }
  clampPoint(x, y) {
    const max = WHEEL_RADIUS * 2 - 1;
    return [
      Math.max(0, Math.min(max, x)),
      Math.max(0, Math.min(max, y)),
    ];
  }
  rgbToAxis(r, g, b) { return Math.max(0, Math.min(1, rgb2lab(r, g, b)[0] / 100)); }
}

// -------- factory --------

export function createWheel(canvas, type, overlay, planeView) {
  if (canvas.style) {
    canvas.style.clipPath = ["oklch", "hsv", "hsl"].includes(type)
      ? "circle(49.642857%)" : "";
  }
  if (type === "plane") {
    return planeView === "full" ? new FullPlane(canvas, overlay) : new OklabPlane(canvas, overlay);
  }

  const Wheel = { hsv: HsvWheel, hsl: HslWheel, lab: LabWheel }[type] || OklchWheel;
  const wheel = new Wheel(canvas, overlay);
  wheel.resizeMarker = (dpr) => {
    if (resizeMarkerCanvas(canvas, overlay, wheel.overlay, dpr)) wheel._draw();
  };
  return wheel;
}

export const WheelRenderer = OklchWheel;
