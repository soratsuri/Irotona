import test from "node:test";
import assert from "node:assert/strict";
import { bindColorStepInput } from "../src/color-step-input.js";

class Input extends EventTarget {
  value = "2.5";
  defaultValue = "2.5";
  min = "0.5";
  max = "10";
  attributes = new Map();

  get valueAsNumber() { return this.value === "" ? NaN : Number(this.value); }
  setAttribute(key, value) { this.attributes.set(key, value); }
  removeAttribute(key) { this.attributes.delete(key); }
}

function controls(save) {
  const range = new Input();
  const number = new Input();
  const reset = new EventTarget();
  const writes = [];
  let error;
  const render = bindColorStepInput({
    range, number, reset, scale: 100,
    save: (value) => { writes.push(value); return save?.(value); },
    reportError: (message) => { error = message; },
  });
  return { range, number, reset, writes, render, error: () => error };
}

const event = (target, type) => target.dispatchEvent(new Event(type));
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("slider and number preview each other and persist only committed edits", async () => {
  const { range, number, reset, writes, render } = controls();
  render(0.035);
  assert.equal(range.value, "3.5");
  assert.equal(number.value, "3.5");
  for (const value of ["4", "5.5", "6.75"]) {
    range.value = value;
    event(range, "input");
    assert.equal(number.value, value);
  }
  await flush();
  assert.deepEqual(writes, []);
  event(range, "change");
  event(range, "blur");
  number.value = "8.25";
  event(number, "input");
  assert.equal(range.value, "8.25");
  event(number, "change");
  await flush();
  assert.deepEqual(writes, [0.0675, 0.0825]);
  event(reset, "click");
  await flush();
  assert.equal(range.value, "2.5");
  assert.equal(number.value, "2.5");
  assert.deepEqual(writes, [0.0675, 0.0825, 0.025]);
});

test("invalid edits revert and never reach persistence", async () => {
  const { range, number, writes, error } = controls();
  for (const value of ["", "NaN", "Infinity", "0.49", "10.01"]) {
    number.value = value;
    event(number, "input");
    assert.equal(number.attributes.get("aria-invalid"), "true");
    event(number, "blur");
    assert.equal(number.value, "2.5");
    assert.equal(range.value, "2.5");
    assert.equal(error(), "color_step_invalid");
  }
  await flush();
  assert.deepEqual(writes, []);
});

test("a failed save restores the previous value", async () => {
  const { range, number, error } = controls(() => { throw new Error("write failed"); });
  range.value = "5";
  event(range, "input");
  event(range, "change");
  await flush();
  assert.equal(number.value, "2.5");
  assert.match(String(error()), /write failed/);
});
