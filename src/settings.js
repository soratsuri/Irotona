import { createShortcutCapture, modes } from "./shortcuts.js";
import { bindColorStepInput } from "./color-step-input.js";
import { disconnectReason, qrMessage, translate } from "./messages.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const statusLabel = document.getElementById("status-label");
const connectionPill = document.getElementById("connection-pill");
const portableWarning = document.getElementById("portable-warning");
const settingsPath = document.getElementById("settings-path");
const sessionPath = document.getElementById("session-path");
const scanBtn = document.getElementById("scan-btn");
const showPaletteBtn = document.getElementById("show-palette-btn");
const languageSelect = document.getElementById("language-select");
const eyedropperHelp = document.getElementById("eyedropper-help");
const cycleOptions = document.getElementById("cycle-mode-options");
const cycleChecks = [...cycleOptions.querySelectorAll("input")];
const restrictToggle = document.getElementById("restrict-toggle");
const wheelType = document.getElementById("wheel-type");
const planeOptions = document.getElementById("plane-options");
const planeView = document.getElementById("plane-view-select");
const planeSize = document.getElementById("plane-size-select");
const planeBackground = document.getElementById("plane-background-select");
const planeShadow = document.getElementById("plane-shadow");
const paletteOffset = document.getElementById("palette-offset");
const shortcutAction = document.getElementById("shortcut-action");
const cancelCaptureBtn = document.getElementById("cancel-capture");
const shortcutEnabled = document.getElementById("shortcut-enabled");
const shortcutValue = document.getElementById("shortcut-value");
const recordShortcutBtn = document.getElementById("record-shortcut-btn");
const clearShortcutBtn = document.getElementById("clear-shortcut-btn");
const captureBox = document.getElementById("capture-box");
const captureValue = document.getElementById("capture-value");
const shortcutMessage = document.getElementById("shortcut-message");
const closeBtn = document.getElementById("close-btn");
const colorStepRows = [...document.querySelectorAll("[data-color-step]")];
const colorStepMessage = document.getElementById("color-step-message");

let currentShortcut = "";
let captureActive = false;
let captureSaving = false;
let activeSettings = {};
let connected = false;
let language = "ja";

const colorStepControls = colorStepRows.map((row) => {
  const axis = row.dataset.colorStep;
  const render = bindColorStepInput({
    range: row.querySelector('input[type="range"]'),
    number: row.querySelector('input[type="number"]'),
    reset: row.querySelector("button"),
    scale: axis === "hue" ? 1 : 100,
    save: (value) => invoke("set_color_step", { axis, value }),
    reportError: (error) => {
      colorStepMessage.hidden = error == null;
      if (error === "color_step_invalid") colorStepMessage.textContent = t(error);
      else if (error != null) displayError(colorStepMessage, error);
    },
  });
  return { axis, render };
});

const I18N = {
  en: {
    documentTitle: "Irotona Settings",
    starting: "Starting...",
    checking: "Checking",
    portableTitle: "Portable storage needs attention",
    portableBody: "Irotona saves settings.json and session.json beside the app. Move the app to a writable folder if settings or pairing do not persist.",
    setup: "Setup",
    language: "Language",
    step1: "Open Clip Studio Paint.",
    step2: "Choose File > Connect to Smartphone.",
    step3: "Keep the QR code visible while Irotona scans.",
    disconnectScan: "Disconnect and scan QR",
    forgetScan: "Forget session and scan QR",
    showPalette: "Show palette now",
    action_eyedropper: "Show palette after using the eyedropper",
    eyedropperHelp: "Assign the same eyedropper key in CSP. Hold it while tapping the canvas. For Alt alone, press and release Alt when recording.",
    paletteSettings: "Palette settings",
    restrictTitle: "Only respond when CSP is focused",
    restrictHelp: "Limit the manual palette shortcut to CSP and the palette window.",
    colorWheel: "Color wheel",
    palettePosition: "Palette position",
    keyboardShortcut: "Keyboard shortcut",
    shortcutTitle: "Enable keyboard shortcut",
    colorSteps: "Color adjustment steps",
    colorStepsHelp: "Change per key input. Percentage steps are relative to each mode’s color scale.",
    step_hue: "Hue",
    step_chroma: "Saturation / chroma",
    step_lightness: "Lightness",
    stepDegrees: "° / key",
    stepPercent: "% / key",
    stepReset: "Reset",
    stepResetAxis: "Reset {axis} to default",
    color_step_invalid: "Enter a number within the allowed range.",
    shortcutHelp: "The show/hide shortcut works outside the palette. Use a modifier plus an F-key, or at least two modifiers. Other shortcuts work only in the focused palette.",
    recordShortcut: "Record shortcut",
    clear: "Clear",
    pressKeys: "Press keys...",
    cancelCapture: "Cancel",
    actionLabel: "Action",
    wheelPlane: "Color Plane",
    wheelCircle: "Color circle",
    planeView: "Color Plane view",
    planeSize: "Palette size",
    planeBackground: "Background texture",
    backgroundPlain: "Plain",
    backgroundCanvas: "Canvas",
    backgroundPaper: "Fine art paper",
    backgroundHelp: "Applies to the background in Focused view.",
    planeShadow: "Add a contact shadow to the color plane",
    shadowHelp: "Adds a faint shadow outside the edge in Focused view.",
    sizeSmall: "Small",
    sizeMedium: "Medium",
    sizeLarge: "Large",
    shortcut_invalid: "Choose a letter, number, function key, arrow, or navigation key.",
    shortcut_modifier: "Use a modifier plus an F-key, or at least two modifiers.",
    shortcut_duplicate: "That shortcut is already assigned.",
    action_global: "Show / hide palette",
    action_hue_next: "Next hue",
    action_hue_prev: "Previous hue",
    action_light_up: "Increase lightness",
    action_light_down: "Decrease lightness",
    action_chroma_up: "Increase saturation",
    action_chroma_down: "Decrease saturation",
    action_cycle_mode: "Cycle palette mode",
    cycleModes: "Palettes included in the cycle shortcut",
    action_close: "Close palette",
    action_restore_sampled_color: "Restore sampled color",
    error: "The operation failed.",
    storage: "Storage",
    settings: "Settings",
    pairing: "Pairing",
    close: "Close to tray",
    off: "Off",
    connected: "Connected",
    scanning: "Scanning",
    reconnecting: "Reconnecting",
    disconnected: "Disconnected",
    waiting: "Waiting",
    waitingCsp: "Waiting for Clip Studio Paint",
    tryingSession: "Trying saved Companion Mode session",
    connectedTo: "Connected to CSP at {detail}",
    disconnectedReason: "Disconnected: {detail}",
    clearingConnected: "Disconnecting and clearing saved pairing...",
    clearing: "Clearing saved pairing...",
    shortcutCanceled: "Shortcut recording canceled.",
    registering: "Registering shortcut...",
    shortcutSet: "Shortcut set to {shortcut}.",
    pressAnother: "Press another shortcut...",
    shortcutDisabled: "Keyboard shortcut disabled.",
    shortcutCleared: "Keyboard shortcut cleared.",
    unavailable: "Unavailable",
    wheelOklch: "OKLCH (perceptual)",
    wheelHsv: "HSV (CSP native)",
    wheelHsl: "HSL (classic)",
    wheelLab: "Photoshop Lab",
    posBr: "Bottom-right of cursor",
    posBl: "Bottom-left of cursor (left-handed)",
    posTr: "Top-right of cursor",
    posTl: "Top-left of cursor",
    posCenter: "Centered on cursor",
  },
  "zh-TW": {
    documentTitle: "Irotona 設定",
    starting: "啟動中...",
    checking: "檢查中",
    portableTitle: "可攜式儲存需要注意",
    portableBody: "Irotona 會把 settings.json 和 session.json 儲存在程式旁邊。如果設定或配對無法保存，請把程式移到可寫入的資料夾。",
    setup: "設定",
    language: "語言",
    step1: "開啟 Clip Studio Paint。",
    step2: "選擇「檔案 > 連接至智慧型手機」。",
    step3: "掃描時請讓 QR code 保持顯示。",
    disconnectScan: "中斷並掃描 QR",
    forgetScan: "清除配對並掃描 QR",
    showPalette: "立即顯示調色盤",
    action_eyedropper: "取色後顯示調色盤",
    eyedropperHelp: "請在 CSP 設定相同的取色鍵，按住該鍵再點選畫布。若要單獨指派 Alt，請在錄製時按下再放開 Alt。",
    paletteSettings: "調色盤設定",
    restrictTitle: "只在 CSP 作用中時回應",
    restrictHelp: "僅在 CSP 或調色盤視窗中啟用手動呼叫快捷鍵。",
    colorWheel: "色盤模式",
    palettePosition: "調色盤位置",
    keyboardShortcut: "鍵盤快捷鍵",
    shortcutTitle: "啟用鍵盤快捷鍵",
    colorSteps: "色彩調整幅度",
    colorStepsHelp: "每次按鍵的變化量。百分比以各模式的色彩刻度為基準。",
    step_hue: "色相",
    step_chroma: "飽和度／彩度",
    step_lightness: "明度",
    stepDegrees: "°／次",
    stepPercent: "%／次",
    stepReset: "重設",
    stepResetAxis: "將{axis}重設為預設值",
    color_step_invalid: "請輸入範圍內的數值。",
    shortcutHelp: "顯示／隱藏快捷鍵可在調色盤外使用。請搭配修飾鍵及功能鍵，或至少使用兩個修飾鍵。其他快捷鍵只在調色盤取得焦點時有效。",
    recordShortcut: "錄製快捷鍵",
    clear: "清除",
    pressKeys: "請按下按鍵...",
    cancelCapture: "取消",
    actionLabel: "操作",
    wheelPlane: "色彩平面",
    wheelCircle: "色環",
    planeView: "色彩平面檢視",
    planeSize: "調色盤大小",
    planeBackground: "背景質感",
    backgroundPlain: "素色",
    backgroundCanvas: "畫布",
    backgroundPaper: "藝術紙",
    backgroundHelp: "套用至鄰近明度檢視的背景。",
    planeShadow: "為色彩平面加上接觸陰影",
    shadowHelp: "在鄰近明度檢視的輪廓外加入淡淡的陰影。",
    sizeSmall: "小",
    sizeMedium: "中",
    sizeLarge: "大",
    shortcut_invalid: "請使用字母、數字、功能鍵、方向鍵或導覽鍵。",
    shortcut_modifier: "請搭配修飾鍵及功能鍵，或至少使用兩個修飾鍵。",
    shortcut_duplicate: "此快捷鍵已指派。",
    action_global: "顯示／隱藏調色盤",
    action_hue_next: "下一個色相",
    action_hue_prev: "上一個色相",
    action_light_up: "提高明度",
    action_light_down: "降低明度",
    action_chroma_up: "提高彩度",
    action_chroma_down: "降低彩度",
    action_cycle_mode: "切換色盤模式",
    cycleModes: "快捷鍵循環切換的色盤",
    action_close: "關閉調色盤",
    action_restore_sampled_color: "還原取樣色",
    error: "操作失敗。",
    storage: "儲存位置",
    settings: "設定",
    pairing: "配對",
    close: "關閉到系統匣",
    off: "關閉",
    connected: "已連線",
    scanning: "掃描中",
    reconnecting: "重新連線",
    disconnected: "已中斷",
    waiting: "等待中",
    waitingCsp: "等待 Clip Studio Paint",
    tryingSession: "嘗試使用已儲存的 Companion Mode 配對",
    connectedTo: "已連線到 CSP：{detail}",
    disconnectedReason: "已中斷：{detail}",
    clearingConnected: "正在中斷並清除已儲存配對...",
    clearing: "正在清除已儲存配對...",
    shortcutCanceled: "已取消錄製快捷鍵。",
    registering: "正在設定快捷鍵...",
    shortcutSet: "快捷鍵已設定為 {shortcut}。",
    pressAnother: "請按另一組快捷鍵...",
    shortcutDisabled: "鍵盤快捷鍵已停用。",
    shortcutCleared: "鍵盤快捷鍵已清除。",
    unavailable: "無法取得",
    wheelOklch: "OKLCH（感知均勻）",
    wheelHsv: "HSV（CSP 原生）",
    wheelHsl: "HSL（傳統）",
    wheelLab: "Photoshop Lab",
    posBr: "游標右下",
    posBl: "游標左下（左手模式）",
    posTr: "游標右上",
    posTl: "游標左上",
    posCenter: "以游標置中",
  },
  ja: {
    documentTitle: "Irotona の設定",
    starting: "起動中…",
    checking: "確認中",
    portableTitle: "設定を保存できません",
    portableBody: "設定とペアリング情報は EXE と同じフォルダーに保存されます。保存できない場合は、EXE を書き込み可能な場所に移動してください。",
    setup: "接続と初期設定",
    language: "言語",
    step1: "CLIP STUDIO PAINT を起動します。",
    step2: "［ファイル］→［スマートフォンを接続］を開きます。",
    step3: "ペアリングが完了するまで QR コードを画面に表示してください。",
    disconnectScan: "接続を解除して QR コードを検索",
    forgetScan: "保存済みの接続情報を消去して QR コードを検索",
    showPalette: "パレットを表示",
    action_eyedropper: "スポイト後にパレットを表示",
    eyedropperHelp: "クリスタでも同じキーをスポイトに割り当て、押したままキャンバスをタップします。Alt 単独を登録するには、割り当て中に Alt を押して離してください。",
    paletteSettings: "パレット設定",
    restrictTitle: "クリスタが前面のときだけ反応",
    restrictHelp: "手動呼び出しキーはクリスタとパレットのウィンドウでだけ有効になります。",
    colorWheel: "パレットモード",
    palettePosition: "表示位置",
    keyboardShortcut: "キーボードショートカット",
    shortcutTitle: "呼び出しキーを有効にする",
    colorSteps: "カラー操作の変更幅",
    colorStepsHelp: "キー入力1回あたりの変化量です。%は各モードの色の尺度に対する目安です。",
    step_hue: "色相",
    step_chroma: "彩度・クロマ",
    step_lightness: "明度",
    stepDegrees: "° / 回",
    stepPercent: "% / 回",
    stepReset: "初期値に戻す",
    stepResetAxis: "{axis}を初期値に戻す",
    color_step_invalid: "範囲内の数値を入力してください。",
    shortcutHelp: "呼び出しキーは修飾キーと F キーの組み合わせ、または修飾キーを2つ以上使います。ほかの操作はパレットが前面にあるときに有効です。",
    recordShortcut: "キーを割り当て",
    clear: "解除",
    pressKeys: "割り当てるキーを押してください",
    cancelCapture: "キャンセル",
    actionLabel: "操作",
    shortcut_invalid: "英数字、F キー、矢印キー、移動キーのいずれかを使用してください。",
    shortcut_modifier: "修飾キーと F キーを組み合わせるか、修飾キーを2つ以上使用してください。",
    shortcut_duplicate: "そのキーは別の操作に割り当てられています。",
    action_global: "パレットの表示・非表示",
    action_hue_next: "色相を進める",
    action_hue_prev: "色相を戻す",
    action_light_up: "明度を上げる",
    action_light_down: "明度を下げる",
    action_chroma_up: "彩度を上げる",
    action_chroma_down: "彩度を下げる",
    action_cycle_mode: "パレットモードを切り替える",
    cycleModes: "ショートカットで切り替えるパレット",
    action_close: "パレットを閉じる",
    action_restore_sampled_color: "取得色に戻す",
    error: "操作を完了できませんでした。",
    storage: "保存先",
    settings: "設定",
    pairing: "接続情報",
    close: "閉じる",
    off: "未割り当て",
    connected: "接続済み",
    scanning: "QR 検索中",
    reconnecting: "再接続中",
    disconnected: "未接続",
    waiting: "待機中",
    waitingCsp: "CLIP STUDIO PAINT の起動を待機中",
    tryingSession: "保存済みの情報で再接続しています",
    connectedTo: "クリスタに接続しました（{detail}）",
    disconnectedReason: "未接続（{detail}）",
    clearingConnected: "接続を解除して保存済みの情報を消去しています…",
    clearing: "保存済みの接続情報を消去しています…",
    shortcutCanceled: "キーの割り当てをキャンセルしました。",
    registering: "キーを割り当てています…",
    shortcutSet: "{shortcut} を割り当てました。",
    pressAnother: "別のキーを押してください",
    shortcutDisabled: "呼び出しキーを無効にしました。",
    shortcutCleared: "キーの割り当てを解除しました。",
    unavailable: "取得できません",
    wheelPlane: "色面パレット",
    wheelCircle: "カラーサークル",
    planeView: "色面パレットの表示",
    planeSize: "パレットのサイズ",
    planeBackground: "背景の質感",
    backgroundPlain: "無地",
    backgroundCanvas: "キャンバス地",
    backgroundPaper: "ファインアート紙",
    backgroundHelp: "同明度中心の背景に適用します。",
    planeShadow: "色面に接地影を付ける",
    shadowHelp: "同明度中心の色面の輪郭外に、ごく薄い影を付けます。",
    sizeSmall: "小",
    sizeMedium: "中",
    sizeLarge: "大",
    wheelOklch: "OKLCH（知覚的明度）",
    wheelHsv: "HSV（クリスタ標準）",
    wheelHsl: "HSL",
    wheelLab: "Photoshop Lab",
    posBr: "カーソルの右下",
    posBl: "カーソルの左下（左利き向け）",
    posTr: "カーソルの右上",
    posTl: "カーソルの左上",
    posCenter: "カーソルを中心に表示",
  },
};

function t(key, vars = {}) {
  const dict = I18N[language] || I18N.en;
  let value = dict[key] || I18N.en[key] || key;
  for (const [name, replacement] of Object.entries(vars)) {
    value = value.replace(`{${name}}`, replacement);
  }
  return value;
}

function setText(selector, key) {
  const el = document.querySelector(selector);
  if (el) el.textContent = t(key);
}

function setOptionText(selector, key) {
  const option = document.querySelector(selector);
  if (option) option.textContent = t(key);
}

function applyLanguage() {
  document.documentElement.lang = language === "zh-TW" ? "zh-Hant" : language;
  document.title = t("documentTitle");
  setText("#portable-warning h2", "portableTitle");
  setText("#portable-warning p", "portableBody");
  setText("main section:nth-of-type(2) h2", "setup");
  setText("label[for='language-select']", "language");
  setText("ol li:nth-child(1)", "step1");
  setText("ol li:nth-child(2)", "step2");
  setText("ol li:nth-child(3)", "step3");
  showPaletteBtn.textContent = t("showPalette");
  eyedropperHelp.textContent = t("eyedropperHelp");
  cycleOptions.querySelector("legend").textContent = t("cycleModes");
  document.getElementById("cycle-mode-plane").textContent = t("wheelPlane");
  document.getElementById("cycle-mode-circle").textContent = t("wheelCircle");
  setText("main section:nth-of-type(3) h2", "paletteSettings");
  setText("#restrict-toggle + span strong", "restrictTitle");
  setText("#restrict-toggle + span small", "restrictHelp");
  setText("label[for='wheel-type']", "colorWheel");
  setText("label[for='palette-offset']", "palettePosition");
  setText("main section:nth-of-type(4) h2", "keyboardShortcut");
  setText("#shortcut-enabled + span strong", "shortcutTitle");
  setText("#shortcut-enabled + span small", "shortcutHelp");
  recordShortcutBtn.textContent = t("recordShortcut");
  clearShortcutBtn.textContent = t("clear");
  cancelCaptureBtn.textContent = t("cancelCapture");
  setText("label[for='shortcut-action']", "actionLabel");
  for (const option of shortcutAction.options) option.textContent = t("action_" + option.value);
  setText("#color-steps h2", "colorSteps");
  setText("#color-steps h2 + p", "colorStepsHelp");
  for (const row of colorStepRows) {
    const axis = row.dataset.colorStep;
    const label = t("step_" + axis);
    const reset = row.querySelector("button");
    row.querySelector("label").textContent = label;
    row.querySelector(".color-step-unit").textContent = t(axis === "hue" ? "stepDegrees" : "stepPercent");
    reset.textContent = t("stepReset");
    reset.setAttribute("aria-label", t("stepResetAxis", { axis: label }));
  }
  setText("#storage-panel h2", "storage");
  setText("dt:nth-of-type(1)", "settings");
  setText("dt:nth-of-type(2)", "pairing");
  closeBtn.textContent = t("close");

  setOptionText("#wheel-type option[value='plane']", "wheelPlane");
  setOptionText("#wheel-type option[value='circle']", "wheelCircle");
  setText("label[for='plane-view-select']", "planeView");
  setText("label[for='plane-size-select']", "planeSize");
  setText("label[for='plane-background-select']", "planeBackground");
  setOptionText("#plane-background-select option[value='plain']", "backgroundPlain");
  setOptionText("#plane-background-select option[value='canvas']", "backgroundCanvas");
  setOptionText("#plane-background-select option[value='paper']", "backgroundPaper");
  setText("#plane-background-help", "backgroundHelp");
  setText("#plane-shadow-label", "planeShadow");
  setText("#plane-shadow-help", "shadowHelp");
  planeView.options[0].textContent = translate(language, "planeFocused");
  planeView.options[1].textContent = translate(language, "planeFull");
  setOptionText("#plane-size-select option[value='small']", "sizeSmall");
  setOptionText("#plane-size-select option[value='medium']", "sizeMedium");
  setOptionText("#plane-size-select option[value='large']", "sizeLarge");
  setOptionText("#wheel-type option[value='oklch']", "wheelOklch");
  setOptionText("#wheel-type option[value='hsv']", "wheelHsv");
  setOptionText("#wheel-type option[value='hsl']", "wheelHsl");
  setOptionText("#wheel-type option[value='lab']", "wheelLab");
  setOptionText("#palette-offset option[value='bottom-right']", "posBr");
  setOptionText("#palette-offset option[value='bottom-left']", "posBl");
  setOptionText("#palette-offset option[value='top-right']", "posTr");
  setOptionText("#palette-offset option[value='top-left']", "posTl");
  setOptionText("#palette-offset option[value='center']", "posCenter");
}

function renderPhase(phase) {
  statusLabel.textContent = phaseText(phase);
  const key = phase?.phase || "waiting_for_csp";
  connectionPill.className = key;
  connectionPill.textContent = pillText(key);
}

function phaseText(phase) {
  const key = phase?.phase || "waiting_for_csp";
  const detail = phase?.detail || "";
  switch (key) {
    case "connected": return t("connectedTo", { detail });
    case "scanning": return t("scanning");
    case "reconnecting": return t("tryingSession");
    case "disconnected": return t("disconnectedReason", { detail: translate(language, disconnectReason(detail)) });
    case "waiting_for_csp":
    default: return t("waitingCsp");
  }
}

function pillText(key) {
  switch (key) {
    case "connected": return t("connected");
    case "scanning": return t("scanning");
    case "reconnecting": return t("reconnecting");
    case "disconnected": return t("disconnected");
    case "waiting_for_csp":
    default: return t("waiting");
  }
}

function renderSettings(settings) {
  activeSettings = settings;
  language = settings.language || "ja";
  languageSelect.value = language;
  restrictToggle.checked = !!settings.restrict_to_csp;
  wheelType.value = settings.wheel_type || "oklch";
  planeOptions.hidden = wheelType.value !== "plane";
  planeBackground.value = settings.plane_background ?? "plain";
  planeShadow.checked = settings.plane_shadow === true;
  planeView.value = settings.plane_view === "full" ? "full" : "focused";
  planeSize.value = ["small", "large"].includes(settings.plane_size) ? settings.plane_size : "medium";
  paletteOffset.value = settings.palette_offset || "bottom-right";
  applyLanguage();
  renderShortcut();
  renderCycleOptions();
  for (const { axis, render } of colorStepControls) render(settings.color_steps?.[axis]);
  renderScanAction(connected);
}

function renderCycleOptions() {
  const enabled = activeSettings.cycle_modes ?? modes;
  for (const checkbox of cycleChecks) {
    checkbox.checked = enabled.includes(checkbox.value);
    checkbox.disabled = enabled.length === 1 && checkbox.checked;
  }
}

cycleOptions.addEventListener("change", async () => {
  const selected = cycleChecks.filter((checkbox) => checkbox.checked).map((checkbox) => checkbox.value);
  cycleOptions.disabled = true;
  try {
    await invoke("set_cycle_modes", { modes: selected });
    await refresh();
  } catch (error) {
    console.warn("set_cycle_modes:", error);
    renderCycleOptions();
  } finally {
    cycleOptions.disabled = false;
  }
});

function renderPortable(portable) {
  portableWarning.hidden = !!portable.exe_dir_writable;
  settingsPath.textContent = portable.settings_path || t("unavailable");
  sessionPath.textContent = portable.session_path || t("unavailable");
}

function renderScanAction(isConnected) {
  connected = !!isConnected;
  scanBtn.textContent = connected ? t("disconnectScan") : t("forgetScan");
}

async function refresh() {
  const snapshot = await invoke("get_app_snapshot");
  renderSettings(snapshot.settings);
  renderPhase(snapshot.phase);
  renderPortable(snapshot.portable);
  renderScanAction(snapshot.connected);
}

function renderShortcut() {
  const action = shortcutAction.value;
  const global = action === "global";
  currentShortcut = (global ? activeSettings.global_hotkey
    : action === "eyedropper" ? activeSettings.eyedropper_hotkey
    : activeSettings.palette_shortcuts?.[action]) || "";
  eyedropperHelp.hidden = action !== "eyedropper";
  shortcutEnabled.closest("label").hidden = !global;
  shortcutEnabled.checked = !!currentShortcut;
  shortcutValue.textContent = currentShortcut || t("off");
  clearShortcutBtn.disabled = !currentShortcut;
}

function saveShortcut(hotkey) {
  const action = shortcutAction.value;
  if (action === "global") return invoke("set_global_hotkey", { hotkey });
  if (action === "eyedropper") return invoke("set_eyedropper_hotkey", { hotkey });
  return invoke("set_palette_shortcut", { action, hotkey });
}

function displayError(element, error) {
  console.warn(error);
  element.textContent = t("error");
}

let captureShortcut;

function startCapture() {
  captureActive = true;
  captureShortcut = createShortcutCapture(shortcutAction.value === "eyedropper");
  shortcutAction.disabled = true;
  captureValue.textContent = t("pressKeys");
  captureBox.hidden = false;
  cancelCaptureBtn.focus();
  shortcutMessage.textContent = "";
  document.addEventListener("keydown", onCaptureKey, true);
  document.addEventListener("keyup", onCaptureKey, true);
}

function stopCapture() {
  captureActive = false;
  shortcutAction.disabled = false;
  captureBox.hidden = true;
  document.removeEventListener("keydown", onCaptureKey, true);
  document.removeEventListener("keyup", onCaptureKey, true);
}

async function onCaptureKey(e) {
  if (!captureActive || captureSaving) return;
  e.preventDefault();
  e.stopPropagation();

  if (e.type === "keydown" && e.key === "Escape" && shortcutAction.value === "global") {
    shortcutMessage.textContent = t("shortcutCanceled");
    stopCapture();
    return;
  }

  const accel = captureShortcut(e);
  if (!accel) return;

  captureValue.textContent = accel;
  shortcutMessage.textContent = t("registering");
  captureSaving = true;
  try {
    await saveShortcut(accel);
    shortcutMessage.textContent = t("shortcutSet", { shortcut: accel });
    stopCapture();
    await refresh();
  } catch (err) {
    shortcutMessage.textContent = I18N.en[err] ? t(err) : t("error");
    captureValue.textContent = t("pressAnother");
  } finally {
    captureSaving = false;
  }
}

scanBtn.addEventListener("click", () => {
  scanBtn.disabled = true;
  statusLabel.textContent = connected ? t("clearingConnected") : t("clearing");
  invoke("disconnect_and_scan_qr").then(refresh).catch((err) => {
    displayError(statusLabel, err);
  }).finally(() => {
    scanBtn.disabled = false;
  });
});

showPaletteBtn.addEventListener("click", () => {
  invoke("show_palette_at_cursor").catch((err) => {
    displayError(statusLabel, err);
  });
});

languageSelect.addEventListener("change", async () => {
  language = languageSelect.value;
  applyLanguage();
  renderScanAction(connected);
  await invoke("set_language", { language });
  await refresh();
});

restrictToggle.addEventListener("change", async () => {
  await invoke("set_restrict_to_csp", { enabled: restrictToggle.checked });
  await refresh();
});

wheelType.addEventListener("change", async () => {
  await invoke("set_wheel_type", { wheelType: wheelType.value });
  await refresh();
});

planeView.addEventListener("change", () => {
  invoke("set_plane_options", { view: planeView.value }).catch((error) => displayError(statusLabel, error));
});

planeBackground.addEventListener("change", () => {
  invoke("set_plane_options", { background: planeBackground.value }).catch((error) => displayError(statusLabel, error));
});

planeShadow.addEventListener("change", () => {
  invoke("set_plane_options", { shadow: planeShadow.checked }).catch((error) => displayError(statusLabel, error));
});

planeSize.addEventListener("change", () => {
  invoke("set_plane_options", { size: planeSize.value }).catch((error) => displayError(statusLabel, error));
});

paletteOffset.addEventListener("change", async () => {
  await invoke("set_palette_offset", { offset: paletteOffset.value });
  await refresh();
});

shortcutEnabled.addEventListener("change", async () => {
  if (shortcutEnabled.checked) {
    if (!currentShortcut) startCapture();
    return;
  }
  await saveShortcut("");
  shortcutMessage.textContent = t("shortcutDisabled");
  await refresh();
});

recordShortcutBtn.addEventListener("click", startCapture);
shortcutAction.addEventListener("change", () => {
  shortcutMessage.textContent = "";
  renderShortcut();
});
cancelCaptureBtn.addEventListener("click", () => {
  if (captureSaving) return;
  stopCapture();
  shortcutMessage.textContent = t("shortcutCanceled");
  recordShortcutBtn.focus();
});

clearShortcutBtn.addEventListener("click", async () => {
  await saveShortcut("");
  shortcutMessage.textContent = t("shortcutCleared");
  await refresh();
});

closeBtn.addEventListener("click", () => {
  invoke("mark_welcome_seen").finally(() => invoke("close_status_settings"));
});

listen("phase-changed", (evt) => renderPhase(evt.payload));
listen("settings-changed", (evt) => renderSettings(evt.payload));
listen("qr-scan-status", async (evt) => {
  try {
    const snapshot = await invoke("get_app_snapshot");
    renderPhase(snapshot.phase);
    renderScanAction(snapshot.connected);
    if (!evt.payload?.scanning && evt.payload?.message && !snapshot.connected) {
      statusLabel.textContent = translate(language, qrMessage(evt.payload.message));
    }
  } catch (err) {
    displayError(statusLabel, err);
  }
});
listen("csp-process-status", () => {
  refresh().catch((err) => {
    displayError(statusLabel, err);
  });
});

applyLanguage();
renderShortcut();
statusLabel.textContent = t("starting");
connectionPill.textContent = t("checking");
invoke("mark_welcome_seen").catch(() => {});
refresh().catch((err) => {
  displayError(statusLabel, err);
});
