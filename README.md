# Snap Companion

A Chrome (Manifest V3) extension for screenshots and screen recordings. You can annotate and redact them, add context, and save them to local downloads, Amazon S3, Jira, GitHub Issues, a webhook, or the current ServiceNow record through an SN Utils `/snap` command. The design is in [`screen-thing.md`](screen-thing.md).

No build step: plain ES modules, no runtime dependencies. Load the folder as-is.

## Install (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
4. Pin **Snap Companion** from the puzzle-piece menu.

After code changes, click the reload icon on the extension card. Service-worker logs: click **Service worker** on the card.

## Using it

| Action | How |
| --- | --- |
| Screenshot visible area | <kbd>Alt+Shift+S</kbd>, toolbar popup, or right-click → *Snap visible area* |
| Delayed screenshot | Popup → *Delay* 3s / 5s / 10s, then a capture button. The badge counts down so you can open menus or hover first. |
| Screenshot region | <kbd>Alt+Shift+A</kbd>: drag a rectangle, <kbd>Esc</kbd> cancels |
| Screenshot an element | Popup → *Element* or right-click → *Snap element…*: hover, click. <kbd>↑</kbd> / <kbd>↓</kbd> widen to the parent or back. Works inside Classic UI's `gsft_main`. A shortcut can be assigned at `chrome://extensions/shortcuts`. |
| Several widths at once | Popup → *Viewports*: the page at each width in Settings → Screenshots (375 / 768 / 1280 px by default), as one report. Uses the DevTools protocol (asks for the `debugger` permission once). |
| Capture session | Popup → *Start session*: screenshots and recordings you take are collected (badge `S3` = three so far) instead of each opening the editor. *Finish* opens them as one report: reorder or drop captures, then save a single PDF (a section per capture) or the files. |
| Console & network log | Popup → *Include console errors & failed requests from this tab*. Captures of that tab then carry the tab's console errors/warnings and failed requests (status, method, URL without query values; no bodies or headers) in the PDF and sidecar. Chrome shows its "started debugging" bar while it's on. |
| Full page | Popup or context menu (scroll & stitch; DevTools method optional in Settings) |
| Record this tab | <kbd>Alt+Shift+R</kbd> to start/stop, or the popup. No picker. Tab audio keeps playing. |
| Record window / screen | Popup → *Window / screen*. This opens a small recorder window that shows Chrome's picker. |
| Pause / resume / stop | <kbd>Alt+Shift+P</kbd> pauses/resumes any recording; the popup has all three (badge shows `REC` / `II`). Chrome's *Stop sharing* bar also ends it. |
| Library | Popup → *Library*: captures kept in IndexedDB on this device, with a storage meter. Search (including transcripts), filter by kind/tag/"not saved"/"failed saves", re-export or **retry failed saves** from the ⋯ menu without opening the editor, and **Compare…** two screenshots side by side or stacked (the older one is "Before"). |
| Side panel | Popup → *Side panel*: recent captures beside the page. Drag one into a ticket, chat or email (screenshots go with their annotations and redactions), or *Copy*. |

The **editor** opens in a tab after each capture:

- **Tools:** select/move/resize `V`, crop `C`, arrow `A`, box `R`, ellipse `E`, pen `P`, text `T`, highlighter `H`, step markers `N`, blur/pixelate `B`. Undo with `Ctrl+Z`, redo with `Ctrl+Shift+Z`, delete with `Del`, save with `Ctrl+S`. Hold `Shift` to constrain shapes. Press `?` for the full list of shortcuts.
- **Resize:** with Select, drag a shape's handles. Boxes, ellipses, highlights, redactions and pen strokes have eight; arrows have one at each end; text has one at its corner, which changes the font size.
- **Zoom:** `Ctrl` + scroll (or pinch) zooms around the pointer, `Ctrl+=` / `Ctrl+−` step, and `Ctrl+0` or the *Fit* button toggles fit / 100%.
- **Copy:** the *Copy* button or `Ctrl+C` puts the annotated, cropped image on the clipboard.
- **Redaction** is applied to the pixels of the exported PNG/PDF, not drawn on top, so the hidden content can't be recovered.
- **Suggested redactions:** at capture time the page's text and form fields are scanned on the device for email addresses, phone numbers, IP addresses, card numbers, tokens/keys, password fields and your own patterns. The editor offers to *Redact all*, *Review one by one* (click an outlined area to redact it) or *Dismiss*. Nothing is hidden until you choose, and saving off the device with unreviewed suggestions asks first. Only rectangles are kept, never the matched text.
- **Context:** record URL, a one-line description (required for ServiceNow), steps to reproduce, notes, tags, and any extra fields defined in Settings (required ones must be filled before saving to S3 or ServiceNow). **Template ▾** pre-fills these from a template. Environment metadata (instance, table, record, browser, viewport, time, user) is filled in automatically.
- **Video:** `Space` plays/pauses, `,` / `.` step one frame, `←` / `→` seek 1 s (`Shift`: 5 s), and `Home` / `End` jump to the ends of the trim. Trim with the timeline handles or *Set start* / *Set end* (`[` / `]`). Add keyframes for the PDF report (*＋ Keyframe*, `K`, or *Auto keyframes*). For tab recordings, *✦ Generate guide* turns the clicks you made into numbered steps ("Click “Resolve”") and a keyframe just before each click, marked in the PDF. Narrated recordings with captions on get a transcript (click a line to seek) and a `.vtt` file in the sidecar. *Download GIF* makes a looping GIF of up to the first 20 s of the exported range. *Redact region* lets you drag boxes over the video that pixelate or blur from the current time; adjust each region's time range with *Start/End = now*. The player previews the redactions live. On export the video is re-encoded with the trim and redactions. That runs in real time and needs the tab visible; the result is cached until you change the edits.
- **Destinations:** tick any of *ServiceNow record*, *Jira*, *GitHub*, *Webhook* (once configured), *Amazon S3* and *Download*, and pick the formats for each (PNG, PDF report, video, GIF, `.md` + `.json` sidecar). They save in order: S3, webhook, Jira, GitHub, ServiceNow, Download. That way the S3 link can go into the issue and the PDF attached to the record, and the issue link into the record's PDF and work note. Failed saves can be retried from the library; a retry attaches to the issue created the first time.

## Settings worth knowing

Small settings sync between your Chrome profiles. Templates, custom fields and tracker tokens stay in this browser's local storage (sync caps each item at 8 KB, and tokens shouldn't roam).

- **Editor & appearance:** light / dark / system theme for every extension page; the default tool, color, stroke width and redaction style; whether the editor starts with the style you used last; and the color palette (up to 16 swatches).
- **Recording:** maximum resolution (720p, 1080p, 1440p or source), frame rate, and bitrate, with a file-size estimate. Recordings are only ever scaled down. *Show keyboard shortcuts and keys pressed* adds an on-page key overlay to tab recordings. It never shows password fields, and plain typing in a text box appears as "typing…". *Remember what I click* (on by default) keeps clicked elements' names and positions for guides, never typed values. *Captions and transcript* uses Chrome's on-device speech recognition only (with a *Download speech model* button); without it, nothing is recognised and no audio leaves the browser. GIF frame rate and width.
- **Screenshots:** element padding, viewport widths, and suggested redactions (which patterns, plus your own regular expressions).
- **Saving:** both file-name patterns show a live example, with chips that insert tokens at the cursor.
- **Issue trackers:** Jira (Cloud: site, email + API token; Server/Data Center: personal access token), GitHub Issues (repository, token, optional attachments branch: the API can't attach files to issues, so files are committed there and linked) and a webhook (`multipart/form-data` POST: a `metadata` JSON part plus each file). Chrome asks for access to each site on the first save.
- **About & diagnostics:** the last 100 errors, kept on this device. *Copy diagnostics* puts the version, browser, settings without tokens and those errors on the clipboard, with URLs cut to their origin and path.

## ServiceNow `/snap` command

1. In SN Utils, create a slash command `/snap` whose script is [`snutils/snap-command.js`](snutils/snap-command.js). Update it when you update the extension.
2. On a saved record, run `/snap`, `/snap region`, `/snap element`, `/snap fullpage`, `/snap session`, `/snap record-tab` or `/snap record-window`. With `session`, take captures with the usual shortcuts, then *Finish* from the toolbar popup to attach them as one report.
3. The editor opens with the record context filled in, and with a template applied if one names the record's table (Settings → Templates). Add a description and click **Save**. The page uploads the files to the record through `/api/now/attachment/file`, using its own `g_ck` session. The extension never handles ServiceNow credentials.

**Attachment limits.** When the user may read `sys_properties`, `/snap` reads `com.glide.attachment.max_size` and `glide.attachment.extensions` first. The editor shows them on the ServiceNow destination and refuses files the instance would reject (too large, or a blocked type such as `.webm`) with a hint to use S3 and the PDF instead, rather than failing after the upload.

**Retries and work notes.** If every file of a delivery fails, or the page doesn't answer within 5 minutes, the delivery can be retried from the editor or the library while the record stays open in its tab. With *Settings → ServiceNow → Add a work note* (or the `snWorkNote` policy), the page also posts a work note naming the files, the description and any S3 and issue links.

Without the extension installed, the command falls back to a page-only `getDisplayMedia` screenshot that is attached as a PNG.

**Shortcut prompt.** Chrome won't let an extension screenshot a tab without a user gesture unless it has access to every site (`<all_urls>`). A ServiceNow host permission is not enough; this was tested and answers design doc §20 Q1. So by default `/snap` shows a small in-page prompt: *"Press Alt+Shift+S (or click the Snap icon)…"*. To skip it, turn on **Settings → ServiceNow → One-step /snap screenshots**, which asks Chrome for all-site access. Tab recording always needs the shortcut or a click (a `tabCapture` rule).

**Custom domains:** add them under **Settings → ServiceNow instances**. Chrome asks for access to each host, and the content script is then registered for it automatically.

### Bridge protocol

Messages go over `window.postMessage(msg, location.origin)` with the envelope `{ ns: 'snap-companion', v: 1, type, requestId, payload }` (§11.3):

- Page → extension: `snap:request { mode, deliver, context }` (context may carry `limits: { maxBytes, allowedExtensions }`) and `snap:uploaded { results }`.
- Extension → page: `snap:accepted`, `snap:rejected`, `snap:file { files: [{ name, mimeType, blob }], note }`, `snap:cancelled` and `snap:error`. A non-empty `note` is posted as a work note after a successful upload.

Security checks (§11.4):

- Only messages from the page's own window and origin are accepted, and only on configured ServiceNow hosts.
- `context.instance` and `recordUrl` must match the page.
- Each `requestId` works once, and each delivery works once.
- The bridge iframe checks its parent origin before posting.
- Files only go to the frame that made the request.

How files reach the page:

- **Built-in hosts:** the hidden `bridge.html` iframe reads them from IndexedDB. The content script then re-posts them on the page's own origin, which is why `/snap` only ever trusts `location.origin`.
- **Custom-domain hosts:** `bridge.html` can't be web-accessible there, so the content script fetches the files over extension messaging in base64 chunks instead.

## Amazon S3 (presigned URLs)

The extension holds no AWS credentials. In **Settings → Amazon S3**, set a presign endpoint. Authentication is either *none* (cookies) or *OIDC* (implicit flow via `chrome.identity`; register the redirect URI shown in Settings).

```http
POST <presignEndpoint>
{ "fileName": "...", "contentType": "video/mp4", "size": 48211533,
  "context": { "instance": "...", "table": "...", "sysId": "...", "label": "...", "keyPrefix": "..." } }
```

The endpoint responds with one of:

```jsonc
{ "key": "...", "objectUrl": "https://...", "upload": { "type": "single", "url": "https://...", "headers": {} } }
{ "key": "...", "objectUrl": "https://...", "upload": { "type": "multipart", "uploadId": "...", "partSize": 8388608,
  "partUrls": ["https://...", "..."], "completeUrl": "https://.../complete" } }
```

For multipart uploads, the extension `PUT`s each part and retries up to 3 times with backoff. Completed parts are saved in IndexedDB, so a retried save resumes. Finally it sends `POST completeUrl { key, uploadId, parts: [{ PartNumber, ETag }] }`, a JSON body for your backend.

The bucket's CORS rules must allow `PUT` from `chrome-extension://<extension-id>` and must **expose `ETag`**. Presigned URLs are the only mode: a Cognito mode would mean bundling the AWS SDK, so it isn't offered.

## Managed policy

Admins can push `s3`, `snHosts`, `allowedDestinations` (now also `webhook`, `jira`, `github`), `forceRedactionReminder`, `recordingMaxMinutes`, `customFields`, `templates` (with `tables` to auto-apply), `redactionPatterns`, `snWorkNote`, `webhookUrl`, `jiraBaseUrl`, `jiraProjectKey`, `githubApiUrl` and `githubRepo` through Chrome enterprise policy ([`managed_schema.json`](managed_schema.json)). Managed values override user settings and show as locked in Settings. Tokens can't be pushed by policy: each user enters their own.

## Browser support

Chrome 116 or later. Edge (Chromium) is expected to work the same way, and CI runs the e2e suite against Edge stable as well as Chrome. The Edge job is informational until it has passed a number of runs: it hasn't been verified on a desktop Edge install yet, in particular `tabCapture` without a picker, the offscreen document and the `/snap` shortcut prompt. Report differences with Settings → About → *Copy diagnostics*.

## Localization

Messages live in [`_locales/en/messages.json`](_locales/en/messages.json); add `_locales/<lang>/messages.json` to translate. Pages mark text with `data-i18n` attributes and scripts use `t()` from `src/ui/i18n.js`. So far the manifest, context menus, popup, recorder window and side panel are converted. The editor, library and Settings page are still English-only. `tests/i18n.test.js` fails if a referenced key is missing.

## Tests

```sh
npm test          # unit: naming, bridge validation (+ limits), PDF writer, WebM duration patch, S3 part
                  # planner, templates, custom fields, library search, palette + recording quality,
                  # settings storage split + quotas, retry planning, attachment limits, work notes,
                  # sensitive-text patterns, GIF encoder (LZW round trip), guides, captions/VTT,
                  # issue text, devtools URL sanitizing, i18n keys
npm run test:e2e  # headless Chrome + mock ServiceNow over TLS: /snap → editor → suggested redaction →
                  # template/steps/tags/required field → annotate/redact → attach PDF + download PNG;
                  # replay/forgery rejection; full page; region; element; window recording → trim +
                  # timed redaction render, keyframe PDF, sidecar, GIF, generated guide; library
                  # search/tag filter/re-export; delayed capture; /snap session with instance limits
                  # and work note; Jira, GitHub and webhook (mocked) with a failed save retried from the
                  # library; compare; viewports; console/network capture; side panel; options; popup
node scripts/check-version.mjs v0.1.0   # release guard: tag = manifest = package.json
```

Set `SNAP_E2E_SHOTS=/some/dir` to save screenshots of the key screens. The e2e run needs Chrome and `openssl`. Set `CHROME=/path/to/chrome` to use a different binary (e.g. Edge) and `CHROME_ARGS` for extra flags (CI uses `--no-sandbox`). It loads the extension through CDP's `Extensions.loadUnpacked`, so no Playwright or Puppeteer is needed. Pass a section name (`bridge`, `fullpage`, `region`, `record`, `library`, `extras`) to run just that part.

Not covered end to end, because they need a real user gesture or hardware: the shortcut/popup gesture path, tab recording via `tabCapture` (so click tracking during a real recording), on-device captions, and drag and drop from the side panel. Their logic is unit-tested.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the unit tests and the e2e suite (Chrome, plus Edge as informational) on every push and pull request. Tags `v*` also check the version and publish `snap-companion.zip` to a GitHub release.

## Layout

```
manifest.json, managed_schema.json
src/background/   sw.js (entry), capture.js, recording-control.js, bridge.js, session.js, devtools.js,
                  offscreen-client.js, state.js, …
src/offscreen/    tab-recording host (MediaRecorder; chunks → IndexedDB every 1 s)
src/recorder/     window/screen recorder window (getDisplayMedia)
src/editor/       editor + library; canvas.js (annotation engine), redact.js, video-editor.js + video-tools.js
                  (trim, timed redaction, keyframes, re-encode), context-form.js, save-runner.js, compare.js,
                  export/pdf.js, export/files.js, export/gif.js
src/storage/      adapter.js (registry), download.js, s3.js, servicenow.js, trackers.js (webhook, Jira, GitHub)
src/content/      content.js (bridge relay), region-select.js, element-select.js, sensitive-scan.js, fullpage.js,
                  click-highlight.js (rings + guide clicks), keystrokes.js
src/sidepanel/    side-panel library (drag captures into other pages)
_locales/         messages for chrome.i18n
src/bridge/       bridge.html iframe (delivers Blobs to the SN page)
src/shared/       db.js (IndexedDB "snap"), settings.js, protocol.js, recording.js, captures.js, sensitive.js,
                  guide.js, captions.js, saves.js, diagnostics.js, …
snutils/          snap-command.js: the /snap script command
```

## Differences from the design doc

- **No build tooling.** The doc assumed TypeScript, Vite, Svelte, Konva, `idb`, `pdf-lib` and `fix-webm-duration`. This build uses plain JS modules instead: a small canvas annotation engine, an in-house PDF writer and an EBML duration patcher. That keeps it loadable unpacked with nothing to bundle.
- **`all_frames: true`** for the content script, so `/snap` also works when SN Utils runs inside Classic UI's `gsft_main` iframe.
- **Fixed/sticky elements are hidden** (`visibility: hidden`) rather than set to `position: static` while stitching full pages. This avoids reflowing the page mid-capture.
- **Optional `<all_urls>`** for one-step `/snap` screenshots (see above).
- **Video edits are re-encoded in real time** (play through a canvas + MediaRecorder) rather than using WebCodecs or ffmpeg.wasm. A 40 s range takes about 40 s to render, but there are no codec libraries to bundle. Trim points are frame-accurate, not keyframe-snapped.
- **Templates** are context templates (description, notes, steps, tags), editable in Settings or pushed by policy.
- **Store listing / data handling statement:** see [`STORE_LISTING.md`](STORE_LISTING.md).
- **Not built:** Cognito S3 mode (it would need the AWS SDK); it was removed from Settings and the policy schema.
