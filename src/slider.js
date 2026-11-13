import { WHEEL_RADIUS } from "./wheel.js";
import { gamutClamp, hexToRgb, lin2s, rgb2oklch } from "./oklch.js";

export const SLIDER_W = 24;

export class SliderRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.currentL = 0.65;
    this.low = 0;
    this.high = 1;
    this.color = null;
    this.setHeight(WHEEL_RADIUS * 2);
  }

  setRange(low, high, color = null) {
    if (this.low === low && this.high === high && this.color === color) return;
    this.low = low;
    this.high = high;
    this.color = color;
    this._renderBackground();
  }

  valueAt(fraction) {
    return Math.max(this.low, Math.min(this.high, fraction));
  }

  rowAt(value) {
    const fraction = Math.max(0, Math.min(1, value));
    return Math.round((1 - fraction) * (this.canvas.height - 1));
  }

  setHeight(height) {
    if (this.canvas.width === SLIDER_W && this.canvas.height === height && this._bg) return;
    this.canvas.width = SLIDER_W;
    this.canvas.height = height;
    this._renderBackground();
    this.render(this.currentL);
  }

  _renderBackground() {
    const { width, height } = this.canvas;
    const img = this.ctx.createImageData(width, height);
    const d = img.data;
    const top = this.rowAt(this.high);
    const bottom = this.rowAt(this.low);
    const [, chroma, hue] = this.color ? rgb2oklch(...hexToRgb(this.color)) : [];
    for (let y = 0; y < height; y++) {
      let [r, g, b] = [143, 144, 149];
      if (y >= top && y <= bottom) {
        const L = y === top ? this.high : y === bottom ? this.low : this.pickL(y);
        if (this.color && L > 0 && L < 1) {
          [r, g, b] = gamutClamp(L, chroma, hue).map((channel) => channel * 255);
        } else {
          r = g = b = lin2s(L ** 3) * 255;
        }
      }
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
      }
    }
    this._bg = img;
  }

  render(L) {
    this.currentL = L;
    this.ctx.putImageData(this._bg, 0, 0);
    this.ctx.strokeStyle = "#fff";
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    const y = this.rowAt(L);
    this.ctx.moveTo(0, y);
    this.ctx.lineTo(this.canvas.width, y);
    this.ctx.stroke();
  }

  pickL(y) {
    return this.valueAt(1 - y / (this.canvas.height - 1));
  }
}
