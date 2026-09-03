# ChatGPT Auto Prompt

A Manifest V3 Chrome extension that drops a block of text into the ChatGPT
composer and clicks the send button for you.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.

## Where the UI lives

The toolbar icon opens a **side panel** docked to the right of the browser
window (`chrome.sidePanel`, Chrome 114+). Unlike the old toolbar popup it stays
open while you browse, so the tracker's **Job title**, **Company** and **Job
link** follow you from listing to listing - fields you have typed in yourself
are never overwritten, only untouched ones move.

Chrome opens the panel on the right by default; the user can move it left from
the panel's own menu, and an extension cannot override that.

**Pop out** in the panel header reopens the same page as a free-standing window
pinned to the right edge of the screen - useful next to a ChatGPT window or on a
second monitor. Chrome cannot keep it above other windows. There is one such
window at a time; pressing **Pop out** again just focuses it.

`popup.html` serves both views. The window is the one loaded with
`?view=window`, which is how it knows to hide its own **Pop out** button.

On Chrome older than 114 there is no side panel, so the toolbar icon opens the
popped-out window instead (`background.js`).

Because the panel is not a popup, it no longer closes itself after a send - the
status line reports the result and the panel stays put.

## Use

### Sending a job description

Every send is a resume send: the template DOCX and the generator prompt are
always uploaded, and there is no plain-prompt mode. A job description sent on
its own comes back as a resume for whoever ChatGPT happens to remember, so the
files are not optional.

1. Pick a **Resume template** - the entries in `RESUME_TEMPLATES` (`assets.js`).
2. Paste the **job description** into the box.
3. **Send to ChatGPT** (or `Ctrl`+`Enter`).

The extension attaches the chosen `Temp/…docx` first, then
`Resume Generator Prompt.txt`, and sends:

> Give me tailored resume based on attached file and JD : *…your pasted JD…*

The opening line is fixed: it lives in `START_PROMPT` in `assets.js`, and the
wrapper that joins it to the JD is `buildResumePrompt()` beside it.

**Context menu** - select a job description on any page, right-click, choose
**Send "…" to ChatGPT as a JD**. It runs the same pipeline with whichever
template you last used in the panel.

### Job tracker

Below the send button, the **Job tracker** half of the panel files the same
application into the `server/` API of this repo. It is always on screen; if the
tracker is not running, the section says so and offers a **Retry**.

The two actions are separate buttons and neither waits on the other:

| Button | Does |
| --- | --- |
| **Send to ChatGPT** | Only sends the prompt. Needs nothing from the tracker form. |
| **Save to tracker** | Only files the record. Does not touch ChatGPT. |

Either order works - send first and file the job once ChatGPT is writing, or
file it first and send afterwards. Because **Save to tracker** reads the job
description out of the prompt box, **Send to ChatGPT** leaves that box alone
while the tracker section is open; with the section closed it clears it as
before.

- **Profile** and **Status** are fetched from `GET /api/meta`. A profile *is* a
  resume template - `PROFILES` in `server/src/config.js` holds the same names as
  `RESUME_TEMPLATES` here - so the two dropdowns move together: picking a
  template selects that profile and vice versa. The server still rejects any
  `profileName` outside its own list, so **renaming a person means editing both
  lists**, and renaming the records already filed under the old name.
- **Job title**, **Company** and **Job link** are guessed from the tab you have
  open (`"<role> at <company> | <board>"` titles parse best) and are editable.
- **Job description** is whatever is in the prompt box.
- **Resume file** is optional, because ChatGPT will not have written it yet if
  you file the job straight away. Leave it empty and the record is created
  without one; the panel then shows a **Waiting on a resume** row that attaches
  the file you downloaded, which `PUT`s it onto that record.

The tracker must be running (`npm run dev:server` from the repo root) - the
popup says so in the tracker section when it cannot reach the API. The host is
`http://localhost:5000`, set in `TRACKER_API` (`tracker.js`) and in
`host_permissions` (`manifest.json`); change both together.

Requests carry `Origin: chrome-extension://<id>`, which the server allows via
the `chrome-extension://*` entry in its `CORS_ORIGIN`. Swap that for your real
extension id (shown on `chrome://extensions`) to allow only this extension.

The context menu stays send-only: a right-click has no job title or profile to
file the application under.

### How the prompt lands

The prompt goes into the ChatGPT tab you already have open, in whatever chat is
on screen - the tab is focused but never navigated, so nothing on the page is
thrown away. Only when no ChatGPT tab exists at all is one opened, on
`https://chatgpt.com/` (`CHATGPT_URL` in `background.js`); the text is queued
and fires once that page finishes loading.

The send button is then clicked for you, unless an attachment upload has not
settled - in that case the prompt is left in the composer and the panel says so.

Because the chat is reused, start a new one yourself when the conversation
already holds a different candidate - see the troubleshooting note below.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | Permissions, content script registration, popup wiring. |
| `assets.js` | Template list, prompt wrapper, and bundled-file loading. Shared by the popup and the service worker. |
| `background.js` | Service worker: context menu, tab lookup/creation, message routing. |
| `content.js` | Runs on chatgpt.com: fills the composer, clicks send. |
| `tracker.js` | Job tracker API client: `/api/meta`, create, and attach-resume. |
| `popup.html/.css/.js` | The panel UI, in both the docked and popped-out views. |
| `Temp/*.docx` | Resume templates, bundled with the extension. |
| `Resume Generator Prompt.txt` | Instruction file attached with every resume prompt. |

## Changing the templates or the wording

Everything resume-specific lives in `assets.js`:

- `RESUME_TEMPLATES` - add, remove, or rename entries. Drop the new `.docx` in
  `Temp/` and add `{ id, label, path }`; the popup's select box is built from
  this list, so nothing else needs touching.
- `buildResumePrompt()` - the sentence the JD is wrapped in.
- `GENERATOR_PROMPT_PATH` - which instruction file rides along.

These files are read with `fetch(chrome.runtime.getURL(...))`, so they must stay
inside the extension folder - an extension cannot read arbitrary paths from
disk. **Renaming or moving a file means editing `assets.js` to match**, and
after any change to the files reload the extension so Chrome re-reads them.

## How the composer is filled

ChatGPT's input is a ProseMirror `contenteditable`, not a plain `<textarea>`.
Writing to `innerText` does nothing - ProseMirror keeps its own document state
and overwrites the DOM. So `content.js` selects the existing content and
dispatches a synthetic `paste` event carrying a `DataTransfer`, which ProseMirror
handles like a real paste (multi-line text included). If the paste is not
consumed it falls back to `document.execCommand("insertText")`, and the legacy
`<textarea>` UI is filled through React's native value setter.

Sending waits for the streaming **stop** button to disappear, then for the send
button to become enabled, then clicks it. If no clickable send button turns up
within 10s it falls back to dispatching `Enter` in the composer.

## How files are attached

The resume-mode files ship inside the extension folder, so they are read with
`fetch(chrome.runtime.getURL(...))` in `assets.js` - no picker and no filesystem
access needed. They travel as base64 because `chrome.runtime.sendMessage` is
JSON-only and cannot carry a `File`. The content script rebuilds each `File` and assigns it to
the page's hidden `input[type=file]` through a `DataTransfer`, then fires
`change`; if no input is reachable it dispatches a synthetic
`dragenter`/`dragover`/`drop` on the composer instead.

Sending then waits for the upload to finish - a send fired while an attachment
is still uploading silently drops the file. `waitForUploads()` polls for
progress indicators *within the composer form only*, so a streaming reply's
spinner elsewhere on the page is not mistaken for an upload.

## Troubleshooting: it returned the wrong person's resume

Three causes, in the order worth checking:

1. **The chat had someone else in it.** The prompt goes into the chat that is
   already open, and a resume earlier in that conversation is strong context -
   ChatGPT will reuse it. Start a new chat in the tab before sending a different
   candidate.
2. **The attachment never uploaded.** If the composer shows no file chips, the
   prompt went up naked and ChatGPT answered from whatever it already knew. The
   extension now refuses to auto-send when an upload has not settled and says
   so in the popup status rather than sending without the file.
3. **ChatGPT's saved memory.** Memory persists across chats, so a remembered
   "your name is …" can override the attachment. Check
   **Settings → Personalization → Manage memories** and delete any entry naming
   a candidate, or send from a temporary chat, which does not apply memory.

The popup status line reports how the files went in - `attached via file input`
or `attached via drop`. If neither appears, the attach step failed and the rest
of the message is the place to look.

## If ChatGPT changes its markup

Everything selector-based lives at the top of `content.js`
(`EDITOR_SELECTORS`, `SEND_BUTTON_SELECTORS`, `STOP_BUTTON_SELECTORS`,
`FILE_INPUT_SELECTORS`, `DROP_TARGET_SELECTORS`, `UPLOAD_BUSY_SELECTORS`). Add
the new selector to the front of the relevant list - the rest of the code is
selector-agnostic.

## Notes

- Only `chatgpt.com`, `chat.openai.com` and the tracker's `localhost:5000` are
  in `host_permissions`; the context menu works on any page but only reads the
  text you selected.
- The `action` deliberately declares no `default_popup`. A popup would take
  precedence over `openPanelOnActionClick`, and the side panel would never
  open from the toolbar icon.
- No icons are declared, so Chrome shows the default puzzle-piece. Add
  `"icons"` and `"action.default_icon"` entries to `manifest.json` if you want
  your own.
