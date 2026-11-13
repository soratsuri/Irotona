import assert from "node:assert/strict";
import test from "node:test";
import { bindColorPointer, createColorSender } from "../src/color-input.js";
import { accelFromEvent, createShortcutCapture, nextPaletteMode } from "../src/shortcuts.js";
import { SliderRenderer } from "../src/slider.js";

test("palette cycling uses only enabled modes, even when the current mode is excluded", () => {
  assert.equal(nextPaletteMode("oklch"), "hsv");
  assert.equal(nextPaletteMode("oklch", ["oklch", "plane"]), "plane");
  assert.equal(nextPaletteMode("plane", ["oklch", "plane"]), "oklch");
  assert.equal(nextPaletteMode("lab", ["oklch", "plane"]), "plane");
  assert.equal(nextPaletteMode("hsv", ["plane"]), "plane");
  assert.equal(nextPaletteMode("plane", ["plane"]), "plane");
  assert.equal(nextPaletteMode("plane"), "circle");
  assert.equal(nextPaletteMode("circle", ["oklch", "plane"]), "oklch");
  assert.equal(nextPaletteMode("plane", ["plane", "circle"]), "circle");
});

function pointerFixture(begin, {
  slider, displayHeight = 50, displayWidth = 100,
  logicalWidth = 200, logicalHeight = 100,
} = {}) {
  const handlers = new Map();
  const frames = new Map();
  const selected = [];
  const captured = new Set();
  const commits = [];
  let frameId = 0;
  const canvas = Object.assign(slider?.canvas ?? { width: logicalWidth, height: logicalHeight }, {
    getBoundingClientRect: () => ({ left: 5, top: 10, width: slider ? 24 : displayWidth, height: displayHeight }),
    addEventListener: (event, callback) => handlers.set(event, callback),
    setPointerCapture: (id) => captured.add(id),
    hasPointerCapture: (id) => captured.has(id),
    releasePointerCapture: (id) => captured.delete(id),
  });
  const finish = bindColorPointer(canvas, (x, y) => selected.push(slider ? slider.pickL(y) : [x, y]), {
    begin,
    commit: () => commits.push(selected.at(-1)),
    requestFrame(callback) {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelFrame: (id) => frames.delete(id),
  });
  return {
    fire(type, data) {
      handlers.get(type)?.({ pointerId: 1, pointerType: "pen", buttons: 0,
        clientX: 15, clientY: 20, ...data });
    },
    frame() { for (const callback of [...frames.values()]) callback(); },
    selected,
    captured,
    commits,
    finish,
  };
}

test("vertical slider pen drags use Y across all plane sizes and commit the release position", () => {
  const ctx = {
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
  };
  const slider = new SliderRenderer({ getContext: () => ctx });
  const sliderSizes = [240, 280, 360].flatMap((width) => [
    { backingHeight: 220, displayHeight: width * 220 / 280 },
    { backingHeight: 280, displayHeight: width },
  ]);
  for (const { backingHeight, displayHeight } of sliderSizes) {
    slider.setHeight(backingHeight);
    const middle = 10 + displayHeight * (backingHeight - 1) / (2 * backingHeight);
    const { fire, frame, selected, commits } = pointerFixture(undefined, { slider, displayHeight });
    fire("pointerdown", { button: 0, buttons: 1, clientY: 10 });
    fire("pointermove", { buttons: 1, clientY: middle });
    frame();
    assert.equal(selected[0], 1);
    assert.ok(Math.abs(selected[1] - 0.5) < 1e-12);
    fire("pointermove", { buttons: 1, clientY: 10 });
    fire("pointerup", { button: 0, clientX: 100, clientY: middle });
    assert.deepEqual(commits, [selected[1]]);
    fire("pointerdown", { button: 0, buttons: 1, clientY: 10 });
    fire("pointerup", { button: 0, clientY: 10 + displayHeight });
    assert.deepEqual(commits, [selected[1], 0]);
  }
});

test("shared palette sizes map the center to identical logical wheel and plane coordinates", () => {
  for (const displayWidth of [240, 280, 360]) {
    for (const logicalHeight of [280, 220]) {
      const displayHeight = displayWidth * logicalHeight / 280;
      const { fire, selected } = pointerFixture(undefined, {
        displayWidth, displayHeight, logicalWidth: 280, logicalHeight,
      });
      fire("pointerdown", {
        button: 0, buttons: 1,
        clientX: 5 + displayWidth / 2,
        clientY: 10 + displayHeight / 2,
      });
      assert.deepEqual(selected, [[140, logicalHeight / 2]]);
    }
  }
});

test("a pointer gesture captures only after a logical hit and exposes active editing", () => {
  const { fire, finish, selected } = pointerFixture((x) => x >= 40);
  fire("pointerdown", { button: 0, buttons: 1 });
  assert.equal(finish.isActive(), false);
  fire("pointerdown", { button: 0, buttons: 1, clientX: 25 });
  assert.equal(finish.isActive(), true);
  fire("pointerup", { button: 0, clientX: 20 });
  assert.equal(finish.isActive(), false);
  assert.deepEqual(selected, [[40, 20], [30, 20]]);
});

test("restoring a sample can discard a captured gesture without committing the queued point", () => {
  const f = pointerFixture();
  f.fire("pointerdown", { button: 0, buttons: 1 });
  f.fire("pointermove", { clientX: 35, buttons: 1 });
  f.finish({ discard: true });
  f.frame();
  f.fire("pointerup", { button: 0 });
  assert.deepEqual(f.selected, [[20, 20]]);
  assert.deepEqual(f.commits, []);
  assert.equal(f.captured.size, 0);
});

test("pen selects only during contact and commits the pointerup position immediately", () => {
  const { fire, frame, selected, captured, commits } = pointerFixture();
  fire("pointerenter");
  fire("pointermove", { clientX: 25 });
  frame();
  assert.deepEqual(selected, []);
  fire("pointerdown", { button: 0, buttons: 1 });
  fire("pointermove", { clientX: 25, buttons: 1 });
  fire("pointermove", { clientX: 35, buttons: 1 });
  frame();
  fire("pointermove", { clientX: 45, buttons: 1 });
  fire("pointerup", { clientX: 50, button: 0 });
  fire("pointermove", { clientX: 55 });
  frame();
  assert.deepEqual(selected, [[20, 20], [60, 20], [90, 20]]);
  assert.deepEqual(commits, [[90, 20]]);
  assert.equal(captured.size, 0);
});

test("mouse drag stays captured outside the canvas and only the primary button selects", () => {
  const { fire, frame, selected, captured, commits } = pointerFixture();
  fire("pointermove", { pointerType: "mouse" });
  fire("pointerdown", { button: 2, buttons: 2 });
  frame();
  assert.deepEqual(selected, []);
  fire("pointerdown", { pointerType: "mouse", button: 0, buttons: 1 });
  assert.ok(captured.has(1));
  fire("pointerleave", { pointerType: "mouse", buttons: 1 });
  fire("pointermove", { pointerType: "mouse", clientX: 125, buttons: 1 });
  frame();
  fire("pointerup", { pointerType: "mouse", clientX: 120, button: 0 });
  fire("pointermove", { pointerType: "mouse" });
  frame();
  assert.equal(captured.size, 0);
  assert.deepEqual(selected, [[20, 20], [240, 20], [230, 20]]);
  assert.deepEqual(commits, [[230, 20]]);
});

for (const ending of ["pointercancel", "lostpointercapture", "blur", "hover without pointerup"]) {
  test(ending + " commits the last contact sample and ends the drag", () => {
    const { fire, frame, selected, commits, finish, captured } = pointerFixture();
    fire("pointerdown", { button: 0, buttons: 1 });
    fire("pointermove", { clientX: 30, buttons: 1 });
    if (ending === "blur") finish();
    else if (ending === "hover without pointerup") fire("pointermove", { clientX: 90 });
    else fire(ending, { clientX: 90 });
    fire("pointermove", { clientX: 100, buttons: 1 });
    fire("pointerup", { clientX: 110, button: 0 });
    frame();
    assert.deepEqual(selected, [[20, 20], [50, 20]]);
    assert.deepEqual(commits, [[50, 20]]);
    assert.equal(captured.size, 0);
  });
}

test("one color command at a time, with the latest drag color sent after the rate limit", async () => {
  const sent = [];
  let releaseFirst;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const sender = createColorSender(async (color) => {
    sent.push(color);
    if (sent.length === 1) await new Promise((resolve) => { releaseFirst = resolve; });
    else finish();
  }, { interval: 10 });
  sender.enqueue("#100000");
  sender.enqueue("#200000");
  sender.enqueue("#300000");
  assert.deepEqual(sent, ["#100000"]);
  releaseFirst();
  await done;
  assert.deepEqual(sent, ["#100000", "#300000"]);
});

test("color sender preserves optional hue metadata with the queued color", async () => {
  const sent = [];
  const sender = createColorSender(async (...entry) => { sent.push(entry); });
  sender.enqueue("#808080", 12, { preservedHue: 1 / 3 });
  sender.flush();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [["#808080", 12, { preservedHue: 1 / 3 }]]);
});

test("committing the drag flushes only the newest unsent color after a failed request", async () => {
  const sent = [];
  let rejectFirst;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const sender = createColorSender(async (color) => {
    sent.push(color);
    if (sent.length === 1) await new Promise((_, reject) => { rejectFirst = reject; });
    else finish();
  }, { interval: 60_000, onError: () => assert.fail("superseded error") });
  sender.enqueue("#000001");
  sender.enqueue("#000002");
  sender.enqueue("#000003");
  sender.flush();
  rejectFirst(new Error("stale command failed"));
  await done;
  assert.deepEqual(sent, ["#000001", "#000003"]);
});

test("new sample discards queued drag colors and tags in-flight writes with their sample request", async () => {
  const sent = [];
  let releaseFirst;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const sender = createColorSender(async (color, request) => {
    sent.push([color, request]);
    if (sent.length === 1) await new Promise((resolve) => { releaseFirst = resolve; });
    finish();
  }, { interval: 0 });

  sender.enqueue("#old-color", 7);
  sender.enqueue("#queued-old-color", 7);
  sender.discardPending();
  releaseFirst();
  await done;

  assert.deepEqual(sent, [["#old-color", 7]]);
});
test("shortcuts ignore IME events and normalize modified number keys", () => {
  assert.equal(accelFromEvent({ isComposing: true, key: "a" }), null);
  assert.equal(accelFromEvent({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true }), "Ctrl+Shift+1");
});

test("eyedropper recording accepts plain keys, chords and standalone Alt", () => {
  const capture = createShortcutCapture(true);
  assert.equal(capture({ type: "keydown", key: "q" }), "Q");
  assert.equal(capture({ type: "keydown", key: "F8" }), "F8");
  assert.equal(capture({ type: "keydown", key: "q", ctrlKey: true }), "Ctrl+Q");
  assert.equal(capture({ type: "keydown", key: "Alt", altKey: true }), null);
  assert.equal(capture({ type: "keydown", key: "Alt", altKey: true, repeat: true }), null);
  assert.equal(capture({ type: "keyup", key: "Alt" }), "Alt");
  assert.equal(capture({ type: "keydown", key: "Alt", altKey: true }), null);
  assert.equal(capture({ type: "keydown", key: "q", altKey: true }), "Alt+Q");
  assert.equal(capture({ type: "keyup", key: "Alt" }), null);

  const manual = createShortcutCapture(false);
  assert.equal(manual({ type: "keydown", key: "Alt", altKey: true }), null);
  assert.equal(manual({ type: "keyup", key: "Alt" }), null);
});
