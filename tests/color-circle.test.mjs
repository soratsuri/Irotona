import assert from "node:assert/strict";
import test from "node:test";
import { ColorCircle, centerComponents, centerPoint, circleRegion, hueAt } from "../src/color-circle.js";

test("hue ring maps 0°, 90°, 180° and 270° clockwise from the top", () => {
  const points = [[140, 12], [268, 140], [140, 268], [12, 140]];
  for (const [index, point] of points.entries()) {
    assert.equal(hueAt(...point), index / 4);
    assert.equal(circleRegion("hsv", ...point), "hue");
  }
  assert.equal(circleRegion("hsv", 0, 0), null);
  assert.equal(circleRegion("hls", 245, 140), null);
});

test("HSV square maps the four corners and center in logical coordinates", () => {
  for (const [point, components] of [
    [[62, 62], [0, 1]], [[218, 62], [1, 1]],
    [[62, 218], [0, 0]], [[218, 218], [1, 0]], [[140, 140], [0.5, 0.5]],
  ]) {
    assert.equal(circleRegion("hsv", ...point), "center");
    assert.deepEqual(centerComponents("hsv", ...point), components);
    assert.deepEqual(centerPoint("hsv", ...components), point);
  }
  assert.deepEqual(centerComponents("hsv", 300, 300), [1, 0]);
});

test("HLS triangle maps white, black, pure hue, its edges and its interior", () => {
  for (const [point, components] of [
    [[78, 48], [0, 1]], [[78, 232], [0, 0]], [[236, 140], [1, 0.5]],
    [[78, 140], [0, 0.5]], [[157, 94], [1, 0.75]], [[117.5, 94], [0.5, 0.75]],
  ]) {
    assert.equal(circleRegion("hls", ...point), "center");
    assert.deepEqual(centerComponents("hls", ...point), components);
    assert.deepEqual(centerPoint("hls", ...components), point);
  }
  assert.deepEqual(centerComponents("hls", 300, 94), [1, 0.75]);
});

function makeCircle(model) {
  const surface = { getContext: () => ({ createConicGradient: () => ({ addColorStop() {} }) }) };
  return new ColorCircle({ ...surface }, { ...surface }, model);
}

test("circle drag keeps its starting region and preserves latent hue for gray and black", () => {
  const circle = makeCircle("hsv");
  circle.setCurrentColor("#408000");
  const before = [circle.saturation, circle.level];
  assert.equal(circle.begin(268, 140), true);
  assert.equal(circle.pickAt(140, 268), "#008080");
  assert.deepEqual([circle.saturation, circle.level], before);
  assert.equal(circle.begin(62, 218), true);
  assert.equal(circle.pickAt(268, 12), "#00ffff");
  assert.equal(circle.hue, 0.5);
  for (const hex of ["#000000", "#808080", "#ffffff"]) {
    circle.setCurrentColor(hex);
    assert.equal(circle.hue, 0.5);
    assert.equal(circle.hex(), hex);
  }
});

test("HSV and HLS use the same RGB when switching models", () => {
  const circle = makeCircle("hsv");
  for (const hex of ["#6397c1", "#000000", "#ffffff", "#ff0001", "#cc00ff"]) {
    for (const model of ["hsv", "hls"]) {
      circle.model = model;
      circle.setCurrentColor(hex);
      assert.equal(circle.hex(), hex);
    }
  }
});

test("neutral and nearly neutral colors retain the deliberately selected hue", () => {
  for (const model of ["hsv", "hls"]) {
    const circle = makeCircle(model);
    circle.hue = 120 / 360;
    circle.setCurrentColor("#808080");
    assert.equal(circle.hue, 120 / 360);
    circle.saturation = 0;
    assert.equal(circle.hex(), "#808080");
    circle.saturation = 0.01;
    const nearGray = circle.hex();
    circle.setCurrentColor(nearGray);
    assert.equal(circle.hue, 120 / 360);
    circle.saturation = 1;
    const restored = circle.hex();
    assert.equal(restored, model === "hsv" ? "#008000" : "#01ff01");
  }
});
