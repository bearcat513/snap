# Snap Companion: store listing and data handling

This is the material for a Chrome Web Store / Edge Add-ons listing and for organization approval (design doc §15, §12).

## Listing

**Name:** Snap Companion

**Summary (132 chars max):** Screenshots and screen recordings with annotation and redaction. Save to disk or attach to ServiceNow records.

**Category:** Productivity / Developer Tools

**Description**

> Capture the visible page, a region, or the full page with one shortcut, or record a tab, window or screen with optional narration. Mark captures up with arrows, boxes, text, highlights and numbered steps. Redact anything sensitive with blur or pixelate; this changes the exported pixels themselves, including in videos over any time range you choose. Trim recordings and pick keyframes for a PDF report. Add context like a description, steps to reproduce, tags and your team's own fields, or start from a template. Save to your downloads, or run `/snap` from SN Utils to attach a PDF, image or video to the ServiceNow record you're on.
>
> Everything stays on your device until you choose where to save it. No account, no analytics, no remote code.

**Screenshots to include:** the editor with annotations and a redaction; the video editor with trim handles and a redaction region; the library with search and tags; a PDF report; the `/snap` prompt on a ServiceNow form.

## Data handling statement

| Question | Answer |
| --- | --- |
| What is captured? | Only what the user explicitly captures: a screenshot, or a recording they start and stop. Nothing is captured in the background. |
| Where is it stored? | In the browser's IndexedDB for this extension, on this device. The library keeps the last 20 captures or 1 GB by default (configurable). Captures that were never saved anywhere are never deleted automatically. |
| When does data leave the device? | Only when the user clicks **Save** or **Export** for a chosen destination: a local download, the user's own S3 bucket via their organization's presign service, or the ServiceNow record that started the request. |
| ServiceNow credentials | None are handled. Attachments are uploaded by the ServiceNow page itself, using the user's existing session. |
| AWS credentials | None are stored. Uploads use short-lived presigned URLs issued by the organization's own service. |
| Analytics / telemetry | None. |
| Remote code | None. All code ships in the package (Manifest V3). |
| Third parties | None. The only network destinations are ServiceNow instances the user is on and an S3 presign endpoint configured by the user or their administrator. |

## Permission justifications

| Permission | Justification |
| --- | --- |
| `activeTab` | Screenshot or record the current tab when the user clicks the toolbar button, uses a shortcut or uses the context menu. |
| `tabCapture` | Record the current tab without a picker, only after the user starts a recording. |
| `offscreen` | Holds the tab recording (MediaRecorder), since MV3 service workers can't use media streams. |
| `storage`, `unlimitedStorage` | Settings, plus the on-device capture library. Recordings can be large. |
| `downloads` | Save exports to the Downloads folder. |
| `scripting` | Inject the region-select overlay, full-page scrolling helper, countdown and click highlights into the tab being captured. |
| `contextMenus` | "Snap visible area / region / full page / record this tab" in the right-click menu. |
| Host: `*.service-now.com`, `*.servicenowservices.com` | Detect the SN Utils `/snap` request on ServiceNow pages and hand finished files to that page. |
| Optional `identity` | OIDC sign-in for the organization's S3 presign service. Requested only if configured. |
| Optional `debugger` | DevTools-protocol full-page capture. Off by default; requested only if the user selects it. |
| Optional host access (`https://*/*`, `<all_urls>`) | Custom-domain ServiceNow instances, the S3 presign endpoint, and the opt-in "one-step `/snap`" screenshots. Each is requested at runtime with Chrome's permission prompt. |
