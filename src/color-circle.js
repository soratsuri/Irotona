import { hsv2rgb, rgb2hsv, hsl2rgb, rgb2hsl } from "./color-models.js";
import { resizeMarkerCanvas } from "./marker-canvas.js";
import { hexToRgb, rgbToHex } from "./oklch.js";
import { WHEEL_RADIUS as center } from "./wheel.js";

const turn = 2 * Math.PI;
const outer = center - 2;
const inner = center - 23;
const square = 78;
const triangleLeft = center - 62;
const triangleWidth = 158;
const triangleHalfHeight = 92;
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const wrap = (hue) => (hue % 1 + 1) % 1;

export function hueAt(x, y, fallback = 0) {
  if (x === center && y === center) return fallback;
  return wrap((Math.atan2(y - center, x - center) + Math.PI / 2) / turn);
}

export function centerPoint(model, saturation, level) {
  if (model === "hsv") {
    return [center - square + 2 * square * saturation, center + square - 2 * square * level];
  }
  const chroma = (1 - Math.abs(2 * level - 1)) * saturation;
  return [triangleLeft + triangleWidth * chroma, center + triangleHalfHeight * (1 - 2 * level)];
}

export function centerComponents(model, x, y) {
  if (model === "hsv") {
    return [clamp((x - center + square) / (2 * square)), clamp((center + square - y) / (2 * square))];
  }
  const level = clamp((center + triangleHalfHeight - y) / (2 * triangleHalfHeight));
  const maxChroma = 1 - Math.abs(2 * level - 1);
  return [maxChroma ? clamp((x - triangleLeft) / triangleWidth / maxChroma) : 0, level];
}

export function circleRegion(model, x, y) {
  const radius = Math.hypot(x - center, y - center);
  if (radius >= inner && radius <= outer) return "hue";
  if (model === "hsv") {
    return Math.abs(x - center) <= square && Math.abs(y - center) <= square ? "center" : null;
  }
  const width = triangleWidth * (1 - Math.abs(y - center) / triangleHalfHeight);
  return x >= triangleLeft && x <= triangleLeft + width ? "center" : null;
}

export class ColorCircle {
  constructor(canvas, marker, model) {
    this.canvas = canvas;
    this.marker = marker;
    this.ctx = canvas.getContext("2d");
    this.overlay = marker.getContext("2d");
    this.model = model;
    this.hue = 0;
    this.saturation = 0;
    this.level = 0;
    canvas.width = canvas.height = center * 2;
    const ring = this.ctx.createConicGradient(-Math.PI / 2, center, center);
    for (let step = 0; step <= 6; step += 1) {
      ring.addColorStop(step / 6, rgbToHex(...hsv2rgb(step / 6, 1, 1)));
    }
    this.ring = ring;
  }

  setCurrentColor(hex) {
    const decode = this.model === "hsv" ? rgb2hsv : rgb2hsl;
    const [hue, saturation, level] = decode(...hexToRgb(hex));
    // RGB quantization erases hue near gray. Preserve the last deliberate hue
    // until there is enough chroma for a stable RGB-derived hue.
    if (saturation >= 0.02) this.hue = hue;
    this.saturation = saturation;
    this.level = level;
  }

  begin(x, y) {
    this.region = circleRegion(this.model, x, y);
    return this.region !== null;
  }

  pickAt(x, y) {
    if (this.region === "hue") this.hue = hueAt(x, y, this.hue);
    else [this.saturation, this.level] = centerComponents(this.model, x, y);
    return this.hex();
  }

  adjust(hue, saturation, level) {
    this.hue = wrap(this.hue + hue / 360);
    this.saturation = clamp(this.saturation + saturation);
    this.level = clamp(this.level + level);
    return this.hex();
  }

  hex() {
    const encode = this.model === "hsv" ? hsv2rgb : hsl2rgb;
    return rgbToHex(...encode(this.hue, this.saturation, this.level));
  }

  resizeMarker(dpr = globalThis.devicePixelRatio) {
    if (resizeMarkerCanvas(this.canvas, this.marker, this.overlay, dpr)) this.drawMarkers();
  }

  drawMarkers() {
    const ctx = this.overlay;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const angle = this.hue * turn - Math.PI / 2;
    const radius = (inner + outer) / 2;
    for (const [x, y] of [
      [center + radius * Math.cos(angle), center + radius * Math.sin(angle)],
      centerPoint(this.model, this.saturation, this.level),
    ]) {
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, turn);
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#202024";
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
    }
  }

  render() {
    const key = `${this.model}:${this.hue}`;
    if (key !== this.rendered) {
      this.rendered = key;
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.beginPath();
      ctx.arc(center, center, outer, 0, turn);
      ctx.moveTo(center + inner, center);
      ctx.arc(center, center, inner, 0, turn);
      ctx.fillStyle = this.ring;
      ctx.fill("evenodd");
      if (this.model === "hsv") this.drawSquare();
      else this.drawTriangle();
    }
    this.resizeMarker();
    this.drawMarkers();
  }

  drawSquare() {
    const ctx = this.ctx;
    const start = center - square;
    const end = center + square;
    const saturation = ctx.createLinearGradient(start, 0, end, 0);
    saturation.addColorStop(0, "#fff");
    saturation.addColorStop(1, rgbToHex(...hsv2rgb(this.hue, 1, 1)));
    const value = ctx.createLinearGradient(0, start, 0, end);
    value.addColorStop(0, "rgba(0,0,0,0)");
    value.addColorStop(1, "#000");
    for (const gradient of [saturation, value]) {
      ctx.fillStyle = gradient;
      ctx.fillRect(start, start, 2 * square, 2 * square);
    }
  }

  drawTriangle() {
    const ctx = this.ctx;
    const top = center - triangleHalfHeight;
    const height = 2 * triangleHalfHeight;
    const pure = hsl2rgb(this.hue, 1, 0.5);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(triangleLeft, top);
    ctx.lineTo(triangleLeft + triangleWidth, center);
    ctx.lineTo(triangleLeft, top + height);
    ctx.closePath();
    ctx.clip();
    // For each column, chroma is fixed. Its upper and lower ends
    // are the mixtures of that amount of pure hue with white and black.
    for (let column = 0; column < triangleWidth; column += 1) {
      const chroma = (column + 0.5) / triangleWidth;
      const half = triangleHalfHeight * (1 - chroma);
      const shade = ctx.createLinearGradient(0, center - half, 0, center + half);
      shade.addColorStop(0, rgbToHex(...pure.map((v) => v * chroma + 1 - chroma)));
      shade.addColorStop(1, rgbToHex(...pure.map((v) => v * chroma)));
      ctx.fillStyle = shade;
      ctx.fillRect(triangleLeft + column, top, 1, height);
    }
    ctx.restore();
  }
}
