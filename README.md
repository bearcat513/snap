# Snap Companion

A Chrome (Manifest V3) extension for screenshots and screen recordings. You can annotate and redact them, add context, and save them to local downloads, Amazon S3, or the current ServiceNow record through an SN Utils `/snap` command. The design is in [`screen-thing.md`](screen-thing.md).

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
| Full page | Popup or context menu (scroll & stitch; DevTools method optional in Settings) |
| Record this tab | <kbd>Alt+Shift+R</kbd> to start/stop, or the popup. No picker. Tab audio keeps playing. |
| Record window / screen | Popup → *Window / screen*. This opens a small recorder window that shows Chrome's picker. |
| Pause / resume / stop | Popup while recording (badge shows `REC` / `II`). Chrome's *Stop sharing* bar also ends it. |
| Library | Popup → *Library*: captures kept in IndexedDB on this device. Search, filter by kind/tag/"not saved", and re-export from the ⋯ menu without opening the editor. |

The **editor** opens in a tab after each capture:

- **Tools:** select/move `V`, crop `C`, arrow `A`, box `R`, ellipse `E`, text `T`, highlighter `H`, step markers `N`, blur/pixelate `B`. Undo with `Ctrl+Z`, redo with `Ctrl+Shift+Z`, delete with `Del`, save with `Ctrl+S`. Hold `Shift` to constrain shapes.
- **Redaction** is applied to the pixels of the exported PNG/PDF, not drawn on top, so the hidden content can't be recovered.
- **Context:** record URL, a one-line description (required for ServiceNow), steps to reproduce, notes, tags, and any extra fields defined in Settings (required ones must be filled before saving to S3 or ServiceNow). **Template ▾** pre-fills these from a template. Environment metadata (instance, table, record, browser, viewport, time, user) is filled in automatically.
- **Video:** trim with the timeline handles or *Set start* / *Set end* (`[` / `]`). Add keyframes for the PDF report (*＋ Keyframe*, `K`, or *Auto keyframes*). *Redact region* lets you drag boxes over the video that pixelate or blur from the current time; adjust each region's time range with *Start/End = now*. The player previews the redactions live. On export the video is re-encoded with the trim and redactions. That runs in real time and needs the tab visible; the result is cached until you change the edits.
- **Destinations:** tick any of *ServiceNow record*, *Amazon S3* and *Download*, and pick the formats for each (PNG, PDF report, video, `.md` + `.json` sidecar). They save in order: S3 first, then ServiceNow, then Download. That way the S3 link can go into the PDF attached to the record (hybrid mode).

## ServiceNow `/snap` command

1. In SN Utils, create a slash command `/snap` whose script is [`snutils/snap-command.js`](snutils/snap-command.js).
2. On a saved record, run `/snap`, `/snap region`, `/snap fullpage`, `/snap record-tab` or `/snap record-window`.
3. The editor opens with the record context filled in. Add a description and click **Save**. The page uploads the files to the record through `/api/now/attachment/file`, using its own `g_ck` session. The extension never handles ServiceNow credentials.

Without the extension installed, the command falls back to a page-only `getDisplayMedia` screenshot that is attached as a PNG.

**Shortcut prompt.** Chrome won't let an extension screenshot a tab without a user gesture unless it has access to every site (`<all_urls>`). A ServiceNow host permission is not enough; this was tested and answers design doc §20 Q1. So by default `/snap` shows a small in-page prompt: *"Press Alt+Shift+S (or click the Snap icon)…"*. To skip it, turn on **Settings → ServiceNow → One-step /snap screenshots**, which asks Chrome for all-site access. Tab recording always needs the shortcut or a click (a `tabCapture` rule).

**Custom domains:** add them under **Settings → ServiceNow instances**. Chrome asks for access to each host, and the content script is then registered for it automatically.

### Bridge protocol

Messages go over `window.postMessage(msg, location.origin)` with the envelope `{ ns: 'snap-companion', v: 1, type, requestId, payload }` (§11.3):

- Page → extension: `snap:request { mode, deliver, context }` and `snap:uploaded { results }`.
- Extension → page: `snap:accepted`, `snap:rejected`, `snap:file { files: [{ name, mimeType, blob }] }`, `snap:cancelled` and `snap:error`.

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

The bucket's CORS rules must allow `PUT` from `chrome-extension://<extension-id>` and must **expose `ETag`**. Cognito mode is shown in the schema but not implemented, because it would mean bundling the AWS SDK.

## Managed policy

Admins can push `s3`, `snHosts`, `allowedDestinations`, `forceRedactionReminder`, `recordingMaxMinutes`, `customFields` and `templates` through Chrome enterprise policy ([`managed_schema.json`](managed_schema.json)). Managed values override user settings and show as locked in Settings.

## Tests

```sh
npm test          # unit: naming, bridge validation, PDF writer, WebM duration patch, S3 part planner,
                  # templates, custom fields, library search
npm run test:e2e  # headless Chrome + mock ServiceNow over TLS: /snap → editor → template/steps/tags/
                  # required field → annotate/redact → attach PDF + download PNG; replay/forgery rejection;
                  # full page; region; window recording → trim + timed redaction render, keyframe PDF,
                  # sidecar; library search/tag filter/re-export; delayed capture
```

Set `SNAP_E2E_SHOTS=/some/dir` to save screenshots of the key screens. The e2e run needs Chrome and `openssl`. Set `CHROME=/path/to/chrome` to use a different binary. It loads the extension through CDP's `Extensions.loadUnpacked`, so no Playwright or Puppeteer is needed.

## Layout

```
manifest.json, managed_schema.json
src/background/   sw.js (entry), capture.js, recording-control.js, bridge.js, offscreen-client.js, state.js, …
src/offscreen/    tab-recording host (MediaRecorder; chunks → IndexedDB every 1 s)
src/recorder/     window/screen recorder window (getDisplayMedia)
src/editor/       editor + library; canvas.js (annotation engine), redact.js, video-editor.js + video-tools.js
                  (trim, timed redaction, keyframes, re-encode), context-form.js, export/pdf.js, export/files.js
src/storage/      adapter.js (registry), download.js, s3.js, servicenow.js
src/content/      content.js (bridge relay), region-select.js, fullpage.js, click-highlight.js
src/bridge/       bridge.html iframe (delivers Blobs to the SN page)
src/shared/       db.js (IndexedDB "snap"), settings.js, protocol.js, recording.js, captures.js, …
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
- **Not built:** Cognito S3 mode (needs the AWS SDK).
