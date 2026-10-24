# Recommendations

This is a review of Snap Companion 0.1.0 in four areas: UI/UX, end-user configuration, recording, and the image/video editors. Each area lists recommendations in priority order. Priority weighs value to everyday users against the cost and risk of the change. The **top 3 in each area are implemented** on the `recommendations` branch. The rest are a backlog.

Legend: ✅ implemented on this branch · ⬜ not yet

---

## 1. UI / UX

| # | Recommendation | Why | Status |
|---|---|---|---|
| 1 | **Real zoom in the image editor** | The editor only had *Fit* and *1:1*. At 1:1, `place-items: center` on the stage also made the top and left of a large screenshot unreachable by scrolling. Precise redaction of small text needs zoom. | ✅ |
| 2 | **Keyboard-shortcut cheat sheet (`?`)** | The editor has ~25 shortcuts, and only tooltips and the README mention them. A one-key overlay is the cheapest way to make them discoverable. | ✅ |
| 3 | **One-click Copy (+ `Ctrl+C`)** | Pasting into chat or a ticket is the most common thing people do with a screenshot. Copy was buried in *Export ▾*. | ✅ |
| 4 | First-run welcome page | `onInstalled` only builds context menus. A short page could show the shortcuts, explain pinning, and link to Settings (S3 endpoint, mic permission, custom SN hosts). | ⬜ |
| 5 | Open or paste any image into the editor | Allow drag-and-drop or `Ctrl+V` of an image onto the library to annotate files that weren't captured by the extension. | ⬜ |
| 6 | Accessibility pass on the toolbars | Tool buttons are glyph + label, so screen readers read "⬉ Select". The active tool, swatch and width rely on a CSS class rather than `aria-pressed`. *Export ▾* and *Template ▾* menus have no arrow-key navigation and don't close on `Esc`. | ⬜ |
| 7 | Collapsible editor sidebar | The 320 px context panel takes a lot of room on laptop screens. Collapsing it would give the canvas or video more space. | ⬜ |
| 8 | Inline save progress | Save progress is a small text status in the top bar. A progress bar on the *Save* button, especially for real-time video re-encoding, would make long saves less mysterious. | ⬜ |
| 9 | Undo for library deletes | Replace the confirm dialog with an "Undo" toast. It's faster and just as safe. | ⬜ |

### Implemented

**1. Zoom** (`src/editor/editor.js`, `editor.html`, `editor.css`)
- *Zoom in* / *Fit ↔ 100%* / *Zoom out* buttons in the tool rail. The label shows the current percentage.
- `Ctrl` + scroll and trackpad pinch zoom around the pointer, from 10% to 800%. `Ctrl+=`, `Ctrl+−` and `Ctrl+0` work too, and the browser's own page zoom is suppressed on the canvas.
- When zoomed, the stage switches to auto-margin centering, so a large canvas scrolls from its edges. This also fixes the clipped 1:1 view.

**2. Shortcut help** (`editor.html` dialog, `editor.js`)
- `?` or the new `?` button in the top bar opens a three-column sheet: image tools, editing, video.

**3. Copy** (`editor.html`, `editor.js`)
- A *⧉ Copy* button in the top bar, shown for screenshots only. `Ctrl/⌘+C` also copies the flattened, cropped, redacted PNG when no text is selected. The Export menu item reuses the same code.

---

## 2. End-user configuration flexibility

| # | Recommendation | Why | Status |
|---|---|---|---|
| 1 | **Annotation defaults + "remember last style"** | Arrow, red, medium and pixelate were hard-coded in `setupImage()`. Someone who always uses boxes or blur had to re-pick them on every capture. | ✅ |
| 2 | **Custom color palette** | The seven swatches were hard-coded HTML. Teams want brand or severity colors, and some users need high-contrast choices. | ✅ |
| 3 | **Theme override (system / light / dark)** | The UI followed `prefers-color-scheme` only. Users with a dark OS but a light-themed ServiceNow (or the reverse) had no choice. | ✅ |
| 4 | After-capture action | Choices: open the editor (today), *copy and open*, or *save to the default destinations without opening*. A fast path for quick screenshots. Clipboard writes from the worker need an offscreen document with the `CLIPBOARD` reason. | ⬜ |
| 5 | Export / import settings as JSON | Templates, custom fields, palette and hosts are tedious to recreate by hand. Teams without Chrome policy have no way to share a setup. | ⬜ |
| 6 | Image output options | PNG vs JPEG/WebP and quality for downloads and S3. PDF layout options: environment block on/off, one image per page, margins. | ⬜ |
| 7 | Per-host destination rules | For example "captures from `dev.service-now.com` → S3 + Download". Removes repetitive toggling in the Destinations panel. | ⬜ |
| 8 | Configurable countdown and delay values | The countdown is fixed at 3 s, and the popup delay options are fixed at 3/5/10 s. | ⬜ |
| 9 | Age-based library retention | "Delete saved captures after N days" alongside the existing count and MB limits. | ⬜ |
| 10 | Managed-policy keys for the new settings | Admins will want to cap `recording.quality` or bitrate, and push a brand palette. | ⬜ |

### Implemented

**1. Annotation defaults** (`src/shared/settings.js`, `options.html`, `editor.js`)
- New *Settings → Editor & appearance* tab with defaults for tool, color, stroke width and redaction style: `editor.defaultTool`, `editor.defaultColor`, `editor.defaultWidth`, `editor.defaultBlurMode`.
- `editor.rememberStyle` is on by default. The editor then starts with the last tool, color, width and redaction style used. These are stored per device in extension `localStorage`, and Crop is never remembered as a starting tool.

**2. Palette** (`settings.js` `normalizePalette`, `options.js`, `editor.js` `renderSwatches`)
- An editable list of color pickers (add, remove, reset), up to 16 colors. Invalid or duplicate entries are dropped, and an empty list falls back to the defaults.
- The editor builds its swatches from the palette. If the default color isn't in the palette, it's added as an extra swatch so it is still visible.

**3. Theme** (`src/ui/theme.js`, `src/ui/common.css`)
- `ui.theme` sets `data-theme` on `<html>` for the popup, options page, editor/library and recorder window. It updates live when changed.
- The last value is cached in `localStorage` to avoid a flash of the wrong theme. The CSS honors `prefers-color-scheme` unless `data-theme="light"` is set.

---

## 3. Recording features

| # | Recommendation | Why | Status |
|---|---|---|---|
| 1 | **Quality presets (resolution, fps, bitrate)** | Resolution was hard-coded to 1080p, 30 fps and 2.5 Mbps. That is blurry for 1440p/4K screens and wasteful for long, low-motion walkthroughs. | ✅ |
| 2 | **Pause/resume keyboard shortcut** | Pausing meant opening the popup or recorder window, which gets captured on screen. Chrome allows four suggested shortcuts and we used three. | ✅ |
| 3 | **Keystroke overlay for tab recordings** | Click rings already exist. Viewers of a how-to video also need to see `Ctrl+S`, `Enter` and `Tab`. | ✅ |
| 4 | Webcam bubble | A picture-in-picture camera overlay for narrated walkthroughs. It would composite in the offscreen document or recorder through a canvas. | ⬜ |
| 5 | Microphone picker + level meter | The default mic is always used, and there's no feedback that it's actually picking up sound until after the recording. | ⬜ |
| 6 | Time-limit warning | `recording.maxMinutes` stops the recording silently. Show remaining time on the badge in the last minute, and a toast at 30 s. | ⬜ |
| 7 | Cursor spotlight / hide cursor | A dimmed spotlight around the cursor during tab recording, or hiding it entirely for clean product demos. | ⬜ |
| 8 | Draw on screen while recording | Temporary arrows and boxes that fade, drawn on the page during a tab recording. | ⬜ |
| 9 | Record a region of a tab | Crop to a rectangle at record time (canvas pipeline). Today this is only possible by re-encoding later. | ⬜ |

### Implemented

**1. Quality** (`settings.js` `recordingQuality`, `recording-control.js`, `offscreen.js`, `recorder.js`, `recording.js`)
- *Settings → Recording → Quality*: maximum resolution (720p / 1080p / 1440p / source up to 4K), frame rate (15/24/30/60) and bitrate (0.5–50 Mbps), with a live MB-per-minute estimate.
- Tab recordings apply these through the tab-capture constraints. Window/screen recordings apply them **after** `getDisplayMedia`, and only ever scale down. Passing `width`/`height` maximums to `getDisplayMedia` made Chrome *upscale* an 800×600 window to 1920×1080, which inflated files and broke the redaction mapping. The e2e suite caught this.
- The frame rate is saved on the capture (`source.fps`) and used by video frame-stepping.

**2. Pause shortcut** (`manifest.json`, `sw.js`, `recording-control.js` `togglePauseRecording`)
- `record-pause` command, <kbd>Alt+Shift+P</kbd> by default (changeable at `chrome://extensions/shortcuts`). It works for both tab and window/screen recordings. The key is shown on the popup's Pause/Resume buttons and in the recorder window.

**3. Keystroke overlay** (`src/content/keystrokes.js`, `recording-control.js`)
- Opt-in through *Show keyboard shortcuts and keys pressed while recording a tab* (`recording.keystrokes`).
- A pill at the bottom of the page shows up to five recent keys and fades after 1.5 s. It uses Mac symbols (⌘⇧⌥⌃) on macOS.
- Privacy rules:
  - Password fields are ignored entirely.
  - Plain characters typed into inputs, textareas and contenteditable elements show as a single "typing…".
  - IME composition keys are dropped.
- It is injected like click highlights and removed when the recording ends. In ServiceNow's classic UI the pill appears at the bottom of the `gsft_main` iframe, because it renders per frame to avoid passing keystrokes between origins.

---

## 4. Image & video markup / editors

| # | Recommendation | Why | Status |
|---|---|---|---|
| 1 | **Resize handles for shapes** | Shapes could only be moved. Fixing a slightly wrong box meant delete and redraw, which is the most common editing frustration. | ✅ |
| 2 | **Freehand pen tool** | Circling or underlining something irregular is a staple of screenshot markup. Boxes and ellipses don't cover it. | ✅ |
| 3 | **Video keyboard transport** | Trim points and redaction start/end are set "at the current time", but the only precise seeking was arrow keys on the focused timeline. Frame stepping makes trimming exact. | ✅ |
| 4 | Duplicate, nudge and z-order | `Ctrl+D` to duplicate, arrow keys to nudge 1 px (`Shift`: 10 px), bring forward / send back. | ⬜ |
| 5 | Text styling | Text is always a filled 18 px label. Add size presets, outline/plain styles and a callout shape with a pointer. | ⬜ |
| 6 | Spotlight and magnifier tools | Dim everything outside a region, and a zoomed callout bubble. Both are popular in docs and tickets. | ⬜ |
| 7 | Shape options | Fill and opacity, dashed strokes, arrowhead styles (double, none). | ⬜ |
| 8 | Resizable and moving video redactions | Video regions can be moved but not resized. Content that scrolls needs keyframed region positions (manual tracking). | ⬜ |
| 9 | Faster video export (WebCodecs) | Export re-encodes in real time and needs the tab visible. WebCodecs + an MP4/WebM muxer would be faster than real time and work in the background. | ⬜ |
| 10 | More video edits | Cut out middle segments, speed up idle stretches, crop or resize on export, and timed text/arrow overlays. | ⬜ |
| 11 | Multi-select and snapping | Marquee/shift-click selection, plus snap-to-edge guides for tidy layouts. | ⬜ |

### Implemented

**1. Resize handles** (`src/editor/canvas.js` `handles`, `handleAt`, `resizeShape`)
- With *Select*, the selected shape shows white square handles that stay 9 CSS px at any zoom:
  - Boxes, ellipses, highlights, redactions and pen strokes have eight handles. Dragging past the opposite edge flips the shape.
  - Arrows have one handle at each endpoint.
  - Text has a corner handle that scales the font size (8–200 px).
- The hover cursor shows the resize direction. Each resize is one undo step, and redaction boxes are clamped to the image.

**2. Pen** (`canvas.js` `drawPen`, `editor.html`, `editor.js`)
- `P` or the *Pen* button. Strokes are smoothed with quadratic curves through segment midpoints and use the current color and width.
- Strokes can be selected (hit-tested along the path), moved, resized, recolored and deleted. They're saved in the annotation doc as `{ type: 'pen', props: { points, color, width } }`.

**3. Video transport** (`src/editor/video-editor.js`, `editor.js` `videoKey`)
- `Space` play/pause · `,` / `.` previous/next frame · `←` / `→` seek 1 s (`Shift`: 5 s) · `Home` / `End` jump to the trim start/end.
- When the native player or the timeline has focus, it keeps its own Space and arrow handling, so nothing fires twice.

---

## Verification

- `npm test`: 30/30 pass, including new `tests/settings.test.js` for palette normalization and the quality presets.
- `npm run test:e2e`: 39/39 pass, including new checks that `.` steps one frame and `Home` jumps to the trim start.
- A scratch headless-Chrome run (not committed) also exercised:
  - the theme switch, palette and defaults
  - resizing a box and a pen stroke, moving a stroke, and undo
  - zoom buttons, `Ctrl`+wheel and `Ctrl+0`
  - the help dialog, Copy, and remember-last-style
  - the keystroke overlay's password, typing and chord rules
