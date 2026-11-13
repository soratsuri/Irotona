# Irotona

[日本語](README.ja.md) · [Downloads](https://github.com/soratsuri/Irotona/releases)

Irotona (イロトナ) is a Windows color picker for CLIP STUDIO PAINT (CSP). It reads the current drawing color and sends your edits back to the selected main or sub color through Companion Mode.

Irotona is soratsuri's modified edition of Andy Fang and contributors' [Luma Palette for Clip Studio Paint v0.1.3](https://github.com/andyubird/LumaPaletteCSP/tree/v0.1.3), previously distributed as Luma Palette Custom. It adds pen contact-drag selection, a color circle and Color Plane, configurable color and eyedropper shortcuts, pinning with position memory, and a Japanese interface.

## Download and connect

The portable executable is not code-signed. Windows SmartScreen may show a reputation warning, and Smart App Control may block unsigned apps. Verify the release SHA-256 against SHA256SUMS.txt and download only from this repository. Do not disable SmartScreen or antivirus protection; do not run the file if its hash differs or your security software reports a threat.

You need Windows x64, the Microsoft Edge WebView2 Runtime, and desktop CLIP STUDIO PAINT with Companion Mode. Windows 11 is the primary target. Windows 10 compatibility has yet to be verified for this edition. [Microsoft WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)

1. When a release is available, download **Irotona.exe** from [Irotona Releases](https://github.com/soratsuri/Irotona/releases). The same release supplies checksums and corresponding source code.
2. Move the EXE to a writable folder you own, such as a new folder under Documents, then run it directly.
3. In CSP, choose **File → Connect to Smartphone**. Keep the Companion Mode QR code visible until the app connects. Click the Windows notification-area icon to open **Status & Settings** and check the connection. [CLIP STUDIO support](https://support.clip-studio.com/en-us/faq/articles/20220005)
4. On subsequent launches, the app tries to reconnect with the saved pairing while CSP is running.

## Pick colors

Bring CSP to the foreground and press **Ctrl + Shift + F12**, or choose **Show palette now** in Status & Settings. Touch the color area with the pen and drag. Lifting the pen commits the color at the final contact position. With a mouse, click or drag with the left button.

| Mode | Controls |
| --- | --- |
| OKLCH | Hue and chroma on the wheel, perceptual lightness on the slider. This is the initial mode. |
| HSV and HSL | Hue and saturation on the wheel, value or lightness on the slider. |
| Photoshop Lab | Lab a/b axes on the plane and L on the slider. |
| Color Plane | Focused view shows an OKLab plane around the sampled lightness. Its right-hand slider adjusts lightness. In Full view, the plane still maps hue horizontally and lightness vertically, while the right-hand slider adjusts saturation. Move the slider up to increase its value. Click the left half of the comparison swatch to restore the sampled color. |
| Color circle | Hue on the outer ring. Switch the center between an HSV square and an HLS triangle. |

Use **Palette size** in Settings to select Small, Medium, or Large for every mode. Four temporary color slots and a cycle button appear below the picker. Click an empty slot to save the current color; click a filled slot to recall it; Shift-click to overwrite and right-click to clear. Slots reset when the app exits. The cycle button advances through the enabled modes, just like the M key. In Focused view, Settings also offers background textures and an optional contact shadow.

Drag the header to move the palette. Click the pin to keep the palette visible when you switch windows. A pinned palette remembers its dragged position. The summon shortcut focuses the pinned palette in place and preserves its colors. While the pinned palette is visible and CSP is in front, the app also updates from CSP drawing-color and slot changes. Click the pin again to return to normal dismissal, or press **Esc** to unpin and close.

| Action | Default shortcut |
| --- | --- |
| Show or toggle the palette | Ctrl + Shift + F12 |
| Adjust hue | Left / Right |
| Adjust lightness or value | Up / Down |
| Adjust saturation or chroma | Shift + Up / Down |
| Cycle selected palette modes | M |
| Restore sampled color in Color Plane | Unassigned |
| Close the palette | Esc |

Change assignments and choose which modes to cycle in **Keyboard Shortcut** in Status & Settings. The color and mode shortcuts work while the palette has focus. The summon shortcut is initially restricted to CSP or the palette itself. The unpinned palette closes when it loses focus.

In **Color adjustment steps**, use the slider or number field to set the per-press change for hue, saturation/chroma, and lightness. Values are saved automatically and also apply to keys sent by tools such as AntiMicroX.

### Open the palette after using the eyedropper

In CSP, assign a key such as **Q** to temporarily switch to the eyedropper. In Irotona, select **Show palette after using the eyedropper** in the shortcut settings and assign the same key. Press and release **Alt** during recording to assign Alt alone. In CSP, hold the key until the tool switches, then tap the canvas or click with the left mouse button. The palette reads the drawing color shortly after release and refreshes in place if pinned. The shortcut starts unassigned. Use **Clear** to disable the automatic popup. Earlier settings with the Alt link enabled migrate to Alt.

## Storage, updates, and exit

- The app stores **settings.json** and **session.json** beside the running EXE. The latter contains CSP pairing credentials. Keep it private.
- To update, right-click the tray icon and choose **Exit**. Back up the old folder and replace the EXE, leaving both JSON files in place. To move the installation, copy those files beside the new EXE while the app is closed.
- Closing the palette or settings window leaves the app running in the Windows notification area. Right-click the tray icon and choose **Exit** to quit. Set the UI language to Japanese, English, or Traditional Chinese in Settings.

## Troubleshooting

- **Connection stays pending.** Keep CSP running and the QR code visible. If the saved pairing no longer works, choose **Forget session and scan QR** in settings or from the tray menu, then show a fresh QR code. This removes the existing saved pairing.
- **The shortcut does not respond.** Check the tray icon, key assignment, and CSP focus setting. For eyedropper linking, confirm that CSP uses the same key and has switched tools before tapping.
- **Settings or pairing do not persist.** Use a writable folder outside protected locations such as Program Files. Check **Storage** in Status & Settings.
- **The palette opens in an awkward place.** Adjust the palette position in settings or drag the header. Use the pin to keep the new position.

## License and credits

Irotona is licensed under GPL-3.0-or-later. Copyright (C) 2026 Andy Fang and contributors. Modifications copyright (C) 2026 soratsuri. The corresponding-source asset includes the application source and the locked Rust dependencies for the Windows x64 build. [LICENSE](LICENSE) · [NOTICE](NOTICE)

Companion Mode inspiration comes from TourBox. The project credits chocolatkey/clipremote as a protocol reference. [clipremote](https://github.com/chocolatkey/clipremote) · [Protocol notes](PROTOCOL.md) · [Maintainer release guide](RELEASING.md)
