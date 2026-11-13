import { rgbToHex } from "./oklch.js";

function validRgb({ r, g, b }) {
  return [r, g, b].every((value) =>
    Number.isInteger(value) && value >= 0 && value <= 255
  );
}

// A same-color reopen keeps the previous reference. Only an eyedropper gesture,
// a changed CSP color/slot, or an uninitialized palette establishes a new base.
export function applyPaletteSample(state, sample) {
  if (!validRgb(sample)) return { accepted: false, ...state };

  const hex = rgbToHex(sample.r / 255, sample.g / 255, sample.b / 255);
  const slotChanged = sample.slot != null && sample.slot !== state.currentSlot;
  const referenceUpdated =
    state.referenceHex == null ||
    sample.afterEyedropper === true ||
    slotChanged ||
    hex !== state.currentHex;

  return {
    accepted: true,
    currentHex: hex,
    referenceHex: referenceUpdated ? hex : state.referenceHex,
    currentSlot: sample.slot ?? state.currentSlot,
    referenceUpdated,
  };
}

// This is the state transition used by showPaletteAt: stale show events may
// still display the window, but must not apply their sampled color.
export function applyPaletteShow(state, payload, currentRequest) {
  if (!isCurrentOrNewerSample(currentRequest, payload.request)) {
    return {
      accepted: false,
      stale: true,
      sampleRequest: currentRequest,
      ...state,
    };
  }
  const sample = applyPaletteSample(state, payload);
  return {
    ...sample,
    stale: false,
    sampleRequest:
      Number.isSafeInteger(payload.request) && payload.request >= 0
        ? payload.request
        : currentRequest,
  };
}

export function applyColorUpdate(state, update) {
  if (!validRgb(update)) return { accepted: false, ...state };

  const hex = rgbToHex(update.r / 255, update.g / 255, update.b / 255);

  return {
    accepted: true,
    currentHex: hex,
    // color-update is emitted only after a successful fresh CSP read. That
    // read is authoritative even when its RGB happens to equal currentHex.
    referenceHex: hex,
    currentSlot: update.slot ?? state.currentSlot,
    referenceUpdated: true,
  };
}

export function applyPassiveColorSample(state, update, request, superseded) {
  if (!update || superseded || update.sample_request !== request) {
    return { accepted: false, ...state };
  }
  const sample = applyPaletteSample(state, update);
  // The current color includes the last local edit. An identical read in
  // the same slot is its echo, even if the sampled reference is different.
  if (sample.currentHex === state.currentHex && sample.currentSlot === state.currentSlot) {
    return { accepted: false, ...state };
  }
  return sample;
}

// A newer read is authoritative even while an older local write is in flight.
// Same-generation duplicates are ignored while dragging; older generations
// are always rejected.
export function shouldApplyColorUpdate(currentRequest, request, senderBusy) {
  if (!Number.isSafeInteger(request) || request < 0) return !senderBusy;
  if (request < currentRequest) return false;
  if (request > currentRequest) return true;
  return !senderBusy;
}
export function isCurrentOrNewerSample(currentRequest, request) {
  return !Number.isSafeInteger(request) || request >= currentRequest;
}

export function applyLocalPaletteColor(hex, { currentHex, sampleRequest }, applyColor, sender) {
  applyColor(hex);
  if (hex === currentHex) return;
  sender.discardPending();
  sender.enqueue(hex, sampleRequest);
  sender.flush();
}
