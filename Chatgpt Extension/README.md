# ChatGPT Auto Prompt

A Manifest V3 Chrome extension that takes a job description end to end: it
drops the JD into ChatGPT with the right resume template, waits for the
generated package to come back, downloads it, and files the resume and the
cover letter into the job tracker - without you clicking anything after the
send.

The full round trip is [Sending a job description](#sending-a-job-description)
to [When the ZIP comes back](#when-the-zip-comes-back). Several bids can be in
flight at the same time; see [Several bids at once](#several-bids-at-once).

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

1. Pick a **Profile** - it is both the tracker's profile and the resume
   template, the entries in `RESUME_TEMPLATES` (`assets.js`).
2. Fill in **Job title** (and whatever else the page did not guess).
3. Paste the **job description** into the box.
4. **Send to ChatGPT** (or `Ctrl`+`Enter`).

The extension attaches the chosen `Temp/…docx` first, then
`Resume Generator Prompt.txt`, and sends:

> Give me tailored resume based on attached file and JD : *…your pasted JD…*

The opening line is fixed: it lives in `START_PROMPT` in `assets.js`, and the
wrapper that joins it to the JD is `buildResumePrompt()` beside it.

**Context menu** - select a job description on any page, right-click, choose
**Send "…" to ChatGPT as a JD**. It runs the same pipeline with whichever
template you last used in the panel.

### When the ZIP comes back

The generator prompt contracts ChatGPT to answer with exactly one
`Resume_Package_<Candidate>.zip` and nothing else. That is what makes the rest
of this automatic: the extension knows what it is waiting for.

One **Send to ChatGPT** does all of this:

1. The application is filed in the tracker *first*, so the ZIP has a record to
   land in when it arrives minutes later. The panel's tracker fields are then
   cleared - they belong to the record now.
2. `content.js` watches that chat. It notes how many ZIPs the conversation
   already held, so it only ever takes a new one.
3. When the reply stops streaming and the file card has stayed put for a poll,
   the card is **clicked** - which is the download, so the ZIP lands in your
   Downloads folder exactly as if you had clicked it yourself.
4. The same click makes ChatGPT resolve a signed download URL. `page-hook.js`
   catches it (see [How the ZIP is read](#how-the-zip-is-read)) and the bytes
   are read and posted to `POST /api/applications/:id/package`.
5. The server unzips, runs `resume_fill.py` to pour `resume_content.json` into
   `Temp_<profile>.docx`, and attaches the filled resume **and** the cover
   letter to the record together.
6. The job's row says `filed`, with `resume and cover letter saved to the
   tracker` under it. That is the whole of what the panel reports: the two
   documents live on the record, and the tracker UI is where they are read,
   downloaded or replaced.

**The resume DOCX is built by the server, not by ChatGPT.** The prompt
deliberately forbids one in the ZIP: the layout belongs to the template in
`Temp/`, and only the content is generated. That is why the ZIP holds
`resume_content.json` rather than a finished resume.

There is nothing to switch off: filing and sending are the same click, which is
why the panel asks for a profile and a job title before it will send. A send
from the **context menu** is the one exception - a right-click has no fields to
file a record from, so its ZIP is downloaded and the row says `downloaded`.

### Several bids at once

Nothing here assumes it is the only thing running. Each send becomes a **job**:
one tracker record, one chat, one ZIP. Jobs are listed at the top of the panel
with their state - `waiting`, `watching chat`, `downloading`, `filing`,
`filed`, `failed`.

- Each watch remembers how many ZIPs its chat held when it started and claims
  only a card no other watch has taken, so two bids in the same tab cannot
  swallow each other's file.
- Jobs live in `chrome.storage.local`, not in memory. The service worker is
  stopped whenever it goes idle, which over the twenty-odd minutes ChatGPT can
  take it certainly does.
- The server gives every fill its own temp directory - `resume_fill.py` in its
  zero-argument mode scans its own folder for one JSON and one template, which
  two simultaneous bids would trip over - and caps concurrent Python processes
  with `PACKAGE_CONCURRENCY`.
- Nothing is lost when a step fails. The ZIP stays on the job, so **Retry**
  costs no second download. **Dismiss** drops a row you have dealt with. A bid
  the watch missed entirely is finished from the tracker UI, where every row's
  **Resume** and **Cover letter** cells take an upload directly.
- A job row is a progress report, not a filing cabinet. It holds no document
  bytes of its own: the extension used to keep a copy of both files so it could
  hand them back, which duplicated what the record already had. The panel now
  says the documents landed and stops there.

One thing worth doing once: Chrome asks before letting a site download several
files without a click. Answer **Allow** for chatgpt.com the first time it comes
up, or the second and later ZIPs of a session are blocked.

Because each chat holds one conversation's context, run concurrent bids in
**separate ChatGPT tabs** - a second JD sent into a chat that already wrote a
resume gets that candidate again. See the troubleshooting note at the end.

### Job tracker

There is one form and one button. The fields above **Send to ChatGPT** -
**Profile**, **Status**, **Job title**, **Company**, **Applied on**, **Job
link**, **Job description** and **Notes** - are the application, and the click
that sends the prompt files them into the `server/` API of this repo. If the
tracker is not running, the panel says so at the top and offers a **Retry**.

The panel never asks for a resume or a cover letter. Neither exists at the
moment a bid is sent: they are what comes back, and the pipeline attaches them
to the record itself. To put a document on a record by hand - a bid the watch
missed, or a file you want to replace - use the tracker UI, where the
**Resume** and **Cover letter** cells of every row upload straight from the
table.

- **Profile** doubles as the resume template: `PROFILES` in
  `server/src/config.js` holds the same names as `RESUME_TEMPLATES` here, so
  one dropdown settles both. The list is seeded from the bundled templates, so
  a send still works with the tracker down; `GET /api/meta` replaces it with
  the server's roster once it answers. The server rejects any `profileName`
  outside its own list, so **renaming a person means editing both lists**, and
  renaming the records already filed under the old name.
- **Status** comes from `GET /api/meta` and defaults to `applied`.
- **Job title**, **Company** and **Job link** are guessed from the tab you have
  open (`"<role> at <company> | <board>"` titles parse best) and are editable.
  A field you have typed in yourself is never overwritten when you move to the
  next listing.
- **Applied on** defaults to today, in your own timezone.

A send that reached the tracker but never reached ChatGPT - no tab, a page that
would not take the prompt - leaves the record filed and waiting. Pressing the
button again reuses it rather than filing a second one, as long as the profile,
job title and company still match.

The tracker must be running (`npm run dev:server` from the repo root): the
record has to exist before the prompt goes out, so a tracker that is down stops
the send. Filing a ZIP also needs **Python with `python-docx`** on the machine
running the API - that is what `resume_fill.py` runs on. The host is
`http://localhost:5000`, set in `TRACKER_API` (`tracker.js`) and in
`host_permissions` (`manifest.json`); change both together.

Requests carry `Origin: chrome-extension://<id>`, which the server allows via
the `chrome-extension://*` entry in its `CORS_ORIGIN`. Swap that for your real
extension id (shown on `chrome://extensions`) to allow only this extension.

The context menu stays send-only: a right-click has no job title or profile to
file an application under. The ZIP it produces is still downloaded, and the
panel shows the job as `downloaded` with nowhere to file it.

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
| `tracker.js` | Job tracker API client: `/api/meta`, create the application, and post the ZIP. |
| `page-hook.js` | Runs in the page's own world; catches the ZIP's signed download URL. |
| `resume_fill.py` | Pours `resume_content.json` into a `Temp/` template. Run by the tracker server, not by the extension. |
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

## How the ZIP is read

Clicking the file card is the download. Reading the same file *in* the
extension is the harder half, because the card is not a plain link: ChatGPT
asks its own API for a short-lived signed URL and hands that to the browser.

- `page-hook.js` runs in the **page's own world** (`"world": "MAIN"` in the
  manifest) at `document_start`, and wraps `fetch` and `XMLHttpRequest` to
  watch for the `/backend-api/files/...` response the click causes. It only
  reads - the response is `clone()`d, so the page still gets its own body - and
  forwards the URL over `postMessage`. A content script cannot do this itself:
  it lives in an isolated world with its own `fetch`.
- If nothing is caught there and the card carries no real link, the extension
  asks **Chrome itself** what it just downloaded (`chrome.downloads.onCreated`,
  which is all the `downloads` permission is used for - the list is read, never
  written). This is the source that does not care how ChatGPT builds its
  markup or resolves its files: if the ZIP reached your Downloads folder,
  Chrome knows the URL it came from.
- `content.js` then tries to fetch those bytes directly. When the storage host
  answers no cross-origin request, that fetch fails and only the URL is sent to
  the tracker, which downloads it server-side - node is not bound by the page's
  CORS rules. Both paths end at the same endpoint.
- The card itself is found by **file name**, not by class: `Resume_Package_*.zip`
  is contracted by the prompt, whereas ChatGPT's markup is not ours and changes
  often. The click is dispatched on the innermost element, which is enough
  because React delegates its click handling to the document.

## Troubleshooting: nothing was filed

**The job row is the diagnosis.** Every step writes its state there, and the
watch also narrates itself to the ChatGPT tab's console - open DevTools on that
tab and filter for `Auto Prompt` to see how far it got, from
`watching this chat for job ...` to `handed the package to the extension`.

Two answers before the list below:

- **No job row at all, for a bid you sent from the panel.** The send carried no
  job, so nothing was ever watching - the extension had not been reloaded since
  it gained this feature. Reload it at `chrome://extensions`, then send again.
  The console says `sent without a job` in this case.
- **`failed` saying `No route for POST /api/applications/...`.** The tracker
  server is running the old code. Restart it (`npm run dev:server`).

Work down the panel's job row - its state says how far the bid got.

- **`watching chat` forever.** The watch gives up after 25 minutes. It also
  dies if the tab navigates - opening a new chat in the same tab ends the
  watch, and the row stays where it was. The record is already filed, so
  finish it from the tracker UI: upload the two files on its row.
- **`downloaded`, not filed.** The job had no tracker record, which means the
  send came from the context menu.
- **`failed` with a `resume_fill.py` message.** The generated JSON did not fit
  the template - the message names the missing placeholders, usually a
  `Company3-*` set for a template with three employers when ChatGPT wrote two.
  Ask it for the missing block and **Retry**; the ZIP is still on the job.
- **`failed` with "Could not run python".** The API host has no Python with
  `python-docx`. `pip install python-docx`, or set `PYTHON_BIN` in
  `server/.env`.
- **`downloading`, then `failed` saying no URL turned up.** The ZIP reached
  your Downloads folder but all three ways of naming it came up empty. Upload
  the files on the record's row in the tracker UI, and say so - the download
  list fallback is meant to make this impossible.
- **The second ZIP of a session never downloads.** Chrome blocks repeated
  automatic downloads until you allow them for chatgpt.com.

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

The ZIP watch is deliberately not in that list: it matches the contracted file
name and climbs to whatever clickable ancestor exists, so a markup change has
nothing to break. If the download URL stops being caught, the endpoint pattern
to update is `FILE_URL_RE` in `page-hook.js`.

## Notes

- Only `chatgpt.com`, `chat.openai.com`, the storage host the generated files
  come from, and the tracker's `localhost:5000` are in `host_permissions`; the
  context menu works on any page but only reads the text you selected.
- The `downloads` permission is used for one thing: reading back the URL of the
  ZIP that was just downloaded, when the page itself gives no way to find it.
  Nothing is downloaded through the API, and the list is never modified.
- The `action` deliberately declares no `default_popup`. A popup would take
  precedence over `openPanelOnActionClick`, and the side panel would never
  open from the toolbar icon.
- No icons are declared, so Chrome shows the default puzzle-piece. Add
  `"icons"` and `"action.default_icon"` entries to `manifest.json` if you want
  your own.
