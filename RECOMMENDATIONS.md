# Recommendations

This is a review of Snap Companion 0.1.0 in four areas: UI/UX, end-user configuration, recording, and the image/video editors. Each area lists recommendations in priority order. Priority weighs value to everyday users against the cost and risk of the change. The **top 3 in each area are implemented** on the `recommendations` branch. The rest are a backlog.

Sections 5 and 6 were added in a second pass. They cover updates to what the app already does (reliability, platform limits, project hygiene) and net new features. All of them are implemented. A few are partial or can't be verified in this environment; each one's notes say where.

Legend for sections 5–6: ✅ implemented · ◐ implemented in part (see notes)

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

## 5. App updates (existing functionality)

These items harden, fix or extend things the app already does. Several close open questions from the design doc (§20).

| # | Recommendation | Why | Status |
|---|---|---|---|
| 1 | **Keep settings within `chrome.storage.sync` quotas** | Every key went to `sync`, which allows 8 KB per item. Many templates or custom fields hit `QUOTA_BYTES_PER_ITEM` and the save failed. | ✅ |
| 2 | **Retry failed saves from the library** | ServiceNow hand-offs time out after 5 minutes and S3 uploads can fail mid-way, with no one-click retry. | ✅ |
| 3 | **Check ServiceNow attachment limits before uploading** | Oversized or blocked files (`.webm`) failed late with a vague error. Answers §20 Q4. | ✅ |
| 4 | Remove or finish Cognito mode | Offered in Settings and the schema but rejected by `s3.js`. | ✅ removed |
| 5 | CI pipeline | No workflow ran the tests or built the release zip. | ✅ |
| 6 | Diagnostics export | Errors only reached the service-worker console. | ✅ |
| 7 | Library storage meter | No view of usage against `library.maxMB` or of unsaved captures blocking retention. | ✅ |
| 8 | File-name pattern preview | Tokens were typed blind. (A preview already existed for the ServiceNow pattern only.) | ✅ |
| 9 | Localization | All strings were hard-coded English. | ◐ |
| 10 | Verify and document Edge behavior | §20 Q7 was open. | ◐ |
| 11 | Auto-apply templates by table | Picking the same template for every incident is repetitive. | ✅ |

### Implemented

**1. Sync quotas** (`src/shared/settings.js`)
- `templates`, `customFields` and the tracker tokens (`LOCAL_KEYS`) now live in `chrome.storage.local`. `migrateSettings()` moves old copies out of `sync` at startup, and values that haven't been migrated yet are still read.
- `setSettings()` refuses a sync value over 8 KB with a readable message, and translates sync's quota errors. The options page shows both instead of failing silently.
- `tests/settings-storage.test.js` saves 50 templates against a quota-enforcing fake `chrome.storage`.

**2. Retry** (`src/shared/saves.js`, `src/editor/save-runner.js`, `src/editor/library.js`, `src/background/bridge.js`, `snutils/snap-command.js`)
- `pendingFailures()` finds saves whose latest attempt per destination and format failed, and `retryPlan()` groups them. The editor's save loop moved into `runSavePlan()`, so the library's *Retry failed saves (N)* goes through the same code.
- The library shows a *Save failed* chip (hover for the errors), a *Failed saves (N)* filter, and a count in the header.
- **ServiceNow:** a delivery can now be repeated when every file failed or the page didn't answer within 5 minutes (`canRedeliver`). Previously a failed delivery blocked the job for good. `/snap` keeps listening after a total failure. If the record tab is gone, the retry says to keep it open or run `/snap` again.
- Retries to Jira and GitHub attach to the issue made the first time.

**3. Attachment limits** (`snutils/snap-command.js`, `src/shared/protocol.js`, `src/shared/sn.js`, `src/storage/servicenow.js`)
- `/snap` reads both properties through `/api/now/table/sys_properties` before sending `snap:request`. If the user can't read them, it sends no limits.
- The protocol validates `context.limits`. The editor shows "This instance accepts up to N MB per file; types: …" on the ServiceNow destination, and the adapter refuses files that would be rejected, suggesting S3 plus the PDF instead.

**4. Cognito** is gone from Settings and `managed_schema.json`, and any stored or pushed `cognito` value reads as `presign`.

**5. CI** (`.github/workflows/ci.yml`, `scripts/check-version.mjs`)
- Unit tests, plus e2e on Chrome stable with Edge as an informational job. `tests/e2e/cdp.mjs` accepts `CHROME_ARGS` for `--no-sandbox`.
- On `v*` tags, the workflow checks that tag, manifest and package versions match, then publishes `snap-companion.zip` to a GitHub release.
- **Not yet run on GitHub:** the workflow was written and the version guard tested locally, but no push has happened.

**6. Diagnostics** (`src/shared/diagnostics.js`, *Settings → About & diagnostics*)
- A 100-entry ring buffer in `storage.local`. It's fed by worker errors, message-handler failures, uncaught errors in the worker, editor, recorder, offscreen and options pages, and every failed save or retry.
- *Copy diagnostics* copies the version, browser, settings with tokens replaced by "(set)", and the errors. Query strings are stripped from every URL.

**7. Storage meter** (library header)
- Shows library size against the MB limit and capture count against the item limit, plus `navigator.storage.estimate()`.
- Warns when unsaved captures are holding the library over its limit, or when it's nearly full.

**8. File-name patterns** (*Settings → Saving*): live examples for both patterns, and token chips that insert at the cursor of the field last used.

**9. Localization (partial)** (`_locales/en/messages.json`, `src/ui/i18n.js`, `tests/i18n.test.js`)
- `default_locale` is set, and the manifest name, description, action title and command descriptions use `__MSG_…__`.
- Converted so far: context menus, the popup (including script-built strings), the recorder window and the side panel.
- **Not converted:** the editor, library and Settings page are still English-only. They're the bulk of the strings, and the test fails if a referenced key is missing, so the rest can move over incrementally.

**10. Edge (partial):** CI runs the e2e suite against Edge stable, and the README has a *Browser support* section. **Not verified:** Edge isn't installed on this machine, so no Edge run has happened yet. The CI job is `continue-on-error` until it has.

**11. Templates by table:** templates take an optional comma-separated `tables` list (Settings, and `templates[].tables` in policy). The first match is applied once to a new `/snap` capture, and the editor names the template it applied.

---

## 6. Net new features

| # | Recommendation | Why | Status |
|---|---|---|---|
| 1 | **Smart redaction from the DOM** | A missed email address is the most likely privacy failure. | ✅ |
| 2 | **Step-by-step guide from a recording** | The core walkthrough use case; click highlights already knew where clicks happened. | ✅ |
| 3 | **Console + network capture for bug reports** | Developers need console errors and failed requests with the screenshot. | ✅ |
| 4 | Capture a single element | Faster and tidier than dragging a region. | ✅ |
| 5 | Multi-capture sessions | UAT runs produce 5–10 screenshots per defect. | ✅ |
| 6 | Pluggable issue-tracker destinations | Webhook, Jira and GitHub Issues through the adapter interface. | ✅ |
| 7 | ServiceNow work note on attach | Records show why files were attached. | ✅ |
| 8 | Captions and transcript for narrated recordings | Searchable, more accessible walkthroughs. | ◐ |
| 9 | Side panel library | Drag captures into a ticket or chat without switching tabs. | ✅ |
| 10 | Multi-viewport capture | Responsive pages (Service Portal). | ✅ |
| 11 | GIF export for short clips | Chat and ticket tools autoplay GIFs inline. | ✅ |
| 12 | Before/after compare | Verifying fixes in UAT. | ✅ |

### Implemented

**1. Smart redaction** (`src/shared/sensitive.js`, `src/content/sensitive-scan.js`, `capture.js`, `editor.js`, `canvas.js`)
- **Matching:** built-in patterns for email, phone, IPv4, cards (Luhn-checked) and tokens/keys (JWTs, well-known prefixes, long mixed-case strings, but not lower-case hex `sys_id`s), plus custom regular expressions. Overlapping matches keep the longest.
- **Scanning:** at capture time the scanner walks text nodes and form-field values in the page and in same-origin frames such as `gsft_main`. It returns only rectangles and kinds. Password fields are always suggested.
- **Mapping:** rectangles are mapped into image pixels for visible, region, element and both full-page methods, and for viewports.
- **Editor:** a banner offers *Redact all*, *Review one by one* (dashed outlines that are never exported; click one to redact it) and *Dismiss*. Saving off the device with unreviewed suggestions asks first.
- **Settings and policy:** *Settings → Screenshots*, and the `redactionPatterns` policy.
- **Known gap:** cross-origin frames can't be read.

**2. Guides** (`src/content/click-highlight.js`, `src/background/recording-control.js`, `src/shared/guide.js`, `video-editor.js`, `export/files.js`)
- **Recording clicks:** during tab recordings, each click's accessible name and role and its position as a fraction of the top window go to the worker. Names come from the ARIA label, field label, button caption or text, never a field's value, and sensitive-looking text in them is masked. Because the worker keeps them, they survive navigation, and overlays are now re-injected after the recorded tab navigates (they used to disappear).
- **Timing:** pause intervals are recorded, so clicks map to video time.
- **Generate guide:** *✦ Generate guide* makes one keyframe 150 ms before each click inside the trim, merges double clicks, and fills *Steps* ("Click “Resolve”", "Click the “Close notes” field"). The PDF marks each click point with its step number and captions the frame.
- **Not tested end to end:** real tab recordings need a gesture, so the e2e run injects clicks into a recording and checks the editor and PDF path.
- This stretches the "trim only" non-goal, but it uses only the existing keyframe pipeline.

**3. Console + network** (`src/background/devtools.js`, popup toggle)
- **Opt-in per tab:** this attaches the DevTools protocol (optional `debugger` permission), then buffers the last 100 console errors/warnings and exceptions and the last 100 failed requests. Failed requests are HTTP ≥ 400 or network errors, recorded with method, status, type and URL. URLs keep only parameter *names*, and bodies and headers are never read.
- **Captures:** captures of that tab (screenshots, `/snap` jobs and tab recordings) get a copy. It shows in the editor's Environment panel, the PDF (or a "nothing logged since …" line), the `.md`, and the `.json`. Screenshots now offer the `.md + .json` sidecar too.
- **Shared attachment:** `withDebugger()` reuses the attachment for the DevTools full-page method and viewport capture, since Chrome allows one attachment per tab.

**4. Element capture** (`src/content/element-select.js`)
- Available from the popup tile, the context menu, a `snap-element` command (no default key: Chrome allows four suggested shortcuts) and `/snap element`.
- Outlines the hovered element, including inside same-origin frames. <kbd>↑</kbd> / <kbd>↓</kbd> move to the parent or child, and the padding is configurable. The capture is taken after the picker is gone.

**5. Sessions** (`src/background/session.js`, `createSessionCapture`, editor session view, `ExportFactory.buildSession`)
- **Collecting:** start from the popup, the `session-toggle` command or `/snap session`. Screenshots and recordings join the session instead of opening the editor, and the badge shows `S<n>`.
- **Finishing:** *Finish* creates a `session` capture with a thumbnail grid. Its editor lists members to reorder, remove or open (with a *◀ Session* back link).
- **Exports:** the PDF has the shared context then a section per member (heading, description, notes, images or keyframes). Member PNGs and videos are numbered files, and the sidecar lists the members.
- **ServiceNow:** a `/snap session` attaches once to the record. Its in-page prompt hides after 6 s so it isn't in the screenshots.

**6. Trackers** (`src/storage/trackers.js`, `src/storage/issue-text.js`, *Settings → Issue trackers*)
- **Webhook:** a `multipart/form-data` POST with a `metadata` part and the files, plus an optional bearer token.
- **Jira:** `/rest/api/2`. Cloud uses email + API token (Basic); Server/DC uses a PAT (Bearer). It creates an issue (summary from the description, description converted from the sidecar Markdown to wiki markup), then attaches the files with `X-Atlassian-Token: no-check`.
- **GitHub:** creates an issue with the sidecar Markdown as its body. The REST API can't attach files to issues, so files are only uploaded when an *attachments branch* is set: they're committed under `snap/<name>/` and linked (images embedded). Otherwise the issue carries the context and any S3 links.
- **In the editor:** trackers appear only once configured, with a fixed *Issue* format. They save after S3 and before ServiceNow, so S3 links reach the issue and the issue link reaches the record's PDF and work note.
- **Permissions:** host access for every destination in the plan is asked for in one prompt from the Save click (`requestPlanOrigins`).
- **Credentials and policy:** tokens are local-only. Policy keys cover the URLs and project or repo, and `allowedDestinations` gains the three ids.
- **Tested against mocks only** (`tests/e2e/server.mjs`): no real Jira or GitHub instance was used.

**7. Work notes:** *Settings → ServiceNow* (or the `snWorkNote` policy) adds a `note` to the `snap:file` payload. After a successful upload, `/snap` PATCHes `work_notes` with the file names, the description and any S3 or issue links. Off by default.

**8. Captions (partial)** (`src/shared/captions.js`, `src/shared/recording.js`)
- **How it works:** when *Captions and transcript* is on and the mic is recording, `SpeechRecognition` runs with `processLocally = true` on the mic track, restarting after silence and skipping pauses. If on-device recognition isn't available, it doesn't fall back to the cloud: the recording gets a warning instead. *Settings → Recording* shows the model's status and has a *Download speech model* button.
- **Cue timing:** cues are timed from when each result arrives, with a word-count estimate (recognition gives no timestamps).
- **Exports:** a `.vtt` file in the sidecar (clipped and shifted to the trim), the transcript in the md, JSON and PDF, a transcript panel in the video editor (click a line to seek), and library search.
- **Not verified:** on-device recognition can't run in headless Chrome, and it depends on recent Chrome builds that support `processLocally` and `start(track)`. Only the cue, VTT and timing logic is tested.

**9. Side panel** (`src/sidepanel/`, `sidePanel` permission, popup *Side panel* button)
- Lists the last 20 captures and prepares each one's file ahead of time: the flattened, annotated PNG, or the video when it needs no re-render or the last render is current.
- A drag carries the real `File` (plus `DownloadURL` for desktop drops), and *Copy* puts it on the clipboard.
- **Not tested:** dragging into another site can't be driven headless. The e2e run checks the list renders.

**10. Viewports:** popup *Viewports* emulates each width in *Settings → Screenshots* (default 375 / 768 / 1280) through the DevTools protocol, captures it, scans it for suggestions, and groups the results as a session.

**11. GIF** (`src/editor/export/gif.js`)
- A dependency-free encoder: median-cut palette from sample frames, cached nearest-colour mapping, LZW, looping GIF89a. Frames are compressed as they're grabbed, so memory stays bounded.
- Frames are redacted and limited to the first 20 s of the export range, at the fps and width set in *Settings → Recording*.
- Offered for recordings in the editor, library, S3, ServiceNow and trackers. The unit test round-trips LZW through a reference decoder, and e2e checks that Chrome decodes the file.

**12. Compare** (`src/editor/compare.js`): library *Compare…* → pick two screenshots → *Side by side* or *Stacked*. Both images are flattened with their edits, scaled down (never up) to match, and labelled "Before" (older) and "After" with title and time. The result is a new screenshot capture that opens in the editor.

### Also fixed along the way

- Click and key overlays now come back after the recorded tab navigates.
- A remembered "Failed saves" library filter could hide every card once nothing was failing.
- `chrome.permissions.request` throws outside a user gesture, even for origins that are already granted. Saves and retries now fall back to `permissions.contains`.

---

## Verification

First pass (sections 1–4):

- `npm test`: 30/30 pass, including new `tests/settings.test.js` for palette normalization and the quality presets.
- `npm run test:e2e`: 39/39 pass, including new checks that `.` steps one frame and `Home` jumps to the trim start.
- A scratch headless-Chrome run (not committed) also exercised:
  - the theme switch, palette and defaults
  - resizing a box and a pen stroke, moving a stroke, and undo
  - zoom buttons, `Ctrl`+wheel and `Ctrl+0`
  - the help dialog, Copy, and remember-last-style
  - the keystroke overlay's password, typing and chord rules

Second pass (sections 5–6):

- `npm test`: 74/74 pass. New suites: `settings-storage`, `saves` (retry planning, limits, work notes, redelivery), `sensitive`, `gif`, `guide`, `captions`, `issue-text`, `capture-helpers` (scan mapping, compare layout, devtools sanitizing) and `i18n`, plus protocol limit tests.
- `npm run test:e2e`: 66/66 pass with no runtime errors, on Chrome 156 (macOS, headless). The 27 new checks cover:
  - suggested redaction found and accepted
  - element capture, GIF export, and guide generation with PDF captions
  - a `/snap session` with instance limits and a work note
  - Jira, GitHub and webhook (mocked), with the webhook failing once and then retried from the library, and diagnostics recorded
  - storage meter, compare, and viewports
  - console/network capture with URL sanitizing
  - side panel, options page (trackers, diagnostics, token chips) and popup localization
- **Not verified here:**
  - Edge, which isn't installed
  - the GitHub Actions workflow, which hasn't been pushed
  - real Jira or GitHub servers
  - on-device captions
  - real tab recordings, which need a gesture
  - drag and drop out of the side panel
