import test from "node:test";
import assert from "node:assert/strict";

import { createWheel } from "../src/wheel.js";
import { SliderRenderer } from "../src/slider.js";

function fakeContext() {
  const context = {
    arc() {},
    beginPath() {},
    createImageData(width, height) {
      return { data: new Uint8ClampedArray(width * height * 4) };
    },
    fill() {},
    lineTo() {},
    moveTo(x, y) { context.marker = [x, y]; },
    putImageData() {},
    stroke() {},
  };
  return context;
}

function fakeCanvas() {
  const context = fakeContext();
  return {
    getContext: () => context,
    height: 0,
    width: 0,
  };
}

const HEX_COLOR = /^#[0-9a-f]{6}$/;

for (const type of ["oklch", "hsv", "hsl", "lab"]) {
  test(`${type} axis edits preserve the selected point at both endpoints`, () => {
    const wheel = createWheel(fakeCanvas(), type);
    wheel.setCurrentColor("#c45a73");
    const sampledPoint = wheel.getSelectedPoint();

    const sampledLow = wheel.colorAtAxis(0);
    const sampledHigh = wheel.colorAtAxis(1);

    assert.match(sampledLow, HEX_COLOR);
    assert.match(sampledHigh, HEX_COLOR);
    assert.notEqual(sampledLow, "#c45a73");
    assert.notEqual(sampledHigh, "#c45a73");
    assert.notEqual(sampledLow, sampledHigh);
    assert.deepEqual(wheel.getSelectedPoint(), sampledPoint);

    assert.match(wheel.pickAt(185, 105), HEX_COLOR);
    const interactedPoint = wheel.getSelectedPoint();
    const interactedLow = wheel.colorAtAxis(0);
    const interactedHigh = wheel.colorAtAxis(1);

    assert.notEqual(interactedLow, interactedHigh);
    assert.deepEqual(wheel.getSelectedPoint(), interactedPoint);
  });
}

test("slider exposes the complete 0 to 100 percent range", () => {
  const slider = new SliderRenderer(fakeCanvas());

  assert.equal(slider.pickL(0), 1);
  assert.equal(slider.pickL(slider.canvas.height - 1), 0);
  assert.equal(slider.pickL(-100), 1);
  assert.equal(slider.pickL(slider.canvas.height + 100), 0);
});

function planeSlider() {
  const slider = new SliderRenderer(fakeCanvas());
  slider.setHeight(220);
  return slider;
}

function sampleRow(slider, row) {
  const offset = row * slider.canvas.width * 4;
  return [...slider._bg.data.slice(offset, offset + 4)];
}

test("Focused shades only the available vertical interval and marks absolute lightness", () => {
  const slider = planeSlider();
  slider.setRange(0.34, 0.66, "#4070b0");
  const span = slider.canvas.height - 1;
  const gray = [143, 144, 149, 255];
  assert.deepEqual(sampleRow(slider, 0), gray);
  assert.deepEqual(sampleRow(slider, span), gray);
  const center = sampleRow(slider, Math.round(span / 2));
  assert.ok(center[2] > center[0]);

  for (const [y, expected] of [[-1, 0.66], [span / 2, 0.5], [span + 1, 0.34]]) {
    const picked = slider.pickL(y);
    assert.equal(picked, expected);
    slider.render(picked);
    const markerRow = Math.round((1 - expected) * span);
    assert.deepEqual(slider.ctx.marker, [0, markerRow]);
    assert.notDeepEqual(sampleRow(slider, markerRow), gray);
  }

  slider.setRange(0, 1);
  assert.deepEqual(sampleRow(slider, 0), [255, 255, 255, 255]);
  assert.deepEqual(sampleRow(slider, span), [0, 0, 0, 255]);
});

test("Focused gradient follows selection hue without moving the axis marker", () => {
  const slider = planeSlider();
  const middle = Math.round((slider.canvas.height - 1) / 2);
  slider.setRange(0.34, 0.66, "#2b8b52");
  slider.render(0.51);
  const green = sampleRow(slider, middle);
  const marker = slider.ctx.marker;
  slider.setRange(0.34, 0.66, "#ac436f");
  slider.render(slider.currentL);
  const pink = sampleRow(slider, middle);
  assert.ok(green[1] > green[0] && pink[0] > pink[1]);
  assert.deepEqual(slider.ctx.marker, marker);
  assert.equal(slider.currentL, 0.51);
});

test("Focused reaches black and white when allowed, and Full spans the entire track", () => {
  const slider = planeSlider();
  const span = slider.canvas.height - 1;
  slider.setRange(0, 0.16, "#150c21");
  assert.equal(slider.pickL(span), 0);
  assert.deepEqual(sampleRow(slider, span), [0, 0, 0, 255]);
  slider.setRange(0.84, 1, "#eedcce");
  assert.equal(slider.pickL(0), 1);
  assert.deepEqual(sampleRow(slider, 0), [255, 255, 255, 255]);

  slider.setRange(0, 1);
  assert.equal(slider.pickL(0), 1);
  assert.equal(slider.pickL(span / 2), 0.5);
  assert.equal(slider.pickL(span), 0);
});

test("a single-lightness range has one colored marker row and clamps on both sides", () => {
  const slider = planeSlider();
  const L = 0.628;
  slider.setRange(L, L, "#ff0000");
  slider.render(L);
  const row = Math.round((1 - L) * (slider.canvas.height - 1));
  const sample = sampleRow(slider, row);
  assert.ok(sample[0] > sample[1]);
  assert.deepEqual(slider.ctx.marker, [0, row]);
  assert.equal(slider.pickL(0), L);
  assert.equal(slider.pickL(slider.canvas.height), L);
});

test("leaving the plane restores the standard slider height and marker mapping", () => {
  const slider = planeSlider();
  slider.render(0.75);
  slider.setHeight(280);
  assert.equal(slider.canvas.width, 24);
  assert.equal(slider.canvas.height, 280);
  assert.deepEqual(slider.ctx.marker, [0, 70]);
  assert.equal(slider.pickL(279), 0);
});
