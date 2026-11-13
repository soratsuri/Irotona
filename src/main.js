import { bindColorPointer, createColorSender } from "./color-input.js";
import { accelFromEvent, chromaDeltaForAction, createShortcutRepeatGate, hueDeltaForAction, lightnessDeltaForAction, modes, nextPaletteMode } from "./shortcuts.js";
import { translate, qrMessage } from "./messages.js";
import { createWheel, WHEEL_RADIUS } from "./wheel.js";
import { ColorCircle } from "./color-circle.js";
import { SliderRenderer } from "./slider.js";
import { updateInfoBar } from "./ui.js";
import { hexToRgb, rgbToHex } from "./oklch.js";
import { clampWindowAxis, measurePaletteLogicalSize } from "./palette-layout.js";
import { applyColorUpdate, applyLocalPaletteColor, applyPaletteShow, applyPassiveColorSample, shouldApplyColorUpdate } from "./palette-color-state.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow, LogicalSize, PhysicalPosition } = window.__TAURI__.window;
const { availableMonitors } = window.__TAURI__.window;

const wheelCanvas = document.getElementById("wheel");
const markerCanvas = document.getElementById("wheel-marker");
const wheelStack = wheelCanvas.closest(".wheel-stack");
let wheel = createWheel(wheelCanvas, "oklch", markerCanvas);
const slider = new SliderRenderer(document.getElementById("slider"));
const info = document.getElementById("info");
const gamutBtn = document.getElementById("gamut-btn");
const planeViewControl = document.getElementById("plane-view");
const focusedButton = document.getElementById("plane-focused");
const fullButton = document.getElementById("plane-full");
const planeComparison = document.getElementById("plane-comparison");
const restoreSampledColor = document.getElementById("restore-sampled-color");
const paletteFooter = document.querySelector(".palette-footer");
const colorSlotsGroup = document.getElementById("color-slots");
const slotButtons = [...colorSlotsGroup.querySelectorAll("button")];
const slotColors = slotButtons.map(() => null);
const cyclePaletteButton = document.getElementById("cycle-palette");
const paletteContainer = document.querySelector(".container");
const topbar = document.querySelector(".topbar");
const pinButton = document.getElementById("palette-pin");
const circleButton = document.getElementById("circle-model");
const sliderStack = document.querySelector(".slider-stack");

let currentHex = "#808080";
let referenceHex = null;
let slotBaseHex = null;
let currentL = wheel.rgbToAxis(...hexToRgb(currentHex));
let currentWheelType = "oklch";
let planeView = "focused";
let circleModel = "hsv";
let circleHue = 0;
let paletteShortcuts = {};
let summonShortcut = "";
let localSummonKey = null;
let latestVisibilityRequest = 0;
let paletteVisibility = Promise.resolve();
let colorSteps = {};
let cycleModes = modes;
let paletteOffset = "bottom-right";
let language = "ja";
let currentSlot = 0; // 0 = main, 1 = sub
let sampleRequest = 0;
let infoMode = { kind: "status", key: "waitingCsp" };
let gamutWarning = false;
let pinned = false;
let pinnedPosition = null;
let moveTimer;
let sliderFrame = null;
let connected = false;
let passiveTimer = null;
let passiveInFlight = false;
let passiveSyncActive = false;
let colorRevision = 0;
let lastCircleSent = null;
let lastPassiveUiDiagnostic = 0;

const EDGE_GAP = 30;
const colorSender = createColorSender(
  (hex, request, metadata = {}) => {
    const args = { hex, sampleRequest: request };
    if (Number.isFinite(metadata.preservedHue)) args.preservedHue = metadata.preservedHue;
    return invoke("set_csp_color", args);
  },
  { onError: (error) => {
    console.warn("set_csp_color:", error);
    if (infoMode.kind === "color") setPaletteStatus("sendFailed");
  } },
);

function setColor(hex, { sync = true, markerAt = null } = {}) {
  colorRevision++;
  currentHex = hex;
  if (currentWheelType === "circle") {
    if (sync) wheel.setCurrentColor(hex);
    wheel.render();
  } else {
    wheel.setCurrentColor(hex, markerAt);
  }
  infoMode = { kind: "color" };
  refreshPaletteInfo();
  if (sync && currentWheelType !== "circle") {
    const [r, g, b] = hexToRgb(hex);
    currentL = wheel.rgbToAxis(r, g, b);
    renderSlider();
  }
}

function setPaletteStatus(key) {
  infoMode = { kind: "status", key };
  refreshPaletteInfo();
}

function refreshPaletteInfo() {
  if (currentWheelType === "plane") updatePlaneComparison();
  if (showPointerInfo) {
    info.textContent = lastPointer;
  } else if (infoMode.kind === "color") {
    updateInfoBar(info, currentHex, currentSlot, language);
  } else {
    info.textContent = translate(language, infoMode.key);
  }
  info.title = info.textContent;
}

function updatePlaneComparison() {
  const visible = currentWheelType === "plane";
  planeComparison.hidden = !visible;
  if (!visible) return;
  planeComparison.style.setProperty("--reference-color", referenceHex ?? currentHex);
  planeComparison.style.setProperty("--current-color", currentHex);
  const label = translate(language, "planeComparison");
  planeComparison.title = label;
  planeComparison.setAttribute("aria-label", label);
  const restoreLabel = translate(language, "restoreSampledColor");
  restoreSampledColor.title = restoreLabel;
  restoreSampledColor.setAttribute("aria-label", restoreLabel);
  restoreSampledColor.disabled = referenceHex == null;
}

function wheelSupportsGamutWarning() {
  return currentWheelType === "oklch" || currentWheelType === "lab";
}

function updateGamutButton() {
  const supported = wheelSupportsGamutWarning();
  gamutBtn.disabled = !supported;
  gamutBtn.classList.toggle("active", supported && gamutWarning);
  gamutBtn.title = translate(language, supported ? "gamutToggle" : "gamutInside");
  diagnosticBtn.title = translate(language, "pointerInfo");
  const plane = currentWheelType === "plane";
  planeViewControl.hidden = !plane;
  planeViewControl.setAttribute("aria-label", translate(language, "planeSwitch"));
  focusedButton.textContent = translate(language, "planeFocused");
  focusedButton.setAttribute("aria-pressed", String(!isFullPlane()));
  fullButton.textContent = translate(language, "planeFull");
  fullButton.setAttribute("aria-pressed", String(isFullPlane()));
  const axisLabel = plane ? (isFullPlane() ? "planeChroma" : "planeLightness") : "axis";
  slider.canvas.title = translate(language, axisLabel);
  slider.canvas.setAttribute("aria-label", slider.canvas.title);
  circleButton.hidden = currentWheelType !== "circle";
  circleButton.textContent = circleModel.toUpperCase();
  circleButton.title = circleButton.textContent + " · " + translate(language, "circleModel");
  circleButton.setAttribute("aria-label", circleButton.title);
  updatePinButton();
}

function updatePinButton() {
  const label = translate(language, pinned ? "unpin" : "pin");
  pinButton.setAttribute("aria-pressed", String(pinned));
  pinButton.setAttribute("aria-label", label);
  pinButton.title = label;
}

function isFullPlane() {
  return currentWheelType === "plane" && planeView === "full";
}

function isBrushPlane() {
  return currentWheelType === "plane" && planeView === "focused";
}

function axisRange() {
  return wheel.selectedAxisRange?.(currentL) ?? wheel.axisRange?.() ?? [0, 1];
}

function renderSlider() {
  if (sliderFrame !== null) {
    cancelAnimationFrame(sliderFrame);
    sliderFrame = null;
  }
  if (currentWheelType === "circle") return;
  const [low, high] = axisRange();
  slider.setRange(low, high, isBrushPlane() ? currentHex : null);
  slider.render(currentL);
}

function applyGamutWarningState() {
  updateGamutButton();
  const supported = wheelSupportsGamutWarning();
  wheel.setGamutWarning?.(supported && gamutWarning);
}

function renderWheel() {
  wheel.setGamutWarning?.(wheelSupportsGamutWarning() && gamutWarning, false);
  wheel.render(currentL);
  updateGamutButton();
}

function swapWheel(type, rebuild = false) {
  if (!modes.includes(type) || (!rebuild && type === currentWheelType)) return;
  flushColor();
  if (currentWheelType === "circle") circleHue = wheel.hue;
  currentWheelType = type;
  paletteContainer.classList.toggle("plane", type === "plane");
  paletteContainer.classList.toggle("circle", type === "circle");
  sliderStack.hidden = type === "circle";
  document.body.classList.toggle("ab-brush", isBrushPlane());
  wheelCanvas.style.clipPath = "";
  if (type === "circle") {
    wheel = new ColorCircle(wheelCanvas, markerCanvas, circleModel);
    wheel.hue = circleHue;
  } else {
    wheel = createWheel(wheelCanvas, type, markerCanvas, planeView);
  }
  wheel.setReferenceColor?.(slotBaseHex ?? referenceHex ?? currentHex);
  if (type !== "circle") currentL = wheel.rgbToAxis(...hexToRgb(currentHex));
  updatePlaneComparison();
  slider.setHeight(isBrushPlane() ? wheelCanvas.width : wheelCanvas.height);
  resizeKey = null;
  wheel.setCurrentColor(currentHex);
  renderWheel();
  renderSlider();
  resizeVisiblePalette().catch(console.warn);
}

function applyCircleModel(value) {
  const model = value === "hls" ? "hls" : "hsv";
  if (model === circleModel) return;
  circleModel = model;
  if (currentWheelType !== "circle") return;
  flushColor();
  wheel.model = model;
  wheel.setCurrentColor(currentHex);
  renderWheel();
}

function applyPlaneOptions(settings) {
  wheelStack.dataset.background = settings.plane_background ?? "plain";
  wheelStack.dataset.shadow = String(settings.plane_shadow === true);
  const nextView = settings.plane_view === "full" ? "full" : "focused";
  const nextSize = ["small", "large"].includes(settings.plane_size) ? settings.plane_size : "medium";
  const viewChanged = planeView !== nextView;
  const sizeChanged = paletteContainer.dataset.planeSize !== nextSize;
  planeView = nextView;
  paletteContainer.dataset.planeSize = nextSize;
  if (currentWheelType === "plane" && viewChanged) swapWheel("plane", true);
  else if (sizeChanged) resizeVisiblePalette().catch(console.warn);
}

function setLightness(L) {
  currentL = L;
  const selectedPoint = wheel.pointAtAxis?.(L) ?? wheel.getSelectedPoint();
  const hex = wheel.colorAtAxis(L);
  setColor(hex, { sync: false, markerAt: selectedPoint });
  renderWheel();
  renderSlider();
  return hex;
}

function applyCspSample({ r, g, b, slot, after_eyedropper: afterEyedropper, sample_request: request }, pinnedOnly = false) {
  // A later successful read may reach the UI before this show event. Still show
  // the palette, but keep the newer color state and generation.
  const sample = applyPaletteShow(
    { currentHex, referenceHex, currentSlot },
    { r, g, b, slot, afterEyedropper, request },
    sampleRequest,
  );
  if (!sample.stale) {
    sampleRequest = sample.sampleRequest;
    // Supersede queued drag colors from the previous session. A write already
    // waiting for the Rust connection lock is rejected by its generation check.
    colorSender.discardPending();
    if (sample.accepted && (!pinnedOnly || pinned)) {
      finishWheel({ discard: true });
      finishSlider({ discard: true });
      displayCspColor(sample);
    } else if (!pinnedOnly) {
      setPaletteStatus(slot == null ? "disconnected" : "sampleFailed");
    }
  }
}

function displayCspColor(sample) {
  lastCircleSent = null;
  currentSlot = sample.currentSlot;
  referenceHex = sample.referenceHex;
  if (sample.referenceUpdated) slotBaseHex = null;
  wheel.setReferenceColor?.(slotBaseHex ?? referenceHex);
  setColor(sample.currentHex);
  renderWheel();
}

function editingColor() {
  return colorSender.busy || finishWheel.isActive() || finishSlider.isActive();
}

function schedulePassiveSync() {
  clearTimeout(passiveTimer);
  if (!pinned || !connected) {
    passiveSyncActive = false;
    return;
  }
  passiveSyncActive = true;
  if (passiveInFlight) return;
  passiveTimer = setTimeout(async () => {
    passiveInFlight = true;
    try {
      if (!passiveSyncActive || !pinned || !connected ||
          !(await getCurrentWindow().isVisible())) return;
      if (editingColor()) return;
      const revision = colorRevision;
      const update = await invoke("poll_csp_color", { sampleRequest });
      const sample = applyPassiveColorSample(
        { currentHex, referenceHex, currentSlot }, update, sampleRequest,
        revision !== colorRevision || !pinned || !connected || editingColor(),
      );
      if (sample.accepted) displayCspColor(sample);
      else reportPassiveUiDiagnostic(update === null
        ? "CSP returned no fresh passive color"
        : "passive color result was stale, unchanged, or superseded by local input");
    } catch (error) {
      console.warn("poll_csp_color:", error);
    } finally {
      passiveInFlight = false;
      if (passiveSyncActive && pinned && connected) {
        try {
          if (await getCurrentWindow().isVisible()) schedulePassiveSync();
          else passiveSyncActive = false;
        } catch (error) {
          passiveSyncActive = false;
          console.warn("palette visibility:", error);
        }
      }
    }
  }, 450);
}

function reportPassiveUiDiagnostic(message) {
  const now = Date.now();
  if (now - lastPassiveUiDiagnostic < 60_000) return;
  lastPassiveUiDiagnostic = now;
  console.debug("[CSP color sync]", message);
}

async function showPaletteAt(payload) {
  applyCspSample(payload);
  const { x, y } = payload;
  const win = getCurrentWindow();
  if (pinned) {
    if (!(await win.isVisible())) await restorePinnedPalette([x, y]);
    schedulePassiveSync();
    return;
  }
  const monitor = await monitorForPoint(x, y);
  await placePalette(win, { x, y, monitor });
  await win.show();
  await win.setFocus();
}

function queuePaletteVisibility(request, apply) {
  if (request < latestVisibilityRequest) return;
  latestVisibilityRequest = request;
  paletteVisibility = paletteVisibility.then(async () => {
    if (request !== latestVisibilityRequest) return;
    try {
      await apply();
    } finally {
      await invoke("finish_palette_summon", { request });
    }
  }).catch(console.warn);
}

async function placePalette(win, { x, y, monitor, fixed = false }) {
  const logicalSize = paletteSize();
  const scaleFactor = monitor?.scaleFactor || window.devicePixelRatio || 1;
  wheel.resizeMarker?.(scaleFactor);
  const targetSize = logicalSize.toPhysical(scaleFactor);
  const pw = targetSize.width;
  const ph = targetSize.height;
  const bounds = monitorBounds(monitor);

  let wx = x, wy = y;
  if (!fixed) switch (paletteOffset) {
    case "bottom-left":
      wx = x - pw - EDGE_GAP; wy = y + EDGE_GAP; break;
    case "top-right":
      wx = x + EDGE_GAP; wy = y - ph - EDGE_GAP; break;
    case "top-left":
      wx = x - pw - EDGE_GAP; wy = y - ph - EDGE_GAP; break;
    case "center":
      wx = x - Math.round(pw / 2); wy = y - Math.round(ph / 2); break;
    case "bottom-right":
    default:
      wx = x + EDGE_GAP; wy = y + EDGE_GAP; break;
  }

  // Flip to the opposite side if we'd spill off the monitor the cursor is on.
  if (!fixed) {
    if (wx + pw > bounds.right) wx = x - pw - EDGE_GAP;
    if (wx < bounds.left) wx = x + EDGE_GAP;
    if (wy + ph > bounds.bottom) wy = y - ph - EDGE_GAP;
    if (wy < bounds.top) wy = y + EDGE_GAP;
  }

  wx = clampWindowAxis(wx, pw, bounds.left, bounds.right);
  wy = clampWindowAxis(wy, ph, bounds.top, bounds.bottom);

  const current = await win.outerPosition();
  if (wx !== current.x || wy !== current.y) {
    await win.setPosition(new PhysicalPosition(wx, wy));
  }
  const key = `${logicalSize.width}:${logicalSize.height}:${scaleFactor}`;
  if (resizeKey !== key) {
    await win.setSize(logicalSize);
    resizeKey = key;
  }
}

let resizeKey = null;
async function restorePinnedPalette(fallback) {
  const win = getCurrentWindow();
  const [x, y] = pinnedPosition ?? fallback;
  await placePalette(win, { x, y, monitor: await monitorForPoint(x, y), fixed: !!pinnedPosition });
  await win.show();
  await invoke("set_palette_pin");
}

async function resizeVisiblePalette() {
  const win = getCurrentWindow();
  if (!(await win.isVisible())) return;
  const { x, y } = await win.outerPosition();
  await placePalette(win, { x, y, monitor: await monitorForPoint(x, y), fixed: true });
}

async function setPinned(enabled) {
  await invoke("set_palette_pin", { pinned: enabled });
  pinned = enabled;
  updatePinButton();
  // A focus transition during the button press can race the unpinned blur
  // handler. Keep the user's explicit pin action visible in that case.
  const win = getCurrentWindow();
  if (enabled && !(await win.isVisible())) await win.show();
  colorRevision++;
  schedulePassiveSync();
}

function paletteSize() {
  const measured = measurePaletteLogicalSize(
    topbar,
    paletteContainer,
    currentWheelType === "plane",
  );
  return new LogicalSize(measured.width, measured.height);
}

async function hidePalette() {
  flushColor();
  if (pinned) await setPinned(false);
  await getCurrentWindow().hide();
}

function schedulePinnedPositionSave() {
  clearTimeout(moveTimer);
  if (!pinned) return;
  moveTimer = setTimeout(async () => {
    try {
      if (pinned) await invoke("set_palette_pin");
    } catch (error) {
      console.warn(error);
    }
  }, 250);
}

async function monitorForPoint(x, y) {
  try {
    const monitors = await availableMonitors();
    const containing = monitors.find((monitor) => {
      const bounds = monitorBounds(monitor);
      return x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom;
    });
    if (containing) return containing;

    return monitors
      .map((monitor) => ({ monitor, distance: distanceToMonitor(monitor, x, y) }))
      .sort((a, b) => a.distance - b.distance)[0]?.monitor || null;
  } catch (e) {
    console.warn("availableMonitors:", e);
    return null;
  }
}

function monitorBounds(monitor) {
  const area = monitor?.workArea || monitor;
  const hasFlatRect =
    Number.isFinite(area?.x) &&
    Number.isFinite(area?.y) &&
    Number.isFinite(area?.width) &&
    Number.isFinite(area?.height);
  const position = hasFlatRect ? { x: area.x, y: area.y } : (area?.position || { x: 0, y: 0 });
  const size = hasFlatRect
    ? { width: area.width, height: area.height }
    : (area?.size || { width: 1920, height: 1080 });
  return {
    left: position.x,
    top: position.y,
    right: position.x + size.width,
    bottom: position.y + size.height,
  };
}

function distanceToMonitor(monitor, x, y) {
  const bounds = monitorBounds(monitor);
  const cx = Math.max(bounds.left, Math.min(x, bounds.right));
  const cy = Math.max(bounds.top, Math.min(y, bounds.bottom));
  return (x - cx) ** 2 + (y - cy) ** 2;
}

async function bootstrap() {
  renderWheel();
  renderSlider();
  setColor(currentHex, { sync: false });
  setPaletteStatus("waitingCsp");

  listen("connection-status", (evt) => {
    const { status } = evt.payload;
    connected = status === "connected";
    colorRevision++;
    schedulePassiveSync();
    if (status === "connected") {
      setPaletteStatus("connected");
      invoke("get_csp_color").catch(() => {});
    } else {
      setPaletteStatus("disconnected");
    }
  });

  listen("color-update", (evt) => {
    const { sample_request: request } = evt.payload;
    const update = applyColorUpdate(
      { currentHex, referenceHex, currentSlot },
      evt.payload,
    );
    if (!update.accepted ||
        !shouldApplyColorUpdate(sampleRequest, request, colorSender.busy)) return;

    if (request > sampleRequest) colorSender.discardPending();
    if (Number.isSafeInteger(request) && request >= 0) sampleRequest = request;
    displayCspColor(update);
  });

  listen("show-palette", (evt) => {
    queuePaletteVisibility(evt.payload.show_request, () => showPaletteAt(evt.payload));
  });
  listen("focus-pinned-palette", async (evt) => {
    if (!pinned) return;
    try {
      const win = getCurrentWindow();
      if (!(await win.isVisible())) await restorePinnedPalette(evt.payload);
      await win.setFocus();
    } catch (error) {
      console.warn(error);
    }
  });
  listen("pinned-color-sample", (evt) => applyCspSample(evt.payload, true));

  listen("qr-scan-status", (evt) => {
    const { scanning, message } = evt.payload;
    if (scanning) {
      setPaletteStatus("scanning");
    } else if (message === "already connected") {
      setPaletteStatus("connected");
    } else if (message) {
      setPaletteStatus(qrMessage(message));
    }
  });

  listen("wheel-type-changed", (evt) => {
    swapWheel(evt.payload);
  });

  listen("csp-process-status", (evt) => {
    if (!evt.payload) setPaletteStatus("waitingLaunch");
  });

  // Apply persisted settings from Rust side.
  try {
    const settings = await invoke("get_settings");
    if (settings) {
      applyLanguage(settings.language);
      paletteShortcuts = settings.palette_shortcuts || {};
      summonShortcut = settings.global_hotkey || "";
      colorSteps = settings.color_steps ?? {};
      cycleModes = settings.cycle_modes ?? modes;
      applyPlaneOptions(settings);
      applyCircleModel(settings.circle_model);
      if (settings.wheel_type) swapWheel(settings.wheel_type);
      if (settings.palette_offset) {
        paletteOffset = settings.palette_offset;
      }
      pinned = !!settings.palette_pinned;
      pinnedPosition = settings.pinned_position;
      updatePinButton();
      if (pinned) await restorePinnedPalette([0, 0]);
      schedulePassiveSync();
      setPaletteStatus("waitingCsp");
    }
  } catch (e) {
    console.warn("get_settings:", e);
  }

  listen("palette-offset-changed", (evt) => {
    paletteOffset = evt.payload;
  });

  listen("settings-changed", (evt) => {
    const settings = evt.payload || {};
    applyLanguage(settings.language);
    paletteShortcuts = settings.palette_shortcuts || {};
    summonShortcut = settings.global_hotkey || "";
    colorSteps = settings.color_steps ?? {};
    cycleModes = settings.cycle_modes ?? modes;
    if (settings.palette_offset) paletteOffset = settings.palette_offset;
    applyPlaneOptions(settings);
    applyCircleModel(settings.circle_model);
    applyGamutWarningState();
    refreshPaletteInfo();
  });

  listen("language-changed", (evt) => {
    applyLanguage(evt.payload);
    applyGamutWarningState();
    refreshPaletteInfo();
  });

  listen("hide-palette", (evt) => queuePaletteVisibility(evt.payload, hidePalette));
  const win = getCurrentWindow();
  win.onMoved(schedulePinnedPositionSave).catch(console.warn);
  win.onScaleChanged(({ payload }) => wheel.resizeMarker?.(payload.scaleFactor)).catch(console.warn);

  try {
    const ok = await invoke("try_reconnect_session");
    if (!ok) {
      // If CSP isn't running yet, let the watcher drive the retry — don't
      // kick a scan (which would just log "skipped").
      setPaletteStatus("waitingLaunch");
      invoke("start_qr_scan").catch((e) => console.warn("start_qr_scan:", e));
    }
  } catch (e) {
    console.warn("try_reconnect_session:", e);
  }
}

// Clamp a (possibly outside-the-canvas) point to the wheel's rim so drags off
// the edge keep picking max-chroma colors at the pointed angle instead of
// freezing at the last on-canvas position.
function clampToWheel(x, y) {
  if (typeof wheel.clampPoint === "function") return wheel.clampPoint(x, y);
  const cx = WHEEL_RADIUS, cy = WHEEL_RADIUS;
  const dx = x - cx, dy = y - cy;
  const dist = Math.hypot(dx, dy);
  const maxR = WHEEL_RADIUS - 1.5;
  if (dist <= maxR) return [x, y];
  const k = maxR / dist;
  return [cx + dx * k, cy + dy * k];
}

function applyLanguage(value) {
  language = value || language;
  document.documentElement.lang = language === "zh-TW" ? "zh-Hant" : language;
  updateFooterLabels();
}

let showPointerInfo = false;
let lastPointer = "—";
const diagnosticBtn = document.getElementById("pointer-info");
diagnosticBtn.addEventListener("click", () => {
  showPointerInfo = !showPointerInfo;
  diagnosticBtn.setAttribute("aria-pressed", String(showPointerInfo));
  refreshPaletteInfo();
});

function observePointer(event) {
  lastPointer = `${event.pointerType || "?"} · buttons=${event.buttons} · p=${event.pressure.toFixed(2)}`;
  if (showPointerInfo) refreshPaletteInfo();
}

function selectPoint(x, y) {
  if (currentWheelType === "circle") {
    selectCircleColor(wheel.pickAt(x, y));
    return;
  }
  const point = clampToWheel(x, y);
  const hex = wheel.pickAt(...point);
  if (!hex) return;
  const changed = hex !== currentHex;
  setColor(hex, { sync: false, markerAt: point });
  if (isBrushPlane()) sliderFrame ??= requestAnimationFrame(renderSlider);
  if (changed) colorSender.enqueue(hex, sampleRequest);
}

function selectCircleColor(hex) {
  const changed = hex !== currentHex;
  setColor(hex, { sync: false });
  if (changed || lastCircleSent?.hue !== wheel.hue || lastCircleSent?.hex !== hex ||
      lastCircleSent?.slot !== currentSlot || lastCircleSent?.request !== sampleRequest) {
    lastCircleSent = { hex, hue: wheel.hue, slot: currentSlot, request: sampleRequest };
    colorSender.enqueue(hex, sampleRequest, { preservedHue: wheel.hue });
  }
}

function selectAxis(axis) {
  const [low, high] = axisRange();
  axis = Math.max(low, Math.min(high, axis));
  if (axis === currentL) return;
  const previous = currentHex;
  const hex = setLightness(axis);
  if (hex !== previous) colorSender.enqueue(hex, sampleRequest);
}

const finishWheel = bindColorPointer(wheelCanvas, selectPoint, {
  observe: observePointer,
  begin: (x, y) => currentWheelType !== "circle" || wheel.begin(x, y),
  commit: colorSender.flush,
});
const finishSlider = bindColorPointer(slider.canvas, (_, y) => {
  selectAxis(slider.pickL(y));
}, {
  commit: colorSender.flush,
});

function recallPaletteColor(hex, slotBase) {
  finishWheel({ discard: true });
  finishSlider({ discard: true });
  slotBaseHex = slotBase;
  wheel.setReferenceColor?.(slotBaseHex ?? referenceHex ?? hex);
  applyLocalPaletteColor(hex, { currentHex, sampleRequest }, (hex) => {
    setColor(hex);
    renderWheel();
  }, colorSender);
}

function restoreReferenceColor() {
  if (referenceHex != null && currentWheelType === "plane") recallPaletteColor(referenceHex, null);
}

restoreSampledColor.addEventListener("click", restoreReferenceColor);

function updateSlotButton(button, index) {
  const hex = slotColors[index];
  const slot = `${translate(language, "colorSlot")} ${index + 1}`;
  const action = translate(language, hex ? "colorSlotRecall" : "colorSlotSave");
  button.textContent = "";
  button.classList.toggle("is-filled", !!hex);
  if (hex) button.style.setProperty("--slot-color", hex);
  else button.style.removeProperty("--slot-color");
  button.setAttribute("aria-label", `${slot}${hex ? ` ${hex.toUpperCase()}` : ""} · ${action}`);
  button.title = button.getAttribute("aria-label");
}

function updateFooterLabels() {
  colorSlotsGroup.setAttribute("aria-label", translate(language, "colorSlots"));
  slotButtons.forEach(updateSlotButton);
  cyclePaletteButton.title = translate(language, "cyclePalette");
  cyclePaletteButton.setAttribute("aria-label", cyclePaletteButton.title);
}

slotButtons.forEach((button, index) => {
  button.addEventListener("click", (event) => {
    const hex = slotColors[index];
    if (hex && !event.shiftKey) {
      recallPaletteColor(hex, hex);
      return;
    }
    slotColors[index] = currentHex;
    updateSlotButton(button, index);
  });
  button.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    slotColors[index] = null;
    updateSlotButton(button, index);
  });
});
updateFooterLabels();
new ResizeObserver(() => wheel.resizeMarker?.(window.devicePixelRatio)).observe(wheelCanvas);
window.addEventListener("resize", () => wheel.resizeMarker?.(window.devicePixelRatio));
function flushColor() {
  finishWheel();
  finishSlider();
  colorSender.flush();
}

window.addEventListener("blur", flushColor);
window.addEventListener("blur", () => { localSummonKey = null; });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) flushColor();
  colorRevision++;
  schedulePassiveSync();
});

function adjustPoint(hueDelta, saturationDelta) {
  if (wheel.adjustPoint) return wheel.adjustPoint(hueDelta, saturationDelta);
  const lab = currentWheelType === "lab";
  const center = lab ? (wheelCanvas.width - 1) / 2 : WHEEL_RADIUS;
  const [x, y] = wheel.getSelectedPoint();
  const dx = x - center, dy = y - center;
  const angle = Math.atan2(dy, dx) + hueDelta * Math.PI / 180;
  const radius = Math.max(0, Math.hypot(dx, dy) + saturationDelta * center);
  return [center + radius * Math.cos(angle), center + radius * Math.sin(angle)];
}

function nudgeLightness(delta) {
  if (currentWheelType === "circle") selectCircleColor(wheel.adjust(0, 0, delta));
  else if (isFullPlane()) selectPoint(...adjustPoint(0, delta));
  else selectAxis(currentL + delta);
}

function nudgeChroma(delta) {
  if (currentWheelType === "circle") selectCircleColor(wheel.adjust(0, delta, 0));
  else if (isFullPlane()) selectAxis(currentL + delta);
  else selectPoint(...adjustPoint(0, delta));
}

function nudgeHue(delta) {
  if (currentWheelType === "circle") selectCircleColor(wheel.adjust(delta, 0, 0));
  else selectPoint(...adjustPoint(delta, 0));
}

const allowHueRepeat = createShortcutRepeatGate();
function cyclePaletteMode() {
  const mode = nextPaletteMode(currentWheelType, cycleModes);
  if (mode === currentWheelType) return;
  swapWheel(mode);
  invoke("set_wheel_type", { wheelType: mode }).catch(console.warn);
}
cyclePaletteButton.addEventListener("click", cyclePaletteMode);

document.addEventListener("keydown", (event) => {
  if (document.hidden || !document.hasFocus() || event.defaultPrevented ||
      event.target?.closest?.("input, textarea, select, [contenteditable]")) return;
  if (paletteFooter.contains(event.target) && [" ", "Enter"].includes(event.key)) return;
  const accel = accelFromEvent(event);
  if (!accel) return;
  // An accepted low-level hook suppresses the trigger before WebView2 sees it.
  // If Windows delivers the chord here, the focused palette can handle it locally.
  if (accel.toLowerCase() === summonShortcut.toLowerCase()) {
    event.preventDefault();
    if (!event.repeat) localSummonKey = event.code || event.key;
    return;
  }
  const action = Object.keys(paletteShortcuts).find((key) => paletteShortcuts[key] === accel);
  if (!action) return;
  event.preventDefault();
  const hueDelta = hueDeltaForAction(action, colorSteps.hue);
  if (hueDelta !== null) {
    if (allowHueRepeat(action, event)) nudgeHue(hueDelta);
    return;
  }
  const lightnessDelta = lightnessDeltaForAction(action, colorSteps.lightness);
  if (lightnessDelta !== null) {
    nudgeLightness(lightnessDelta);
    return;
  }
  const chromaDelta = chromaDeltaForAction(action, colorSteps.chroma);
  if (chromaDelta !== null) {
    nudgeChroma(chromaDelta);
    return;
  }
  switch (action) {
    case "restore_sampled_color":
      if (!event.repeat) restoreReferenceColor();
      break;
    case "cycle_mode":
      if (!event.repeat) cyclePaletteMode();
      break;
    case "close": hidePalette().catch(console.warn); break;
  }
});

document.addEventListener("keyup", (event) => {
  if (localSummonKey !== (event.code || event.key)) return;
  localSummonKey = null;
  event.preventDefault();
  if (!document.hidden && document.hasFocus() && !pinned) hidePalette().catch(console.warn);
});

for (const [button, view] of [[focusedButton, "focused"], [fullButton, "full"]]) {
  button.addEventListener("click", () => {
    if (planeView !== view) invoke("set_plane_options", { view }).catch(console.warn);
  });
}

circleButton.addEventListener("click", async () => {
  circleButton.disabled = true;
  try {
    const model = circleModel === "hsv" ? "hls" : "hsv";
    await invoke("set_circle_model", { model });
    applyCircleModel(model);
  } catch (error) {
    console.warn("set_circle_model:", error);
  } finally {
    circleButton.disabled = false;
  }
});

pinButton.addEventListener("click", async () => {
  pinButton.disabled = true;
  try {
    await setPinned(!pinned);
  } catch (error) {
    console.warn(error);
  } finally {
    pinButton.disabled = false;
  }
});

// Gamut toggle
gamutBtn.addEventListener("click", () => {
  if (!wheelSupportsGamutWarning()) return;
  gamutWarning = !gamutWarning;
  applyGamutWarningState();
});

bootstrap();
window.__luma = { get wheel() { return wheel; }, slider, setColor, setLightness, invoke };
