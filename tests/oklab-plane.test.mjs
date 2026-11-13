import assert from "node:assert/strict";
import test from "node:test";
import { OklabPlane, abToPoint, brushScale, gamutSection, pointToAb } from "../src/oklab-plane.js";
import { hexToRgb, oklabToLinear, rgb2oklch } from "../src/oklch.js";
import { resizeMarkerCanvas } from "../src/marker-canvas.js";
import { SliderRenderer } from "../src/slider.js";

function canvas() {
  const surface = { style: {}, getContext: () => ctx };
  const ctx = {
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData(image) { surface.image = image; },
    clearRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {}, moveTo() {}, lineTo() {},
  };
  return surface;
}

test("dark, middle and light outlines run along actual faces of the linear sRGB cube", () => {
  const sections = [0.12, 0.54, 0.91].map((L) => {
    const outline = gamutSection(L);
    assert.ok(outline.length > 80);
    for (const [a, b] of outline) {
      const rgb = oklabToLinear(L, a, b);
      assert.ok(rgb.every((value) => value >= -2e-6 && value <= 1 + 2e-6));
      assert.ok(rgb.some((value) => Math.min(Math.abs(value), Math.abs(1 - value)) < 2e-6));
    }
    return Math.max(...outline.map(([a, b]) => Math.hypot(a, b)));
  });
  assert.ok(sections[0] < sections[1]);
  assert.ok(sections[2] < sections[1]);
});

test("Focused selection, lightness adjustment and reference restore share the same axis", () => {
  const plane = new OklabPlane(canvas(), canvas());
  const slider = new SliderRenderer(canvas());
  slider.setHeight(plane.canvas.height);
  const reference = "#4070b0";
  plane.setReferenceColor(reference);
  plane.setCurrentColor(reference);
  const range = plane.axisRange();
  const sampledL = plane.rgbToAxis(...hexToRgb(reference));
  const sampledPoint = [...plane.getSelectedPoint()];
  plane.render(sampledL);
  for (const fraction of [0, 0.5, 1]) {
    slider.setRange(...range, plane.hex);
    const L = slider.pickL((slider.canvas.height - 1) * fraction);
    plane.setCurrentColor(plane.colorAtAxis(L), plane.pointAtAxis(L));
    plane.render(L);
    const point = plane.clampPoint(148, 108);
    const hex = plane.pickAt(...point);
    assert.ok(hex);
    plane.setCurrentColor(hex, point);
    slider.setRange(...plane.axisRange(), hex);
    slider.render(L);
    assert.deepEqual(plane.axisRange(), range);
    assert.equal(slider.currentL, L);
    assert.ok(Math.abs(plane.rgbToAxis(...hexToRgb(hex)) - L) < 0.003);
  }
  plane.setCurrentColor(reference);
  plane.render(sampledL);
  slider.setRange(...plane.axisRange(), reference);
  slider.render(sampledL);
  assert.equal(plane.hex, reference);
  assert.deepEqual(plane.getSelectedPoint(), sampledPoint);
  assert.deepEqual(plane.axisRange(), range);
  assert.equal(slider.currentL, sampledL);
});

test("the Focused interval follows selected chroma, stays stable during lightness edits, and restores", () => {
  const plane = new OklabPlane(canvas(), canvas());
  const reference = "#888888";
  plane.setReferenceColor(reference);
  plane.setCurrentColor(reference);
  const sampledL = plane.rgbToAxis(...hexToRgb(reference));
  const base = plane.selectedAxisRange(sampledL);
  assert.deepEqual(base, plane.axisRange());

  plane.setCurrentColor("#ff0000");
  const L = plane.rgbToAxis(1, 0, 0);
  const narrowed = plane.selectedAxisRange(L);
  assert.ok(narrowed[0] <= L && L <= narrowed[1]);
  assert.ok(narrowed[1] - narrowed[0] < 0.01);
  assert.deepEqual(plane.axisRange(), base);
  for (const value of narrowed) {
    plane.setCurrentColor(plane.colorAtAxis(value), plane.pointAtAxis(value));
    assert.equal(plane.selectedAxisRange(value), narrowed);
  }
  plane.setCurrentColor(reference);
  assert.deepEqual(plane.selectedAxisRange(sampledL), base);
});

test("OKLab coordinates round trip and the neutral center stays selectable at both endpoints", () => {
  const scale = [420, 330];
  const expected = [0.11, -0.07];
  const actual = pointToAb(...abToPoint(...expected, scale), scale);
  assert.ok(actual.every((value, i) => Math.abs(value - expected[i]) < 1e-8));
  const plane = new OklabPlane(canvas(), canvas());
  for (const [L, expected] of [[0, "#000000"], [1, "#ffffff"]]) {
    plane.render(L);
    assert.equal(plane.pickAt(140, 110), expected);
    assert.equal(plane.pickAt(0, 0), null);
  }
});

test("out-of-gamut drags land on selectable colors and slider moves keep the marker and base", () => {
  const surface = canvas();
  const plane = new OklabPlane(surface, canvas());
  const sample = "#d59477";
  plane.setReferenceColor(sample);
  plane.setCurrentColor(sample);
  const L = plane.rgbToAxis(...hexToRgb(sample));
  plane.render(L);
  assert.equal(plane.pickAt(...plane.getSelectedPoint()), sample);
  const base = plane.axisRange();
  const outline = surface.style.clipPath;
  assert.equal(plane.pickAt(5, 5), null);
  const point = plane.clampPoint(5, 5);
  const color = plane.pickAt(...point);
  assert.ok(color);
  assert.ok(Math.abs(rgb2oklch(...hexToRgb(color))[0] - L) < 0.003);
  plane.setCurrentColor(color, point);
  const nextL = L - 0.15;
  const nextPoint = plane.pointAtAxis(nextL);
  const darker = plane.colorAtAxis(nextL);
  plane.setCurrentColor(darker, nextPoint);
  plane.render(nextL);
  assert.notEqual(surface.style.clipPath, outline);
  assert.deepEqual(plane.axisRange(), base);
  assert.deepEqual(plane.getSelectedPoint(), point);
  const [newL, , newHue] = rgb2oklch(...hexToRgb(darker));
  const [, , oldHue] = rgb2oklch(...hexToRgb(color));
  assert.ok(Math.abs(newL - nextL) < 0.003);
  assert.ok(Math.abs(((newHue - oldHue + 540) % 360) - 180) < 2);
});

test("a temporarily unrepresentable chroma is restored when lightness returns", () => {
  const plane = new OklabPlane(canvas(), canvas());
  const hex = "#6943ed";
  const L = plane.rgbToAxis(...hexToRgb(hex));
  plane.setCurrentColor(hex);
  plane.render(L);
  const marker = [...plane.getSelectedPoint()];
  for (const next of [0.85, 1, 0.24, L]) {
    plane.setCurrentColor(plane.colorAtAxis(next), plane.pointAtAxis(next));
    plane.render(next);
    assert.deepEqual(plane.getSelectedPoint(), marker);
  }
  assert.equal(plane.hex, hex);
});

test("the focused lightness range follows the sample and includes the color on entry from Full", () => {
  const plane = new OklabPlane(canvas(), canvas());
  for (const [reference, entry] of [["#191919", "#f1f1f1"], ["#e5e5e5", "#e5e5e5"]]) {
    plane.setReferenceColor(reference);
    plane.setCurrentColor(entry);
    const base = plane.rgbToAxis(...hexToRgb(reference));
    const L = plane.rgbToAxis(...hexToRgb(entry));
    assert.deepEqual(plane.axisRange(), [Math.min(L, Math.max(0, base - 0.16)), Math.max(L, Math.min(1, base + 0.16))]);
  }
});

test("a drag across the bent plane selects the rendered pixels without jumps", () => {
  const surface = canvas();
  const plane = new OklabPlane(surface, canvas());
  for (const L of [0.25, 0.62, 0.9]) {
    plane.render(L);
    let previous;
    for (let x = 129; x <= 151; x++) {
      const y = 109 + Math.floor((x - 140) / 3);
      const hex = plane.pickAt(x, y);
      assert.ok(hex);
      const start = (y * 280 + x) * 4;
      const pixel = Array.from(surface.image.data.slice(start, start + 3));
      assert.deepEqual(hexToRgb(hex).map((value) => Math.round(255 * value)), pixel);
      if (previous) assert.ok(pixel.every((value, i) => Math.abs(value - previous[i]) < 15));
      previous = pixel;
    }
  }
});

test("six brush sections fit the canvas and retain lightness-dependent area", () => {
  const plane = new OklabPlane(canvas(), canvas());
  const sizes = [0.14, 0.30, 0.48, 0.66, 0.85, 0.98].map((L) => {
    const { outline } = plane.section(L);
    assert.ok(brushScale(L, gamutSection(L)).every((scale) => scale > 0));
    assert.ok(outline.every(([x, y]) => x > 0 && x < 280 && y > 0 && y < 220));
    return Math.abs(outline.reduce((sum, [x, y], i) => {
      const [nx, ny] = outline[(i + 1) % outline.length];
      return sum + x * ny - y * nx;
    }, 0));
  });
  assert.ok(sizes[0] < sizes[3]);
  assert.ok(sizes[5] < sizes[3] / 3);
});

test("rounded brush outlines avoid multi-pixel steps at gamut boundaries", () => {
  const plane = new OklabPlane(canvas(), canvas());
  for (const hex of ["#FFEBE7", "#D67288", "#5E7AA7", "#2A2A2A"]) {
    const L = plane.rgbToAxis(...hexToRgb(hex));
    const { outline, scale } = plane.section(L);
    let largestStep = 0;
    for (let i = 0; i < outline.length; i++) {
      const [x, y] = outline[i];
      const [nx, ny] = outline[(i + 1) % outline.length];
      largestStep = Math.max(largestStep, Math.hypot(nx - x, ny - y));
      const [a, b] = pointToAb(x, y, scale);
      assert.ok(oklabToLinear(L, a, b).every((channel) =>
        channel >= -1e-7 && channel <= 1 + 1e-7
      ), `out-of-gamut outline at ${hex}, index ${i}`);
    }
    assert.ok(largestStep < 2.5, `outline step at ${hex}: ${largestStep.toFixed(2)} px`);
  }
});

test("marker backing resolution follows fractional DPI without changing pointer dimensions", () => {
  const surface = { width: 280, height: 220, clientWidth: 360, clientHeight: 283 };
  const marker = {};
  const calls = [];
  const ctx = { setTransform: (...args) => calls.push(args) };
  assert.equal(resizeMarkerCanvas(surface, marker, ctx, 1.5), true);
  assert.deepEqual(marker, { width: 540, height: 425 });
  assert.deepEqual(calls[0], [540 / 280, 0, 0, 425 / 220, 0, 0]);
  assert.equal(resizeMarkerCanvas(surface, marker, ctx, 1.5), false);
  assert.equal(surface.width, 280);
});
