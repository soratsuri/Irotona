// A drag previews values locally. A committed edit goes through the settings store.
export function bindColorStepInput({ range, number, reset, scale, save, reportError }) {
  const initial = Number(number.defaultValue);
  let saved = initial;
  let editing = false;
  let pending = 0;
  let queue = Promise.resolve();

  function show(value) {
    range.value = number.value = String(value);
    number.removeAttribute("aria-invalid");
  }

  function commit(input) {
    if (!editing) return;
    editing = false;
    const value = input.valueAsNumber;
    if (!Number.isFinite(value) || value < Number(number.min) || value > Number(number.max)) {
      show(saved);
      reportError("color_step_invalid");
      return;
    }
    saveValue(value);
  }

  function saveValue(value) {
    show(value);
    reportError(null);
    pending++;
    queue = queue.then(async () => {
      try {
        if (value !== saved) await save(value / scale);
        saved = value;
      } catch (error) {
        reportError(error);
      } finally {
        pending--;
        if (!editing && pending === 0) show(saved);
      }
    });
    return queue;
  }

  range.addEventListener("input", () => {
    editing = true;
    show(range.value);
  });
  number.addEventListener("input", () => {
    editing = true;
    const value = number.valueAsNumber;
    if (Number.isFinite(value) && value >= Number(number.min) && value <= Number(number.max)) {
      range.value = number.value;
      number.removeAttribute("aria-invalid");
    } else {
      number.setAttribute("aria-invalid", "true");
    }
  });
  for (const input of [range, number]) {
    input.addEventListener("change", () => commit(input));
    input.addEventListener("blur", () => commit(input));
  }
  number.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      commit(number);
    }
  });
  reset.addEventListener("click", () => {
    editing = false;
    saveValue(initial);
  });

  return (stored) => {
    if (editing || pending) return;
    saved = Number.isFinite(stored) ? Number((stored * scale).toPrecision(15)) : initial;
    show(saved);
  };
}
