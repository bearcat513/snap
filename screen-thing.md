# Snap Companion — Design Document

> Working name. A Chrome (Manifest V3) extension for capturing screenshots and screen recordings, annotating them with context, and saving them to local downloads, Amazon S3, or the current ServiceNow record via an SN Utils slash command.

| | |
| --- | --- |
| **Status** | Draft |
| **Target browsers** | Chrome and Chromium-based browsers (Edge, Brave, Arc) — Manifest V3 |
| **Related** | SN Utils `/snap` script command (page-only fallback implementation) |

---

## 1. Overview

ServiceNow work constantly involves evidence: a broken form, a failing catalog item, a UAT finding, a walkthrough for a story. Today that means a separate screenshot tool, manual cropping, a file on disk, and a manual attach to the record — and the context ("what was I doing, what did I expect") lives somewhere else or nowhere.

Snap Companion is a standalone capture tool that also plugs into ServiceNow:

- **Standalone:** capture screenshots (visible, region, full page) and recordings (tab, window, screen), annotate them in a proper editor, add structured context, and save to disk or S3.
- **ServiceNow-aware:** an SN Utils script command (`/snap`) asks the extension to capture, pre-fills the context from the current record, and attaches the result (image, PDF report, or video) to that record.

The existing page-only `/snap` script remains the fallback when the extension isn't installed.

## 2. Goals and non-goals

### Goals

1. One-keystroke screenshots with no browser share prompt.
2. Tab, window, and full-screen recording with optional microphone narration.
3. An editor for annotation and **redaction** (blur/pixelate) plus structured context fields.
4. Pluggable storage: local download, S3, ServiceNow attachment — more than one per save.
5. A small, documented bridge so an SN Utils script command can drive a capture and receive the result.
6. Captures stay on the device unless the user explicitly chooses a destination.

### Non-goals (v1)

- Cloud-hosted capture library or sharing links (S3 covers storage; sharing is the bucket owner's concern).
- Video editing beyond trimming (no cuts, transitions, captions).
- Firefox/Safari support.
- Writing to ServiceNow tables other than attachments (no automatic work notes, incidents, or stories — those can be added to the SN Utils script later).

## 3. Users and key scenarios

| Persona | Scenario |
| --- | --- |
| **Developer / admin** | On an incident form, runs `/snap`, draws a box around a broken field, adds "Expected: read-only after Resolve", attaches as PDF to the record. |
| **Tester (UAT)** | Records a 40-second tab walkthrough of a catalog item failing, adds steps to reproduce, saves the video to S3 and a summary PDF with the S3 link to the defect record. |
| **Anyone** | Presses the hotkey on any site, crops a region, redacts an email address, downloads a PNG. |
| **Team lead** | Pushes a managed configuration (S3 endpoint, allowed instances, default file naming) to the whole team via enterprise policy. |

## 4. Feature summary

| Area | v1 (MVP) | Later |
| --- | --- | --- |
| Screenshot | Visible area, region | Full page (scroll-stitch / debugger), delayed capture |
| Recording | — | Tab, window, screen, mic, countdown, pause/resume, click highlights |
| Editor | Crop, arrow, rectangle, text, highlighter, step numbers, blur/pixelate, undo/redo | Video trim, keyframe extraction, templates |
| Context | Record URL, description, notes, auto environment metadata | Steps-to-reproduce list, tags, custom fields from settings |
| Export | PNG, PDF report | Video + sidecar `.md`/`.json`, PDF with video keyframes |
| Storage | Download, ServiceNow attachment | S3 (presigned / multipart), hybrid S3 + ServiceNow |
| Library | Last 20 captures in IndexedDB | Search, tags, re-export, retention settings |
| Admin | — | Managed storage policy |

## 5. Architecture

```
┌──────────────────────────── Snap Companion (MV3) ───────────────────────────┐
│                                                                             │
│  Entry points                                                               │
│   • Toolbar popup        • Keyboard commands      • Context menu            │
│   • Bridge request from a ServiceNow page (via content script)              │
│                │                                                            │
│                ▼                                                            │
│  Service worker  (background/sw.ts)                                         │
│   • Job orchestrator (state machine per capture job)                        │
│   • Capture: captureVisibleTab, tabCapture stream IDs                       │
│   • Owns the offscreen document lifecycle                                   │
│   • Routes exports to storage adapters                                      │
│                │                          │                                 │
│                ▼                          ▼                                 │
│  Offscreen document                 Editor page  (editor.html, a tab)       │
│   • getUserMedia / MediaRecorder     • Canvas annotation (Konva)            │
│   • Image stitching / encoding       • Context form                         │
│   • Writes blobs to IndexedDB        • Export (PNG / PDF / video bundle)    │
│                │                          │                                 │
│                └──────────┬───────────────┘                                 │
│                           ▼                                                 │
│                 IndexedDB "snap" database                                   │
│                 (captures, blobs, job state)                                │
│                           ▼                                                 │
│        Storage adapters:  Download │ S3 │ ServiceNow (via bridge)           │
│                                                                             │
│  Content script (*.service-now.com)  ◄──►  Bridge iframe (bridge.html)      │
└─────────────────────────────────▲───────────────────────────────────────────┘
                                  │ window.postMessage
                     SN Utils /snap script command (page context)
```

### 5.1 Components

| Component | Runs in | Responsibilities |
| --- | --- | --- |
| **Service worker** | Extension background | Entry-point handling, job state machine, screenshot capture, obtaining tab-capture stream IDs, creating/closing the offscreen document, invoking storage adapters, badge state. Must stay stateless across restarts — job state is persisted in IndexedDB. |
| **Offscreen document** | Hidden extension page | Holds `MediaStream`s and `MediaRecorder` (service workers can't), stitches full-page tiles, encodes JPEG/PNG. Created with reasons `USER_MEDIA` / `DISPLAY_MEDIA` / `BLOBS`. |
| **Editor** | Extension tab | Annotation canvas, video preview and trim, context form, export and destination selection. |
| **Popup** | Extension action | Capture mode buttons, recording controls, recent captures, settings link. |
| **Options page** | Extension tab | Destinations, S3 configuration, file naming, hotkeys reference, retention. |
| **Content script** | ServiceNow pages | Announces the extension, validates and relays bridge requests, injects the bridge iframe, region-select overlay, recording click-highlights. |
| **Bridge iframe** | Extension origin, embedded in ServiceNow page | Reads finished blobs from IndexedDB and `postMessage`s them to the ServiceNow page (Blobs can't travel over extension messaging). |

### 5.2 Why each piece exists

- **MV3 service workers can't hold media streams or DOM**, so recording and canvas work happen in the offscreen document.
- **`chrome.runtime` messages are JSON-serialized**, so binary data never travels over them. All blobs go into IndexedDB (shared by every extension-origin page) and are referenced by ID.
- **Content scripts can't read the extension's IndexedDB** (they run in the page's origin). The bridge iframe runs in the extension origin, can read it, and can `postMessage` a Blob to the parent page using structured clone.
- **The ServiceNow upload runs in the page**, using the page's session token (`g_ck`). The extension never handles ServiceNow sessions, cookies, or credentials.

## 6. Capture

### 6.1 Screenshot — visible area

```ts
const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
```

- No prompt. Requires `activeTab` (granted when the user clicks the action, uses a keyboard command, or the context menu) or a host permission for the page.
- Rate-limited by Chrome (`MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND`, currently 2) — relevant for full-page stitching.
- Output is device-pixel resolution; store `devicePixelRatio` with the capture for correct annotation scaling.

### 6.2 Screenshot — region

1. Service worker captures the visible tab immediately (so the overlay isn't in the image).
2. Content script shows a full-viewport overlay with the frozen screenshot as background; user drags a rectangle. `Esc` cancels.
3. Crop is applied in the offscreen document (or editor), scaled by `devicePixelRatio`.

### 6.3 Screenshot — full page (later)

Two strategies, chosen in settings:

| Strategy | How | Pros | Cons |
| --- | --- | --- | --- |
| **Scroll & stitch** | Content script scrolls the scroll container step by step; service worker captures each viewport (respecting rate limit); offscreen stitches. | No extra permission | Sticky headers repeat; lazy content; slow. Classic UI scrolls inside the `gsft_main` iframe, so the scroller must be detected per page. |
| **DevTools protocol** | `chrome.debugger.attach` → `Page.captureScreenshot { captureBeyondViewport: true }` | Accurate, fast | `debugger` permission (alarming to reviewers); Chrome shows a "started debugging" banner. |

Recommendation: scroll & stitch by default, with sticky-element hiding (temporarily set `position: static` on fixed/sticky elements after the first tile).

### 6.4 Recording — tab

```ts
// service worker (must be triggered from a user gesture on the extension)
const streamId = await chrome.tabs.tabCapture
  ? await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id })
  : undefined;
await ensureOffscreen(['USER_MEDIA']);
chrome.runtime.sendMessage({ target: 'offscreen', type: 'record:start', streamId, opts });
```

```ts
// offscreen document
const stream = await navigator.mediaDevices.getUserMedia({
  audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
  video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId,
                        maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30 } }
} as any);

// Tab audio is muted for the user while captured — route it back to the speakers.
const ctx = new AudioContext();
ctx.createMediaStreamSource(stream).connect(ctx.destination);

const recorder = new MediaRecorder(stream, { mimeType: pickMimeType(), videoBitsPerSecond: 2_500_000 });
recorder.ondataavailable = e => appendChunkToIndexedDB(jobId, e.data);
recorder.start(1000); // 1s chunks: limits memory and survives crashes
```

- **No picker** for tab capture.
- **Tab audio gotcha:** captured tab audio is silenced for the user unless re-routed to `AudioContext.destination` (above).
- **User-gesture requirement:** `tabCapture` needs the extension to have been invoked on that tab (action click, command, context menu). A request arriving over the SN Utils bridge is *not* such a gesture — see §9.6.

### 6.5 Recording — window / entire screen

Started from a visible extension page (popup or a small "recorder" window) using `navigator.mediaDevices.getDisplayMedia()` (or `chrome.desktopCapture.chooseDesktopMedia` + `getUserMedia`). Chrome's picker is always shown — this is a browser security guarantee and can't be bypassed.

### 6.6 Recording options

| Option | Notes |
| --- | --- |
| Microphone | Mixed into the recording via `AudioContext` (mic + tab/system audio → one `MediaStreamDestination`). Mic permission must be granted once from a visible extension page (e.g. Options → "Enable microphone"), since offscreen documents can't show permission prompts. |
| Countdown | 3-2-1 overlay via content script (tab mode) or recorder window. |
| Pause / resume | `MediaRecorder.pause()/resume()`; badge shows `II`. |
| Max duration | Configurable cap (default 10 min) to protect storage and attachment limits. |
| Click highlights | Content script draws a fading ring at click points (tab mode only). |
| Stop | Toolbar click, hotkey, Chrome's "Stop sharing" bar (`track.onended`), or tab close. |

### 6.7 Formats

`pickMimeType()` prefers, in order: `video/mp4;codecs=avc1,mp4a` (supported by recent Chrome `MediaRecorder` — check with `MediaRecorder.isTypeSupported`), then `video/webm;codecs=vp9,opus`, then `video/webm`. MP4 is friendlier for ServiceNow users opening attachments; WebM is the reliable fallback. Transcoding (ffmpeg.wasm, ~25 MB) is out of scope for v1.

WebM files produced by `MediaRecorder` lack duration metadata, so seeking is poor in some players. Fix during export with a small EBML duration-patching step (e.g. `fix-webm-duration`).

## 7. Editor

Opened as an extension tab: `editor.html?capture=<id>[&job=<jobId>]`.

### 7.1 Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ ◀ Library   Untitled capture ✎             [Export ▾] [Save]         │
├────────┬─────────────────────────────────────────────┬───────────────┤
│ Tools  │                                             │ Context       │
│ ▢ crop │                                             │ Record URL    │
│ ↗ arrow│            Canvas / video preview           │ Description   │
│ ▭ box  │                                             │ Notes         │
│ T text │                                             │ Steps         │
│ ▮ high │                                             │ Tags          │
│ ① step │                                             │───────────────│
│ ▒ blur │                                             │ Destinations  │
│ ↶ ↷    │                                             │ ☑ Record      │
│        │                                             │ ☐ S3          │
│        │      [video: ▶ ──●────────── 00:12 / 00:40] │ ☐ Download    │
└────────┴─────────────────────────────────────────────┴───────────────┘
```

### 7.2 Image tools

| Tool | Behavior |
| --- | --- |
| Crop | Non-destructive; stored as a rect, applied at export. |
| Arrow, rectangle, ellipse | Stroke color/width presets; shift to constrain. |
| Text | Callout with background for legibility. |
| Highlighter | Semi-transparent rectangle (multiply blend). |
| Step markers | Auto-numbered circles ①②③; numbers re-flow when one is deleted. |
| **Blur / pixelate** | Applied to the underlying pixels at export (not an overlay) so redacted data can't be recovered from the output. |
| Undo / redo | Command stack; `Ctrl+Z` / `Ctrl+Shift+Z`. |

Annotations are stored as a JSON document (`AnnotationDoc`, §10) so captures can be re-edited from the library. Canvas library: **Konva** (layers, transforms, hit testing, small footprint). Fabric.js is an acceptable alternative.

### 7.3 Video tools

- v1: preview, title, context, poster frame selection.
- Later: in/out trim (WebCodecs re-mux, or ffmpeg.wasm), extract keyframes into the PDF report, blur regions over a time range.

### 7.4 Context fields

| Field | Source / default |
| --- | --- |
| Record URL | Pre-filled from the bridge request (`{origin}/{table}.do?sys_id={sysId}`) or the captured tab's URL |
| Description | One line; required when saving to ServiceNow |
| Notes | Free text, multi-line |
| Steps to reproduce | Ordered list (later) |
| Tags | Free tags (later) |
| Environment (auto, read-only) | Instance host, table, record label, browser + version, viewport size, capture timestamp, captured-by (from bridge) |

## 8. Export formats

| Format | Contents | Typical destination |
| --- | --- | --- |
| **PNG** | Flattened annotated image | Download, S3, record |
| **PDF report** | Title, environment line, context fields, annotated screenshot (or video keyframes). Built without external libraries — port the generator from the `/snap` script, or use `pdf-lib` bundled in the extension. | Record (default), download |
| **Video** | MP4/WebM as recorded (trimmed later) | S3 (default), download, record (size permitting) |
| **Sidecar** | `<name>.md` and/or `<name>.json` with context + environment | Alongside video in S3/download |

File naming pattern (configurable): `{table}_{label}_{yyyyMMdd-HHmmss}.{ext}` → `incident_INC0012345_20261023-141502.pdf`. Unsafe characters replaced with `_`.

## 9. Storage adapters

All adapters implement one interface, so new destinations (Google Drive, SharePoint, Jira) slot in without editor changes.

```ts
interface StorageAdapter {
  id: 'download' | 's3' | 'servicenow' | string;
  label: string;
  isAvailable(ctx: SaveContext): Promise<boolean>;      // e.g. S3 configured, bridge present
  save(file: ExportFile, ctx: SaveContext,
       onProgress?: (p: number) => void): Promise<SaveResult>;
}

interface ExportFile { name: string; mimeType: string; blobId: string; size: number; }
interface SaveResult { adapter: string; ok: boolean; location?: string; error?: string; }
```

Saves to multiple destinations run sequentially in a defined order — **S3 first, then ServiceNow** — so the S3 URL is available to include in the ServiceNow PDF (hybrid mode).

### 9.1 Download

```ts
const url = await blobUrlFromOffscreen(blobId); // object URL created in an extension page
await chrome.downloads.download({ url, filename: `${settings.downloadSubfolder}/${file.name}`,
                                  saveAs: settings.askWhereToSave });
```

### 9.2 Amazon S3

**Rule: no long-lived AWS credentials in the extension.** Extension packages are trivially unpacked.

Supported auth modes:

| Mode | How it works | When to use |
| --- | --- | --- |
| **Presigned URL service** (recommended) | Extension calls your endpoint (e.g. API Gateway + Lambda behind SSO/OIDC) with file name, type, size and context. Endpoint returns a presigned `PUT` URL (or multipart set). Extension uploads directly to S3. | Teams; central control of key naming, size limits, retention |
| **Cognito identity pool** | User signs in (via `chrome.identity.launchWebAuthFlow`); Cognito issues short-lived scoped credentials; extension uses the AWS SDK v3 to upload. | No backend desired; AWS-centric orgs |

**Presign request/response (contract for the backend):**

```http
POST /presign
Authorization: Bearer <user token>
Content-Type: application/json

{ "fileName": "incident_INC0012345_20261023-141502.mp4",
  "contentType": "video/mp4", "size": 48211533,
  "context": { "instance": "acme.service-now.com", "table": "incident", "sysId": "…" } }
```

```json
{ "key": "captures/acme/incident/INC0012345/20261023-141502.mp4",
  "upload": { "type": "multipart", "uploadId": "…", "partSize": 8388608,
              "partUrls": ["https://…", "…"], "completeUrl": "https://…/complete" },
  "objectUrl": "https://captures.example.com/captures/acme/…/20261023-141502.mp4" }
```

- Single `PUT` for files under ~16 MB; **multipart** above that (parts ≥ 5 MiB except the last), with per-part retry and resumable progress stored in IndexedDB.
- **Bucket CORS** must allow `PUT` from `chrome-extension://<extension-id>` and **expose the `ETag` header** (needed to complete multipart uploads).
- Recommended bucket settings: block public access, SSE-S3 or SSE-KMS, lifecycle rule for retention, object tags from context (`table`, `instance`).
- `objectUrl` should point at something access-controlled (CloudFront with signed cookies, or an internal viewer) — not a public object.

### 9.3 ServiceNow attachment

Performed by the **page**, not the extension (§11). The adapter's job is to hand the file to the bridge and wait for the page's result.

- Endpoint used by the page: `POST /api/now/attachment/file?table_name=…&table_sys_id=…&file_name=…` with header `X-UserToken: g_ck`.
- Instance limits to respect and surface clearly:
  - Max attachment size (`com.glide.attachment.max_size`, in MB).
  - Allowed/blocked extensions (`glide.attachment.extensions` and related properties) — `.webm` is commonly not on allow-lists; MP4 or the PDF report is safer.
  - User needs write access / attach rights on the record.
- **Hybrid mode:** video → S3, PDF report (with S3 link and keyframe) → record. Recommended default for recordings; keeps large binaries out of the instance database.

## 10. Data model (IndexedDB `snap`, version 1)

```ts
// store: captures (keyPath: id)
interface Capture {
  id: string;                    // uuid
  kind: 'screenshot' | 'recording';
  createdAt: string;             // ISO
  title: string;
  source: { url: string; title: string; tabId?: number; dpr: number;
            width: number; height: number; durationMs?: number; mimeType: string };
  originalBlobId: string;
  thumbnailBlobId: string;
  annotations?: AnnotationDoc;   // screenshots
  trim?: { startMs: number; endMs: number };
  context: CaptureContext;
  servicenow?: SnContext;        // present when started from the bridge
  saves: SaveResult[];           // history of where it went
}

interface CaptureContext { recordUrl?: string; description?: string; notes?: string;
                           steps?: string[]; tags?: string[] }
interface SnContext { instance: string; table: string; sysId: string; label: string;
                      user?: string; requestId: string }

interface AnnotationDoc { version: 1; crop?: Rect;
  shapes: Array<{ id: string; type: 'arrow'|'rect'|'ellipse'|'text'|'highlight'|'step'|'blur';
                  props: Record<string, unknown> }> }

// store: blobs (keyPath: id) — { id, blob: Blob, size, mimeType }
// store: chunks (keyPath: [jobId, seq]) — recording chunks while in progress
// store: jobs (keyPath: id) — orchestrator state, survives service-worker restarts
```

Retention: keep the last *N* captures (default 20) or *X* MB (default 1 GB); oldest unsaved-to-anywhere captures are never auto-deleted without a warning badge. Requires `unlimitedStorage`.

## 11. SN Utils integration (the bridge)

### 11.1 Flow

```
SN page (/snap script)          Content script              Service worker          Editor / Bridge iframe
        │  detect data-snap-companion │                             │                         │
        │── snap:request ────────────►│ validate origin + schema     │                         │
        │                             │── bridge.request ──────────►│ create job, capture     │
        │◄─ snap:accepted ────────────│                             │── open editor ─────────►│
        │                             │                             │      user edits, picks  │
        │                             │                             │◄─ save (servicenow) ────│
        │                             │◄─ bridge.deliver(jobId) ────│                         │
        │                             │ inject bridge.html?job=…    │                         │
        │◄──────────── snap:file { requestId, files: [Blob…] } ─────────────── (iframe) ──────│
        │ upload via Attachment API   │                             │                         │
        │── snap:uploaded { results } ►│── bridge.result ───────────►│ record SaveResult      │
        │                             │                             │── notify editor ───────►│
```

### 11.2 Detection

The content script (on configured ServiceNow hosts) sets:

```js
document.documentElement.dataset.snapCompanion = '1.0'; // protocol version
```

### 11.3 Message protocol (page ↔ content script / bridge)

All messages are `window.postMessage(msg, location.origin)` with this envelope:

```ts
interface BridgeMessage {
  ns: 'snap-companion';
  v: 1;
  type: 'snap:request' | 'snap:accepted' | 'snap:rejected' | 'snap:file'
      | 'snap:uploaded' | 'snap:cancelled' | 'snap:error';
  requestId: string;           // uuid generated by the page
  payload?: unknown;
}
```

**`snap:request`** (page → extension)

```json
{
  "mode": "screenshot | region | fullpage | record-tab | record-window",
  "deliver": ["pdf"],
  "context": {
    "instance": "acme.service-now.com",
    "table": "incident",
    "sysId": "9d385017c611228701d22104cc95c371",
    "label": "INC0012345",
    "recordUrl": "https://acme.service-now.com/incident.do?sys_id=…",
    "user": "jdoe"
  }
}
```

`deliver` lists formats the page wants back for attaching (`png`, `pdf`, `video`). The user can still change destinations in the editor.

**`snap:file`** (bridge iframe → page): `payload: { files: Array<{ name, mimeType, blob: Blob }> }` — Blobs travel by structured clone.

**`snap:uploaded`** (page → extension): `payload: { results: Array<{ name, ok, sysId?, error? }> }`.

### 11.4 Bridge security

- Content script accepts messages only where `event.source === window`, `event.origin === location.origin`, `ns`/`v` match, and the host is in the configured ServiceNow host list.
- Each `requestId` is single-use; the bridge iframe only delivers files for a job created from that tab's `requestId` and only via `postMessage(…, '<exact SN origin>')`.
- The extension never sends a file to a page that didn't originate the request, and never captures without a visible user action (the request triggers the editor/region UI, not a silent capture-and-return).
- `web_accessible_resources` exposes `bridge.html` only to the configured ServiceNow match patterns.

### 11.5 Updated `/snap` script command (page side)

The command detects the extension and falls back to the existing `getDisplayMedia` implementation.

```js
(function () {
  var table = '$table', sysId = '$sysid';
  if (!table || !/^[0-9a-f]{32}$/.test(sysId)) return alert('Open a saved record first.');
  var token = window.g_ck || (window.top && window.top.g_ck);
  var mode = (String.raw`$0`.trim() || 'screenshot');   // /snap region, /snap record-tab …

  if (!document.documentElement.dataset.snapCompanion) {
    return runFallbackSnap();                             // existing page-only implementation
  }

  var requestId = crypto.randomUUID();
  function send(type, payload) {
    window.postMessage({ ns: 'snap-companion', v: 1, type: type, requestId: requestId, payload: payload }, location.origin);
  }

  window.addEventListener('message', function onMsg(e) {
    var m = e.data;
    if (e.origin !== location.origin || !m || m.ns !== 'snap-companion' || m.requestId !== requestId) return;
    if (m.type === 'snap:file') {
      Promise.all(m.payload.files.map(function (f) {
        return fetch('/api/now/attachment/file?table_name=' + encodeURIComponent(table) +
          '&table_sys_id=' + sysId + '&file_name=' + encodeURIComponent(f.name), {
          method: 'POST', credentials: 'same-origin',
          headers: { 'X-UserToken': token, 'Content-Type': f.mimeType, 'Accept': 'application/json' },
          body: f.blob
        }).then(function (r) {
          return r.ok ? r.json().then(function (j) { return { name: f.name, ok: true, sysId: j.result.sys_id }; })
                      : { name: f.name, ok: false, error: 'HTTP ' + r.status };
        });
      })).then(function (results) {
        send('snap:uploaded', { results: results });
        window.removeEventListener('message', onMsg);
      });
    }
    if (m.type === 'snap:cancelled' || m.type === 'snap:error' || m.type === 'snap:rejected') {
      window.removeEventListener('message', onMsg);
      if (m.type !== 'snap:cancelled') alert('Snap Companion: ' + ((m.payload && m.payload.message) || m.type));
    }
  });

  send('snap:request', {
    mode: mode,
    deliver: mode.indexOf('record') === 0 ? ['pdf', 'video'] : ['pdf'],
    context: {
      instance: location.host, table: table, sysId: sysId,
      label: (window.g_form && g_form.getValue && g_form.getValue('number')) || sysId,
      recordUrl: location.origin + '/' + table + '.do?sys_id=' + sysId,
      user: (window.g_user && g_user.userName) || ''
    }
  });

  function runFallbackSnap() { /* paste the current /snap implementation here */ }
})();
```

### 11.6 User-gesture handling for bridge requests

A bridge request is not an extension user gesture, which affects two APIs:

| Need | Problem | Approach |
| --- | --- | --- |
| `captureVisibleTab` | Needs `activeTab` (gesture) or host permission for the page | Include the ServiceNow hosts in `host_permissions`. Verify during the spike that host permission alone is accepted for `captureVisibleTab` on those hosts; if not, fall back to the gesture path below. |
| `tabCapture` (record-tab) | Requires the extension to be invoked on the tab | Content script shows a small in-page prompt: "Press **Alt+Shift+R** (or click the Snap icon) to start recording." The command/icon click provides the gesture and the service worker picks up the pending job for that tab. |
| `getDisplayMedia` (record-window) | Needs a user gesture in an extension page | Open the recorder window with a "Start" button. |

## 12. Permissions

| Permission | Why | Notes for security review |
| --- | --- | --- |
| `activeTab` | Screenshot of the current tab on user action | Scoped to the tab the user invoked on |
| `tabCapture` | Tab recording without a picker | Only when the user starts a recording |
| `offscreen` | Host media streams and canvas work in MV3 | — |
| `storage`, `unlimitedStorage` | Settings; capture library in IndexedDB | Data stays on device |
| `downloads` | Download adapter | — |
| `scripting` | Inject region-select / highlight overlays on demand | — |
| `contextMenus` | "Snap region" etc. | — |
| `identity` *(optional)* | Cognito / OIDC sign-in for S3 | Requested only if S3 configured |
| `debugger` *(optional, off by default)* | DevTools-protocol full-page capture | Requested at runtime via `optional_permissions` |
| Host: `https://*.service-now.com/*`, `https://*.servicenowservices.com/*` + custom domains | Content script, bridge, screenshots on SN pages | Custom domains added via `optional_host_permissions` from Options |
| Host: S3 / presign endpoint | Uploads | From managed config |

No `<all_urls>` content script. No remote code (MV3 rule) — every library is bundled.

## 13. Manifest (sketch)

```json
{
  "manifest_version": 3,
  "name": "Snap Companion",
  "version": "0.1.0",
  "action": { "default_popup": "popup.html", "default_icon": "icons/32.png" },
  "background": { "service_worker": "sw.js", "type": "module" },
  "permissions": ["activeTab", "tabCapture", "offscreen", "storage", "unlimitedStorage",
                  "downloads", "scripting", "contextMenus"],
  "optional_permissions": ["identity", "debugger"],
  "host_permissions": ["https://*.service-now.com/*", "https://*.servicenowservices.com/*"],
  "optional_host_permissions": ["https://*/*"],
  "content_scripts": [{
    "matches": ["https://*.service-now.com/*", "https://*.servicenowservices.com/*"],
    "js": ["content.js"], "run_at": "document_idle", "all_frames": false
  }],
  "web_accessible_resources": [{
    "resources": ["bridge.html", "bridge.js"],
    "matches": ["https://*.service-now.com/*", "https://*.servicenowservices.com/*"]
  }],
  "commands": {
    "snap-visible": { "suggested_key": { "default": "Alt+Shift+S" }, "description": "Screenshot visible area" },
    "snap-region":  { "suggested_key": { "default": "Alt+Shift+A" }, "description": "Screenshot region" },
    "record-toggle":{ "suggested_key": { "default": "Alt+Shift+R" }, "description": "Start/stop tab recording" }
  },
  "options_page": "options.html",
  "storage": { "managed_schema": "managed_schema.json" }
}
```

Custom-domain ServiceNow instances: Options lets the user add hosts; the extension requests them via `chrome.permissions.request` and registers the content script dynamically with `chrome.scripting.registerContentScripts`.

## 14. Settings

### 14.1 User settings (`chrome.storage.sync`)

| Key | Default | Description |
| --- | --- | --- |
| `defaultScreenshotDestinations` | `["download"]` | Pre-checked destinations in the editor |
| `defaultRecordingDestinations` | `["download"]` | |
| `snDefaultFormat` | `"pdf"` | What to attach when started from `/snap` |
| `fileNamePattern` | `{table}_{label}_{yyyyMMdd-HHmmss}` | Falls back to `{host}_{yyyyMMdd-HHmmss}` outside ServiceNow |
| `downloadSubfolder` | `"Snap"` | Relative to the browser's download folder |
| `askWhereToSave` | `false` | |
| `recording.maxMinutes` | `10` | |
| `recording.mic` | `false` | |
| `recording.clickHighlights` | `true` | |
| `pdf.pageSize` | `"letter"` | `letter` or `a4` |
| `library.maxItems` / `library.maxMB` | `20` / `1024` | |
| `snHosts` | `[]` | Extra ServiceNow hosts (custom domains) |

### 14.2 Managed policy (`managed_schema.json`)

Admins can push and lock:

```json
{
  "type": "object",
  "properties": {
    "s3": { "type": "object", "properties": {
      "mode": { "type": "string", "enum": ["presign", "cognito"] },
      "presignEndpoint": { "type": "string" },
      "cognito": { "type": "object" },
      "keyPrefix": { "type": "string" } } },
    "snHosts": { "type": "array", "items": { "type": "string" } },
    "allowedDestinations": { "type": "array", "items": { "type": "string" } },
    "forceRedactionReminder": { "type": "boolean" },
    "recordingMaxMinutes": { "type": "integer" }
  }
}
```

Managed values override user settings and are shown as locked in Options.

## 15. Security and privacy

- **Local by default.** Nothing leaves the device until the user picks a destination and saves.
- **No credentials stored.** S3 via presigned URLs or short-lived Cognito credentials; ServiceNow uploads use the page's own session.
- **Redaction is destructive at export** — blurred pixels are replaced in the output, not overlaid.
- **Redaction reminder** (optional, admin-enforceable): before saving to S3/ServiceNow, prompt "Check for personal data" when the capture has no blur regions.
- **Bridge hardening** per §11.4.
- **No analytics** in v1. If added later, opt-in and content-free (counts only).
- **Data handling statement** for the store listing and for organization approval: what's captured, where it's stored, which permissions and why (reuse §12).

## 16. Error handling

| Situation | Behavior |
| --- | --- |
| Service worker restarted mid-recording | Offscreen document keeps recording; job state in IndexedDB lets the worker re-attach on next event. |
| Offscreen document crashes | Chunks already in IndexedDB are kept; editor offers "Recover partial recording". |
| User clicks Chrome's "Stop sharing" | `track.onended` → finalize recording normally. |
| Tab closed while recording | Finalize and open the editor in a new tab. |
| ServiceNow upload 401/403 | Show "Session expired or no attach permission" in the editor; capture stays in the library. |
| ServiceNow upload 413 or extension blocked | Suggest PDF instead of video, or hybrid S3 mode. |
| S3 part upload failure | Retry with exponential backoff (3 attempts per part), resume from the last completed part. |
| Bridge request but SN page navigated away | Job continues; on save, the ServiceNow destination is marked unavailable with a "Copy file / download instead" option. |
| Quota exceeded in IndexedDB | Block new recordings, prompt to clear library. |

## 17. Project structure

```
snap-companion/
├── manifest.json
├── managed_schema.json
├── src/
│   ├── background/
│   │   ├── sw.ts                 # entry: commands, menus, messages
│   │   ├── jobs.ts               # job state machine
│   │   ├── capture.ts            # captureVisibleTab, tabCapture IDs, full-page orchestration
│   │   └── offscreen-client.ts   # ensureOffscreen(), messaging
│   ├── offscreen/
│   │   ├── offscreen.html
│   │   ├── recorder.ts           # MediaRecorder, audio mixing
│   │   └── image.ts              # crop, stitch, encode
│   ├── editor/
│   │   ├── editor.html
│   │   ├── App.svelte            # or React/Preact
│   │   ├── canvas/               # Konva tools
│   │   ├── video/                # preview, trim
│   │   └── export/               # png.ts, pdf.ts, bundle.ts
│   ├── popup/
│   ├── options/
│   ├── content/
│   │   ├── content.ts            # detection flag, bridge relay
│   │   ├── region-select.ts
│   │   └── click-highlight.ts
│   ├── bridge/
│   │   ├── bridge.html
│   │   └── bridge.ts
│   ├── storage/
│   │   ├── adapter.ts            # StorageAdapter interface + registry
│   │   ├── download.ts
│   │   ├── s3.ts                 # presign + multipart
│   │   └── servicenow.ts         # hands off to bridge
│   └── shared/
│       ├── db.ts                 # IndexedDB (idb)
│       ├── messages.ts           # typed message definitions
│       └── settings.ts
├── snutils/
│   └── snap-command.js           # the /snap script command source
└── tests/
```

**Tooling:** TypeScript, Vite with a Chrome-extension plugin (e.g. CRXJS) for MV3 bundling and HMR, Svelte or Preact for UI (small bundles), Konva, `idb`, `pdf-lib` (or the in-house PDF builder), `fix-webm-duration`. Vitest for units, Playwright with a persistent Chromium context loading the unpacked extension for end-to-end tests.

## 18. Testing

| Level | What |
| --- | --- |
| Unit | File naming, PDF builder, annotation serialization, S3 multipart planner, bridge message validation |
| Integration | Offscreen recorder with a fake media stream (`--use-fake-device-for-media-stream`), IndexedDB chunk recovery |
| E2E (Playwright) | Hotkey screenshot → editor → download; region select; `/snap` bridge against a mock ServiceNow page (local server serving a fake form + attachment endpoint) |
| Manual matrix | Classic UI (`nav_to.do`, `gsft_main`), direct `.do` forms, Next Experience, Workspace, Service Portal; HiDPI vs 1x displays; Chrome + Edge |
| Security | Forged `postMessage` from another origin/frame; replayed `requestId`; bridge iframe on a non-SN host |

## 19. Roadmap

| Phase | Scope | Exit criteria |
| --- | --- | --- |
| **0 — Spike** | Confirm `captureVisibleTab` with host permission from a bridge request; tab-capture gesture flow; Blob delivery via bridge iframe | All three proven in a throwaway build |
| **1 — MVP** | Visible + region screenshot, editor (annotate, redact, context), PNG/PDF export, Download + ServiceNow adapters, bridge, updated `/snap` with fallback | Team can replace page-only `/snap` |
| **2 — Recording** | Tab recording, window/screen, mic, countdown, pause, click highlights, video attach/download | 10-minute tab recording attached as MP4 |
| **3 — S3** | Presign backend reference implementation, multipart, hybrid S3 + PDF-to-record | 200 MB recording uploads reliably with resume |
| **4 — Polish** | Full-page capture, video trim + keyframes in PDF, library search/tags, managed policy, store listing | Rolled out via enterprise policy |

## 20. Open questions

1. Does `captureVisibleTab` accept a host permission (rather than `activeTab`) for bridge-initiated captures on ServiceNow hosts? (Phase 0 spike.)
2. Should the ServiceNow upload ever move into the extension (e.g. for scheduled/background retries), or always stay in the page? Current answer: page only.
3. Is a standalone recorder window needed for window/screen recording, or is the popup enough before it closes? (Popups close on focus loss — likely need a window.)
4. MP4 vs WebM default given the instance's attachment extension allow-list.
5. Should the PDF report embed a clickable link annotation for the record URL and S3 URL?
6. Where should the presign backend live and who owns it (per team vs central)?
7. Edge-specific behavior differences for `tabCapture` and offscreen documents.
