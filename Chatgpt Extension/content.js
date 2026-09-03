/**
 * Content script for chatgpt.com / chat.openai.com.
 *
 * Responsibilities:
 *   1. Put a block of text into the composer (ProseMirror contenteditable, or
 *      the legacy <textarea>) in a way React/ProseMirror actually registers.
 *   2. Wait until the send button becomes enabled, then click it.
 *
 * Selectors are ordered most-specific first so the extension keeps working if
 * OpenAI renames a test id.
 */

(() => {
  "use strict";

  // The manifest already injects this script; background.js re-injects only when
  // a tab predates the extension. If both ever land, two live listeners would
  // each answer the same message and the prompt would be inserted twice.
  if (window.__chatgptAutoPromptLoaded) return;
  window.__chatgptAutoPromptLoaded = true;

  const EDITOR_SELECTORS = [
    "#prompt-textarea",
    'div.ProseMirror[contenteditable="true"]',
    'form div[contenteditable="true"]',
    "form textarea",
  ];

  const SEND_BUTTON_SELECTORS = [
    'button[data-testid="send-button"]',
    "#composer-submit-button",
    'button[aria-label*="Send prompt" i]',
    'button[aria-label*="Send message" i]',
    'form button[type="submit"]',
  ];

  const STOP_BUTTON_SELECTORS = [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop" i]',
  ];

  // The page's file input is deliberately hidden, so these are matched without
  // the visibility filter the other selector lists use.
  const FILE_INPUT_SELECTORS = [
    'input[type="file"][multiple]',
    'input[type="file"]',
  ];

  const DROP_TARGET_SELECTORS = [
    'form[data-type="unified-composer"]',
    "form",
    "main",
  ];

  // Matched only inside the composer, so a streaming reply's spinner elsewhere
  // on the page is not mistaken for an in-flight upload.
  const UPLOAD_BUSY_SELECTORS = [
    '[role="progressbar"]',
    ".animate-spin",
    '[data-testid*="uploading" i]',
  ];

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function queryFirst(selectors) {
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (isVisible(el)) return el;
      }
    }
    return null;
  }

  /** Poll `fn` until it returns something truthy, or give up after `timeout` ms. */
  async function waitFor(fn, { timeout = 15000, interval = 120 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = fn();
      if (value) return value;
      if (Date.now() >= deadline) return null;
      await sleep(interval);
    }
  }

  const findEditor = () => queryFirst(EDITOR_SELECTORS);

  function findSendButton() {
    const btn = queryFirst(SEND_BUTTON_SELECTORS);
    if (!btn) return null;
    // While a response streams, the same slot holds a stop button - never click that.
    const testId = btn.getAttribute("data-testid") || "";
    if (testId.includes("stop")) return null;
    return btn;
  }

  const isGenerating = () => Boolean(queryFirst(STOP_BUTTON_SELECTORS));

  const isEnabled = (btn) =>
    !btn.disabled && btn.getAttribute("aria-disabled") !== "true";

  /** Read whatever the composer currently holds, textarea or contenteditable. */
  function editorText(editor) {
    return (editor.tagName === "TEXTAREA" ? editor.value : editor.innerText) || "";
  }

  /** React overrides the value setter, so write through the native one. */
  function fillTextarea(editor, text) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value"
    ).set;
    editor.focus();
    setter.call(editor, text);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** Put the caret around everything already in the editor, so writes replace. */
  function selectAll(editor) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /**
   * Fill a ProseMirror editor. A synthetic paste is the only reliable route:
   * ProseMirror ignores direct DOM mutation and handles multi-line text itself.
   *
   * Returns true if ProseMirror consumed the paste. Do NOT also check the
   * editor's text here - PM applies its transaction through React, so the DOM
   * can still read empty at this point and a "looks empty, insert again"
   * fallback would double the prompt.
   */
  function fillContentEditable(editor, text) {
    editor.focus();
    selectAll(editor);

    const data = new DataTransfer();
    data.setData("text/plain", text);
    const pasteEvent = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    });
    // dispatchEvent returns false when preventDefault() ran, i.e. PM took it.
    const handled = !editor.dispatchEvent(pasteEvent);

    if (!handled) {
      // Plain contenteditable with no paste handler: type it in instead.
      selectAll(editor);
      document.execCommand("insertText", false, text);
    }

    editor.dispatchEvent(new Event("input", { bubbles: true }));
    return handled;
  }

  async function insertText(text) {
    const editor = await waitFor(findEditor, { timeout: 20000 });
    if (!editor) throw new Error("Could not find the ChatGPT composer on this page.");

    if (editor.tagName === "TEXTAREA") fillTextarea(editor, text);
    else fillContentEditable(editor, text);

    // React/ProseMirror update asynchronously - poll instead of guessing a delay.
    const landed = await waitFor(() => editorText(editor).trim().length > 0, {
      timeout: 1500,
      interval: 80,
    });

    if (!landed) {
      // Genuinely empty: retry once. selectAll first so this replaces whatever
      // is there rather than appending to a late-arriving insert.
      if (editor.tagName === "TEXTAREA") {
        fillTextarea(editor, text);
      } else {
        editor.focus();
        selectAll(editor);
        document.execCommand("insertText", false, text);
        editor.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const retried = await waitFor(() => editorText(editor).trim().length > 0, {
        timeout: 1500,
        interval: 80,
      });
      if (!retried) throw new Error("Text did not land in the composer.");
    }

    return editor;
  }

  async function clickSend() {
    // Don't queue a prompt on top of a streaming response.
    await waitFor(() => !isGenerating(), { timeout: 60000 });

    const button = await waitFor(
      () => {
        const btn = findSendButton();
        return btn && isEnabled(btn) ? btn : null;
      },
      { timeout: 10000 }
    );

    if (button) {
      button.click();
      return "clicked send button";
    }

    // Last resort: Enter in the composer submits the form too.
    const editor = findEditor();
    if (!editor) throw new Error("Send button not found and composer is gone.");
    editor.focus();
    for (const type of ["keydown", "keypress", "keyup"]) {
      editor.dispatchEvent(
        new KeyboardEvent(type, {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        })
      );
    }
    return "sent with Enter key (send button was not clickable)";
  }

  /** Rebuild a File from the base64 the popup sent (messages are JSON only). */
  function entryToFile(entry) {
    const binary = atob(entry.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], entry.name, {
      type: entry.type || "application/octet-stream",
      lastModified: entry.lastModified || Date.now(),
    });
  }

  function findFileInput() {
    for (const selector of FILE_INPUT_SELECTORS) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  function dataTransferFor(files) {
    const data = new DataTransfer();
    for (const file of files) data.items.add(file);
    return data;
  }

  /** Fallback when no file input is reachable: pretend the user dropped them. */
  function dropOnComposer(files) {
    const target = queryFirst(DROP_TARGET_SELECTORS);
    if (!target) return false;
    for (const type of ["dragenter", "dragover", "drop"]) {
      // A fresh DataTransfer per event - some handlers consume the one they get.
      const event = new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: dataTransferFor(files),
      });
      target.dispatchEvent(event);
    }
    return true;
  }

  async function attachFiles(entries) {
    const files = entries.map(entryToFile);

    // On a freshly loaded page the input is mounted a beat after the composer,
    // so poll for it - looking once was why attachments silently went missing
    // when the tab had just navigated to a new chat.
    const input = await waitFor(findFileInput, { timeout: 10000 });

    if (input) {
      // Assigning .files is the supported way to script a file input; React
      // picks it up from the change event.
      input.files = dataTransferFor(files).files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { count: files.length, via: "file input" };
    }

    if (dropOnComposer(files)) return { count: files.length, via: "drop" };

    throw new Error("Could not find ChatGPT's file input or a drop target.");
  }

  /** The composer subtree, so upload spinners are matched in the right place. */
  function composerRoot() {
    const editor = findEditor();
    return (editor && editor.closest("form")) || document.querySelector("form") || document.body;
  }

  function uploadsBusy() {
    const root = composerRoot();
    return UPLOAD_BUSY_SELECTORS.some((selector) => root.querySelector(selector));
  }

  /**
   * Sending while an attachment is still uploading silently drops the file, so
   * wait for the composer to go quiet first. Resolves false on timeout - the
   * caller reports that rather than hanging forever.
   */
  async function waitForUploads(timeout = 60000) {
    await sleep(500); // let the chip and its spinner mount before judging idleness
    const idle = await waitFor(() => !uploadsBusy(), { timeout, interval: 250 });
    if (idle) await sleep(250); // small settle before the send button is trusted
    return Boolean(idle);
  }

  async function sendPrompt(text, files = []) {
    const notes = [];

    // Wait for the composer to mount before touching anything. When the tab has
    // just navigated to a new chat, nothing below exists yet at document_idle.
    if (!(await waitFor(findEditor, { timeout: 20000 }))) {
      throw new Error("Could not find the ChatGPT composer on this page.");
    }

    if (files.length) {
      const { count, via } = await attachFiles(files);
      notes.push(
        (count === 1 ? "1 file" : count + " files") + " attached via " + via
      );
    }

    if (text && text.trim()) await insertText(text);

    if (files.length && !(await waitForUploads())) {
      // Sending now would submit without the attachment, and ChatGPT would
      // answer from whatever it already knows - which is how you get the wrong
      // resume back. Leave it in the composer for the user to send instead.
      notes.push("upload did not finish - NOT sent, press send yourself");
      return notes.join(", ");
    }

    notes.push(await clickSend());
    return notes.join(", ");
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "CHATGPT_SEND_PROMPT") return false;

    sendPrompt(message.text, message.files || [])
      .then((detail) => sendResponse({ ok: true, detail }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));

    return true; // keep the message channel open for the async reply
  });

  /**
   * When the popup/context menu had to open a fresh ChatGPT tab, the text is
   * parked in storage because no content script existed yet to receive it.
   */
  async function drainPendingPrompt() {
    const { pendingPrompt } = await chrome.storage.local.get("pendingPrompt");
    if (!pendingPrompt) return;
    // Only the tab it was queued for should consume it - but if the tab id
    // cannot be determined, go ahead rather than dropping the prompt.
    const tabId = await currentTabId();
    if (pendingPrompt.tabId && tabId && pendingPrompt.tabId !== tabId) return;
    await chrome.storage.local.remove("pendingPrompt");
    if (Date.now() - pendingPrompt.createdAt > 120000) return; // stale
    try {
      await sendPrompt(pendingPrompt.text, pendingPrompt.files || []);
    } catch (error) {
      console.warn("[ChatGPT Auto Prompt]", error);
    }
  }

  async function currentTabId() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "CHATGPT_WHOAMI" });
      return response?.tabId ?? null;
    } catch {
      return null;
    }
  }

  drainPendingPrompt();
})();
