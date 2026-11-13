export const modes = ["oklch", "hsv", "hsl", "lab", "plane", "circle"];

export const HUE_SHORTCUT_STEP_DEGREES = 2;
export const HUE_SHORTCUT_REPEAT_INTERVAL_MS = 80;
export const LIGHTNESS_SHORTCUT_STEP = 0.01;
export const CHROMA_SHORTCUT_STEP = 0.025;

export function hueDeltaForAction(action, step = HUE_SHORTCUT_STEP_DEGREES) {
  if (action === "hue_next") return step;
  if (action === "hue_prev") return -step;
  return null;
}

export function lightnessDeltaForAction(action, step = LIGHTNESS_SHORTCUT_STEP) {
  if (action === "light_up") return step;
  if (action === "light_down") return -step;
  return null;
}

export function chromaDeltaForAction(action, step = CHROMA_SHORTCUT_STEP) {
  if (action === "chroma_up") return step;
  if (action === "chroma_down") return -step;
  return null;
}

export function createShortcutRepeatGate({
  intervalMs = HUE_SHORTCUT_REPEAT_INTERVAL_MS,
  now = () => performance.now(),
} = {}) {
  const lastAccepted = new Map();
  return (action, event) => {
    const time = now();
    if (!event.repeat) {
      lastAccepted.set(action, time);
      return true;
    }

    const previous = lastAccepted.get(action);
    if (previous !== undefined && time - previous < intervalMs) return false;
    lastAccepted.set(action, time);
    return true;
  };
}

export function nextPaletteMode(current, enabled = modes) {
  const start = modes.indexOf(current);
  for (let step = 1; step <= modes.length; step++) {
    const mode = modes[(start + step) % modes.length];
    if (enabled.includes(mode)) return mode;
  }
  return current;
}

export function accelFromEvent(e) {
  if (e.isComposing || e.key === "Process" || e.getModifierState?.("AltGraph")) return null;
  const parts = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  if (e.metaKey) parts.push("Super");

  let key = e.key;
  if (["Control", "Shift", "Alt", "Meta", "Dead", "Unidentified"].includes(key)) return null;
  // Shift+digit reports punctuation, but Windows' shortcut hook sees the digit.
  if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(-1);
  if (key === " ") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();
  return [...parts, key].join("+");
}

export function createShortcutCapture(allowBareAlt) {
  let bareAlt = false;
  return (event) => {
    if (event.type === "keyup") {
      if (event.key !== "Alt") return null;
      const shortcut = bareAlt ? "Alt" : null;
      bareAlt = false;
      return shortcut;
    }
    if (event.repeat) return null;
    bareAlt = allowBareAlt && event.key === "Alt" &&
      !event.ctrlKey && !event.shiftKey && !event.metaKey && !event.isComposing;
    return accelFromEvent(event);
  };
}
