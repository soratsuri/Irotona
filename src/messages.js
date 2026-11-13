const messages = {
  waitingCsp: ["Waiting for Clip Studio Paint…", "等待 Clip Studio Paint…", "CLIP STUDIO PAINT の起動を待機中…"],
  waitingLaunch: ["Waiting for Clip Studio Paint…", "等待 Clip Studio Paint…", "CLIP STUDIO PAINT の起動を待機中…"],
  connected: ["Connected", "已連線", "接続済み"],
  disconnected: ["Disconnected", "已中斷", "未接続"],
  scanning: ["Scanning for Companion Mode QR…", "正在掃描配對 QR code…", "コンパニオンモードの QR コードを検索中…"],
  gamutToggle: ["Toggle gamut warning", "切換色域警告", "色域警告の表示を切り替え"],
  gamutInside: ["This mode stays inside sRGB", "此模式不超出 sRGB 色域", "このモードは sRGB の色域内です"],
  pointerInfo: ["Show input diagnostics", "顯示輸入診斷", "ペン入力の診断情報を表示"],
  axis: ["Lightness / value", "明度／亮度", "明度・明るさを調整"],
  planeFocused: ["Focused", "鄰近明度", "同明度中心"],
  planeFull: ["Full lightness", "全明度", "全明度"],
  planeSwitch: ["Color Plane view", "色彩平面檢視", "色面パレットの表示方式"],
  circleModel: ["Switch color space", "切換色彩空間", "色空間を切り替える"],
  planeLightness: ["Lightness", "明度", "明度"],
  planeChroma: ["Saturation", "彩度", "彩度"],
  planeComparison: ["Sampled color (left) / current color (right)", "取樣色（左）／目前顏色（右）", "取得した色（左）／現在の色（右）"],
  restoreSampledColor: ["Restore sampled color", "還原取樣色", "取得した色に戻す"],
  colorSlots: ["Temporary colors", "暫存顏色", "一時保存色"],
  colorSlot: ["Color slot", "顏色欄", "カラースロット"],
  colorSlotSave: ["Save current color", "儲存目前顏色", "現在色を保存"],
  colorSlotRecall: ["Click to recall, Shift+click to overwrite, right-click to clear", "點擊取用，Shift＋點擊覆寫，右鍵清除", "クリックで呼び出し、Shift＋クリックで上書き、右クリックで消去"],
  cyclePalette: ["Switch to next enabled palette mode", "切換至下一個已啟用的色盤模式", "次の有効なパレットモードへ切り替え"],
  pin: ["Pin palette", "釘選色盤", "パレットをピン留め"],
  unpin: ["Unpin palette", "取消釘選", "ピン留めを解除"],
  sendFailed: ["Could not sync the color to CSP", "無法同步色彩至 CSP", "クリスタに色を送信できませんでした"],
  sampleFailed: ["Could not read the current CSP color", "無法讀取 CSP 的目前色彩", "クリスタの現在色を取得できませんでした"],
  qrNoAddress: ["No address in pairing QR code", "配對 QR code 沒有位址", "ペアリング用 QR コードに接続先がありません"],
  qrAuth: ["Pairing authentication failed", "配對驗證失敗", "ペアリングの認証に失敗しました"],
  qrConnect: ["Could not connect to CSP", "無法連線至 CSP", "クリスタに接続できませんでした"],
  qrDecode: ["Could not read the pairing QR code", "無法讀取配對 QR code", "ペアリング用 QR コードを読み取れませんでした"],
  qrError: ["Could not scan the pairing QR code", "無法掃描配對 QR code", "ペアリング用 QR コードを検索できませんでした"],
  cspClosed: ["CSP closed", "CSP 已關閉", "クリスタが終了しました"],
  socketDropped: ["Connection lost", "連線中斷", "通信が切断されました"],
  userDisconnect: ["Manually disconnected", "手動中斷連線", "手動で切断しました"],
};

export function translate(language, key) {
  return messages[key]?.[language === "ja" ? 2 : language === "zh-TW" ? 1 : 0] || key;
}

export function qrMessage(message) {
  switch (message) {
    case "QR had no IPs": return "qrNoAddress";
    case "auth failed": return "qrAuth";
    case "connect failed": return "qrConnect";
    case "decode failed": return "qrDecode";
    case "waiting for CSP process": return "waitingCsp";
    case "already connected":
    case "connected": return "connected";
    case "scanning": return "scanning";
    default: return "qrError";
  }
}

export function disconnectReason(reason) {
  switch (reason) {
    case "CSP closed": return "cspClosed";
    case "socket dropped": return "socketDropped";
    case "user": return "userDisconnect";
    default: return "disconnected";
  }
}
