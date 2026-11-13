import test from "node:test";
import assert from "node:assert/strict";
import {
  chromaDeltaForAction,
  createShortcutRepeatGate,
  hueDeltaForAction,
  HUE_SHORTCUT_REPEAT_INTERVAL_MS,
  HUE_SHORTCUT_STEP_DEGREES,
  lightnessDeltaForAction,
  LIGHTNESS_SHORTCUT_STEP,
} from "../src/shortcuts.js";

test("all color actions apply the configured step symmetrically", () => {
  assert.equal(chromaDeltaForAction("chroma_up"), 0.025);
  assert.equal(chromaDeltaForAction("chroma_down"), -0.025);
  for (const [delta, up, down, step] of [
    [hueDeltaForAction, "hue_next", "hue_prev", 7.5],
    [chromaDeltaForAction, "chroma_up", "chroma_down", 0.065],
    [lightnessDeltaForAction, "light_up", "light_down", 0.005],
  ]) {
    assert.equal(delta(up, step), step);
    assert.equal(delta(down, step), -step);
    assert.equal(delta("close", step), null);
  }
});

test("rapid independent Turbo-style presses each apply a full configured hue step", () => {
  let time = 0;
  const allow = createShortcutRepeatGate({ now: () => time });
  let moved = 0;
  for (let press = 0; press < 20; press++) {
    if (allow("hue_next", { repeat: false })) moved += hueDeltaForAction("hue_next", 3.5);
    time += 10;
  }
  assert.equal(moved, 70);
  assert.equal(allow("hue_next", { repeat: true }), false);
});

test("hue shortcuts move both directions by two degrees", () => {
  assert.equal(HUE_SHORTCUT_STEP_DEGREES, 2);
  assert.equal(hueDeltaForAction("hue_next"), 2);
  assert.equal(hueDeltaForAction("hue_prev"), -2);
  assert.equal(hueDeltaForAction("cycle_mode"), null);
});

test("lightness shortcuts move both directions by 0.01", () => {
  assert.equal(LIGHTNESS_SHORTCUT_STEP, 0.01);
  assert.equal(lightnessDeltaForAction("light_up"), 0.01);
  assert.equal(lightnessDeltaForAction("light_down"), -0.01);
  assert.equal(lightnessDeltaForAction("chroma_up"), null);
});

test("held hue shortcut accepts OS key repeats at a stable pace", () => {
  let time = 0;
  const allow = createShortcutRepeatGate({
    intervalMs: HUE_SHORTCUT_REPEAT_INTERVAL_MS,
    now: () => time,
  });

  assert.equal(allow("hue_next", { repeat: false }), true);
  time = 30;
  assert.equal(allow("hue_next", { repeat: true }), false);
  time = HUE_SHORTCUT_REPEAT_INTERVAL_MS - 1;
  assert.equal(allow("hue_next", { repeat: true }), false);
  time = HUE_SHORTCUT_REPEAT_INTERVAL_MS;
  assert.equal(allow("hue_next", { repeat: true }), true);
  time += HUE_SHORTCUT_REPEAT_INTERVAL_MS;
  assert.equal(allow("hue_next", { repeat: true }), true);
});

test("independent hue directions and physical presses stay responsive", () => {
  let time = 100;
  const allow = createShortcutRepeatGate({ now: () => time });

  assert.equal(allow("hue_next", { repeat: false }), true);
  assert.equal(allow("hue_prev", { repeat: false }), true);
  assert.equal(allow("hue_next", { repeat: false }), true);
  assert.equal(allow("hue_next", { repeat: true }), false);
  time += HUE_SHORTCUT_REPEAT_INTERVAL_MS;
  assert.equal(allow("hue_next", { repeat: true }), true);
});
