// Keep at most one IPC call and one pending color. Commit can skip the
// rate-limit timer, while still waiting for an in-flight command to finish.
export function createColorSender(send, { interval = 45, onError = console.warn } = {}) {
  let pending = null;
  let active = false;
  let timer = null;
  let lastStart = -Infinity;
  let urgent = false;
  let revision = 0;
  let lastOutcome = "idle";

  function schedule() {
    if (active || timer !== null || pending === null) return;
    const delay = urgent ? 0 : interval - (performance.now() - lastStart);
    if (delay > 0) {
      timer = setTimeout(() => {
        timer = null;
        schedule();
      }, delay);
    } else {
      void deliver();
    }
  }

  async function deliver() {
    const update = pending;
    pending = null;
    urgent = false;
    active = true;
    lastStart = performance.now();
    try {
      const result = await send(update.color, update.context, update.metadata);
      lastOutcome = result === false ? "discarded" : "sent";
    } catch (error) {
      const superseded = revision !== update.revision;
      lastOutcome = superseded ? "discarded" : "failed";
      if (!superseded && pending === null) onError(error);
    } finally {
      active = false;
      schedule();
    }
  }

  return {
    enqueue(color, context, metadata = undefined) {
      pending = { color, context, metadata, revision };
      schedule();
    },
    discardPending() {
      const hadPending = pending !== null;
      revision += 1;
      pending = null;
      if (hadPending) lastOutcome = "discarded";
      urgent = false;
      clearTimeout(timer);
      timer = null;
    },
    flush() {
      if (pending === null) return;
      urgent = true;
      clearTimeout(timer);
      timer = null;
      schedule();
    },
    get busy() { return active || pending !== null; },
    get lastOutcome() { return lastOutcome; },
  };
}

export function bindColorPointer(canvas, select, {
  observe = () => {},
  begin = () => true,
  commit = () => {},
  requestFrame = requestAnimationFrame,
  cancelFrame = cancelAnimationFrame,
} = {}) {
  let captured = null;
  let frame = null;
  let position;

  function coordinates({ clientX, clientY }) {
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    return [
      (clientX - bounds.left) * canvas.width / bounds.width,
      (clientY - bounds.top) * canvas.height / bounds.height,
    ];
  }

  function flush() {
    if (frame === null) return;
    cancelFrame(frame);
    frame = null;
    const point = coordinates(position);
    if (point) select(...point);
  }

  function update({ clientX, clientY }) {
    position = { clientX, clientY };
    frame ??= requestFrame(flush);
  }

  function finish({ discard = false } = {}) {
    if (captured === null) return;
    const id = captured;
    captured = null;
    if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    if (discard) {
      if (frame !== null) cancelFrame(frame);
      frame = null;
      return;
    }
    flush();
    commit();
  }

  canvas.addEventListener("pointerdown", (event) => {
    observe(event);
    if (captured !== null || event.isPrimary === false || event.button !== 0 ||
        !(event.buttons & 1)) return;
    const point = coordinates(event);
    if (!point || !begin(...point)) return;
    canvas.setPointerCapture(event.pointerId);
    captured = event.pointerId;
    update(event);
    flush();
  });
  canvas.addEventListener("pointerenter", observe);
  canvas.addEventListener("pointermove", (event) => {
    observe(event);
    if (captured !== event.pointerId) return;
    // A missing primary button can occur when buttons are chorded or a
    // driver resumes movement without reporting the release first.
    if (!(event.buttons & 1)) finish();
    else update(event);
  });
  canvas.addEventListener("pointerup", (event) => {
    observe(event);
    if (captured !== event.pointerId) return;
    if (event.button === 0) update(event);
    finish();
  });
  for (const type of ["pointercancel", "lostpointercapture"]) {
    canvas.addEventListener(type, (event) => {
      if (captured === event.pointerId) finish();
    });
  }
  finish.isActive = () => captured !== null;
  return finish;
}
