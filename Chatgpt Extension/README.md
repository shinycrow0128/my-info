# ChatGPT Auto Prompt

A Manifest V3 Chrome extension that drops a block of text into the ChatGPT
composer and clicks the send button for you.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.

## Use

### Resume mode (on by default)

1. Pick a **Resume template** - Jared Christopher Burgwin, Nathaniel Adam Lesch,
   or Russell Aaron Turner.
2. Optionally reword the **Start prompt** - the opening line the job description
   is appended to. It is remembered between sends; **Reset** restores the
   default, and leaving it empty falls back to the default too.
3. Paste the **job description** into the box.
4. **Send** (or `Ctrl`+`Enter`).

The extension attaches the chosen `Temp/…docx` first, then
`Resume Generator Prompt.txt`, and sends:

> Give me tailored resume based on attached file and JD : *…your pasted JD…*

followed by a fixed paragraph pinning the identity to the attached DOCX. Only
the opening line is editable; the default lives in `DEFAULT_START_PROMPT` in
`assets.js` and the rest of the wrapper in `buildResumePrompt()` beside it.

**Context menu** - select a job description on any page, right-click, choose
**Send "…" to ChatGPT as a JD**. It runs the same pipeline with whichever
template and start prompt you last used in the popup.

### Plain mode

Untick **Resume mode** and the popup becomes a plain prompt box: no template,
no wrapper text, your text sent verbatim.

### In either mode

The prompt goes into the ChatGPT tab you already have open, in whatever chat is
on screen - the tab is focused but never navigated, so nothing on the page is
thrown away. Only when no ChatGPT tab exists at all is one opened, on
`https://chatgpt.com/` (`CHATGPT_URL` in `background.js`); the text is queued
and fires once that page finishes loading.

The send button is then clicked for you, unless an attachment upload has not
settled - in that case the prompt is left in the composer and the popup says so.

Because the chat is reused, start a new one yourself when the conversation
already holds a different candidate - see the troubleshooting note below.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | Permissions, content script registration, popup wiring. |
| `assets.js` | Template list, prompt wrapper, and bundled-file loading. Shared by the popup and the service worker. |
| `background.js` | Service worker: context menu, tab lookup/creation, message routing. |
| `content.js` | Runs on chatgpt.com: fills the composer, clicks send. |
| `popup.html/.css/.js` | The toolbar popup UI. |
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

- Only `chatgpt.com` and `chat.openai.com` are in `host_permissions`; the
  context menu works on any page but only reads the text you selected.
- No icons are declared, so Chrome shows the default puzzle-piece. Add
  `"icons"` and `"action.default_icon"` entries to `manifest.json` if you want
  your own.
