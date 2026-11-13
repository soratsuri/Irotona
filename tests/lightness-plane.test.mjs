import assert from "node:assert/strict";
import test from "node:test";
import { FullPlane, maxPlaneChroma, planeCoordinates, planePoint } from "../src/lightness-plane.js";
import { hexToRgb, oklch2rgb, rgb2oklch } from "../src/oklch.js";
import { SliderRenderer } from "../src/slider.js";

function canvas() {
  let draws = 0;
  const ctx = {
    createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    putImageData: () => { draws++; },
    clearRect() {},
    beginPath() {},
    arc() {},
    fill() {},
    lineTo() {},
    moveTo() {},
    stroke() {},
  };
  return { style: {}, getContext: () => ctx, get draws() { return draws; } };
}

test("palette polygon maps hue and saturation independently", () => {
  for (const hue of [0, 30, 270, 360]) {
    for (const s of [0, 0.4, 1]) {
      const [hueAtPoint, sAtPoint] = planeCoordinates(...planePoint(hue, s));
      assert.ok(Math.abs(hueAtPoint - hue) < 1e-8);
      assert.ok(Math.abs(sAtPoint - s) < 1e-8);
    }
  }
});

test("the chroma limit stays in sRGB across hues and lightness", () => {
  for (const L of [0, 0.05, 0.3, 0.65, 0.95, 1]) {
    for (let h = 0; h < 360; h += 3) {
      const c = maxPlaneChroma(L, h);
      assert.ok(oklch2rgb(L, c, h).every((v) => v >= -1e-7 && v <= 1 + 1e-7));
    }
  }
});

test("full view maps vertical position to all lightnesses and its slider to relative saturation", () => {
  const background = canvas();
  const plane = new FullPlane(background, canvas());
  const slider = new SliderRenderer(canvas());
  slider.setHeight(plane.canvas.height);
  plane.setCurrentColor("#4070b0");
  const input = hexToRgb("#4070b0");
  const axis = plane.rgbToAxis(...input);
  assert.deepEqual(plane.axisRange(), [0, 1]);
  plane.render(axis);
  assert.equal(plane.colorAtAxis(axis), "#4070b0");
  for (const [L, expected] of [[0, "#000000"], [1, "#ffffff"]]) {
    assert.equal(plane.pickAt(...planePoint(220, L)), expected);
  }
  const point = planePoint(220, 0.65);
  plane.pickAt(...point);
  const low = slider.pickL(slider.canvas.height - 1);
  const high = slider.pickL(0);
  assert.deepEqual([low, high], [0, 1]);
  const [neutralL, neutralChroma] = rgb2oklch(...hexToRgb(plane.colorAtAxis(low)));
  const saturated = plane.colorAtAxis(high);
  const [saturatedL, saturatedChroma] = rgb2oklch(...hexToRgb(saturated));
  assert.ok(Math.abs(neutralL - 0.65) < 0.003);
  assert.ok(Math.abs(saturatedL - 0.65) < 0.003);
  assert.ok(neutralChroma < 1e-6 && saturatedChroma > 0.05);
  assert.equal(background.draws, 1);
  plane.setCurrentColor(saturated, plane.getSelectedPoint());
  plane.render(high);
  assert.deepEqual(plane.getSelectedPoint(), point);
  assert.equal(background.draws, 2);
});
