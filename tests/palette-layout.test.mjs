import test from "node:test";
import assert from "node:assert/strict";

import {
  clampWindowAxis,
  MIN_PALETTE_H,
  MIN_PALETTE_W,
  measurePaletteLogicalSize,
} from "../src/palette-layout.js";

test("palette positions remain inside a work area including negative monitor coordinates", () => {
  assert.equal(clampWindowAxis(-1400, 340, -1600, 0), -1400);
  assert.equal(clampWindowAxis(-80, 340, -1600, 0), -340);
  assert.equal(clampWindowAxis(-1700, 340, -1600, 0), -1600);
  assert.equal(clampWindowAxis(400, 340, 200, 500), 200);
});

function element({ width, height }) {
  return {
    scrollWidth: width,
    scrollHeight: height,
    getBoundingClientRect: () => ({ height }),
  };
}

test("palette width follows content rather than an obsolete 340px minimum", () => {
  const topbar = element({ width: MIN_PALETTE_W, height: 26 });
  const container = element({ width: 316, height: 284 });
  const size = measurePaletteLogicalSize(topbar, container);
  assert.deepEqual(size, { width: 316, height: 310 });
});

test("intrinsic content can grow beyond the minimum palette size", () => {
  const topbar = element({ width: 365, height: 28 });
  const container = element({ width: 350, height: 300 });

  assert.deepEqual(measurePaletteLogicalSize(topbar, container), {
    width: 365,
    height: 328,
  });
});

test("small, medium and large modes use their intrinsic width without side gutters", () => {
  for (const [width, height] of [
    [284, 220], [324, 251], [404, 314],
    [284, 273], [324, 313], [404, 393],
  ]) {
    const topbar = element({ width: 220, height: 26.5 });
    const container = element({ width, height });
    assert.deepEqual(measurePaletteLogicalSize(topbar, container, true), {
      width, height: Math.ceil(26.5 + height),
    });
  }
});
