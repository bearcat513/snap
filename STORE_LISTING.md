# Snap Companion: store listing and data handling

This is the material for a Chrome Web Store / Edge Add-ons listing and for organization approval (design doc §15, §12).

## Listing

**Name:** Snap Companion

**Summary (132 chars max):** Screenshots and recordings with annotation and redaction. Save to disk, Jira, GitHub, S3 or ServiceNow records.

**Category:** Productivity / Developer Tools

**Description**

> Capture the visible page, a region, a single element, the full page or several screen widths with one shortcut, or record a tab, window or screen with optional narration and on-device captions. Mark captures up with arrows, boxes, text, highlights and numbered steps. Snap Companion spots emails, phone numbers, keys and other sensitive text as you capture and offers to redact it; redaction changes the exported pixels themselves, including in videos over any time range you choose. Trim recordings, export GIFs, and turn the clicks in a tab recording into a step-by-step guide. Collect several captures into one report, compare before and after, and include the page's console errors and failed requests in bug reports. Save to your downloads, S3, Jira, GitHub or a webhook, or run `/snap` from SN Utils to attach to the ServiceNow record you're on.
>
> Everything stays on your device until you choose where to save it. No account, no analytics, no remote code.

**Screenshots to include:** the editor with annotations and suggested redactions; the video editor with trim handles, a redaction region and a generated guide; a session report; the library with search, tags and the storage meter; a PDF report; the side panel next to a ticket; the `/snap` prompt on a ServiceNow form.

## Data handling statement

| Question | Answer |
| --- | --- |
| What is captured? | Only what the user explicitly captures: a screenshot, or a recording they start and stop. Nothing is captured in the background. When the user turns it on for a tab, console errors and failed requests from that tab (no bodies or headers; URLs without query values) are added to its captures. |
| Is page content read? | At capture time the page's text is scanned on the device for sensitive patterns, to suggest redactions. Only the positions and kinds of matches are kept, never the text. During tab recordings, clicked elements' names (button text, field labels, never typed values) are kept for guides; this can be turned off. |
| Speech | Captions use the browser's on-device speech recognition only. If it isn't available, no captions are made and no audio is sent anywhere. |
| Where is it stored? | In the browser's IndexedDB for this extension, on this device. The library keeps the last 20 captures or 1 GB by default (configurable). Captures that were never saved anywhere are never deleted automatically. |
| When does data leave the device? | Only when the user clicks **Save** or **Export** for a chosen destination: a local download, the user's own S3 bucket via their organization's presign service, a Jira site, GitHub repository or webhook the user configured, or the ServiceNow record that started the request. |
| ServiceNow credentials | None are handled. Attachments are uploaded by the ServiceNow page itself, using the user's existing session. |
| AWS credentials | None are stored. Uploads use short-lived presigned URLs issued by the organization's own service. |
| Issue-tracker tokens | Jira, GitHub and webhook tokens the user enters are kept in the extension's local storage on this device. They are never synced and are left out of diagnostics. |
| Diagnostics | The last 100 errors are kept locally. They leave the device only if the user copies them from Settings → About. |
| Analytics / telemetry | None. |
| Remote code | None. All code ships in the package (Manifest V3). |
| Third parties | None. The only network destinations are ServiceNow instances the user is on, and an S3 presign endpoint, Jira site, GitHub API or webhook configured by the user or their administrator. |

## Permission justifications

| Permission | Justification |
| --- | --- |
| `activeTab` | Screenshot or record the current tab when the user clicks the toolbar button, uses a shortcut or uses the context menu. |
| `tabCapture` | Record the current tab without a picker, only after the user starts a recording. |
| `offscreen` | Holds the tab recording (MediaRecorder), since MV3 service workers can't use media streams. |
| `storage`, `unlimitedStorage` | Settings, plus the on-device capture library. Recordings can be large. |
| `downloads` | Save exports to the Downloads folder. |
| `scripting` | Inject the region and element pickers, the sensitive-text scan, the full-page scrolling helper, the countdown, and click and key overlays into the tab being captured. |
| `contextMenus` | "Snap visible area / region / element / full page / record this tab" in the right-click menu. |
| `sidePanel` | The side-panel list of recent captures, for dragging them into the page beside it. |
| Host: `*.service-now.com`, `*.servicenowservices.com` | Detect the SN Utils `/snap` request on ServiceNow pages and hand finished files to that page. |
| Optional `identity` | OIDC sign-in for the organization's S3 presign service. Requested only if configured. |
| Optional `debugger` | DevTools-protocol full-page capture, multi-width viewport capture, and the per-tab console and network log. Off by default; requested only when the user picks one of these. |
| Optional host access (`https://*/*`, `<all_urls>`) | Custom-domain ServiceNow instances, the S3 presign endpoint, Jira / GitHub / webhook destinations, and the opt-in "one-step `/snap`" screenshots. Each is requested at runtime with Chrome's permission prompt. |
