import assert from "node:assert/strict";
import test from "node:test";
import { createColorSender } from "../src/color-input.js";
import {
  applyColorUpdate,
  applyPaletteShow,
  applyPassiveColorSample,
  applyLocalPaletteColor,
  shouldApplyColorUpdate,
} from "../src/palette-color-state.js";

test("passive CSP sync ignores the local echo, but accepts a new color or slot", () => {
  const state = lumaState();
  const echo = { r: 0x33, g: 0x44, b: 0x55, slot: 0, sample_request: 7 };
  const ignored = applyPassiveColorSample(state, echo, 7, false);
  assert.deepEqual(ignored, { accepted: false, ...state });
  const switched = applyPassiveColorSample(state, { ...echo, slot: 1 }, 7, false);
  assert.equal(switched.accepted, true);
  assert.equal(switched.currentSlot, 1);
  assert.equal(switched.referenceHex, state.currentHex);
  const external = applyPassiveColorSample(state, { ...echo, r: 0xff }, 7, false);
  assert.equal(external.currentHex, "#ff4455");
  assert.equal(external.referenceHex, "#ff4455");
});

test("passive reads cannot replace a new eyedropper sample, local edit or failed read", () => {
  const state = lumaState();
  const earlier = { r: 255, g: 0, b: 0, slot: 0, sample_request: 7 };
  for (const [sample, request, superseded] of [
    [earlier, 8, false], [earlier, 7, true], [null, 7, false],
    [{ ...earlier, r: null }, 7, false],
  ]) {
    assert.deepEqual(applyPassiveColorSample(state, sample, request, superseded), {
      accepted: false, ...state,
    });
  }
});

test("restoring a sample replaces queued colors and keeps the reference and generation", async () => {
  const state = { ...lumaState(), sampleRequest: 8 };
  let complete;
  const first = new Promise((resolve) => { complete = resolve; });
  const sent = [];
  const sender = createColorSender((hex, request) => {
    sent.push([hex, request]);
    return sent.length === 1 ? first : Promise.resolve(true);
  });
  sender.enqueue(state.currentHex, state.sampleRequest);
  sender.enqueue("#ff66aa", state.sampleRequest);
  const apply = (hex) => { state.currentHex = hex; };
  applyLocalPaletteColor(state.referenceHex, state, apply, sender);
  applyLocalPaletteColor(state.referenceHex, state, apply, sender); // same color adds no send
  complete(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [["#334455", 8], ["#112233", 8]]);
  assert.equal(state.currentHex, state.referenceHex);
  assert.equal(state.referenceHex, "#112233");
  const sampled = applyPaletteShow(state, {
    r: 20, g: 100, b: 40, slot: 0, request: 9, afterEyedropper: true,
  }, state.sampleRequest);
  assert.equal(sampled.currentHex, "#146428");
  assert.equal(sampled.referenceHex, "#146428");
});

test("slot recall supersedes a queued drag, keeps the sample, and avoids a duplicate send", async () => {
  const state = { ...lumaState(), sampleRequest: 8 };
  let finishFirst;
  const sent = [];
  const sender = createColorSender((hex, request) => {
    sent.push([hex, request]);
    if (sent.length === 1) return new Promise((resolve) => { finishFirst = resolve; });
    return Promise.resolve(true);
  });
  sender.enqueue(state.currentHex, state.sampleRequest);
  sender.enqueue("#ff66aa", state.sampleRequest);
  const apply = (hex) => { state.currentHex = hex; };
  applyLocalPaletteColor("#ffeedd", state, apply, sender);
  applyLocalPaletteColor("#ffeedd", state, apply, sender);
  finishFirst(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [["#334455", 8], ["#ffeedd", 8]]);
  assert.equal(state.referenceHex, "#112233");
  assert.equal(state.currentHex, "#ffeedd");
});

function lumaState() {
  return {
    referenceHex: "#112233",
    currentHex: "#334455",
    currentSlot: 0,
  };
}

test("showPaletteAt state transition rejects an older sample but accepts the current generation", () => {
  const state = lumaState();
  const stale = applyPaletteShow(state, {
    r: 1, g: 2, b: 3, slot: 0, request: 8,
  }, 9);
  assert.equal(stale.stale, true);
  assert.equal(stale.currentHex, state.currentHex);
  assert.equal(stale.referenceHex, state.referenceHex);

  const current = applyPaletteShow(state, {
    r: 52, g: 86, b: 120, slot: 0, request: 9,
  }, 9);
  assert.equal(current.stale, false);
  assert.equal(current.sampleRequest, 9);
  assert.equal(current.currentHex, "#345678");
});

test("A then Luma B then CSP C makes C the reference and current selection on reopen", () => {
  const next = applyPaletteShow(lumaState(), {
    r: 52,
    g: 86,
    b: 120,
    slot: 0,
    afterEyedropper: false,
    request: 12,
  }, 11);

  assert.equal(next.accepted, true);
  assert.equal(next.currentHex, "#345678");
  assert.equal(next.referenceHex, "#345678");
  assert.equal(next.currentSlot, 0);
});

test("same-color reopen preserves A, while explicit same-color eyedrop refreshes the reference", () => {
  const state = lumaState();
  const sample = { r: 51, g: 68, b: 85, slot: 0 };

  const reopened = applyPaletteShow(state, {
    ...sample, afterEyedropper: false, request: 4,
  }, 4);
  assert.equal(reopened.currentHex, "#334455");
  assert.equal(reopened.referenceHex, "#112233");
  assert.equal(reopened.referenceUpdated, false);

  const freshlyPicked = applyPaletteShow(state, {
    ...sample, afterEyedropper: true, request: 5,
  }, 5);
  assert.equal(freshlyPicked.currentHex, "#334455");
  assert.equal(freshlyPicked.referenceHex, "#334455");
  assert.equal(freshlyPicked.referenceUpdated, true);
});

test("a failed CSP read leaves prior colors untouched and never returns a cached success", () => {
  const state = lumaState();
  const next = applyPaletteShow(state, {
    r: null,
    g: null,
    b: null,
    slot: 0,
    afterEyedropper: false,
    request: 6,
  }, 5);

  assert.equal(next.accepted, false);
  assert.equal(next.stale, false);
  assert.equal(next.sampleRequest, 6);
  assert.equal(next.currentHex, state.currentHex);
  assert.equal(next.referenceHex, state.referenceHex);
  assert.equal(next.currentSlot, state.currentSlot);
});

test("old color-update generations are rejected and newer reads are accepted during a send", () => {
  assert.equal(shouldApplyColorUpdate(8, 7, false), false);
  assert.equal(shouldApplyColorUpdate(8, 8, true), false);
  assert.equal(shouldApplyColorUpdate(8, 8, false), true);
  assert.equal(shouldApplyColorUpdate(8, 9, true), true);

  const refreshed = applyColorUpdate(lumaState(), {
    r: 52,
    g: 86,
    b: 120,
    slot: 0,
  });
  assert.equal(refreshed.currentHex, "#345678");
  assert.equal(refreshed.referenceHex, "#345678");
});

test("a successful fresh color-update refreshes the reference even for the same current RGB", () => {
  const refreshed = applyColorUpdate(lumaState(), {
    r: 51,
    g: 68,
    b: 85,
    slot: 0,
  });

  assert.equal(refreshed.currentHex, "#334455");
  assert.equal(refreshed.referenceHex, "#334455");
  assert.equal(refreshed.referenceUpdated, true);
});

test("a sample arriving during an older color send remains authoritative", async () => {
  let latestRequest = 4;
  let releaseSend;
  let startedSend;
  const started = new Promise((resolve) => { startedSend = resolve; });
  const sender = createColorSender(async (_color, request) => {
    startedSend();
    await new Promise((resolve) => { releaseSend = resolve; });
    return request === latestRequest;
  }, { interval: 0 });

  sender.enqueue("#334455", 4);
  await started;
  latestRequest = 5;
  sender.discardPending();

  const sampled = applyPaletteShow(lumaState(), {
    r: 52,
    g: 86,
    b: 120,
    slot: 0,
    afterEyedropper: true,
    request: 5,
  }, 5);
  releaseSend();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(sender.lastOutcome, "discarded");
  assert.equal(sampled.currentHex, "#345678");
  assert.equal(sampled.referenceHex, "#345678");
});
