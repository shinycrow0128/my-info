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

  async function sendPrompt(text, files = [], jobId = null) {
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

    // Deliberately not awaited: the panel gets its answer now, and the ZIP is
    // still minutes away. The watch outlives this call and reports for itself.
    startPackageWatch(jobId);

    return notes.join(", ");
  }

  // ---------------------------------------------------------------------------
  // Watching the reply for the generated ZIP
  //
  // The generator prompt contracts ChatGPT to answer with exactly one
  // `Resume_Package_<Candidate>.zip` and nothing else. Once the reply stops
  // streaming, that file card is clicked - which is what downloads the ZIP -
  // and its bytes are handed to the service worker to file into the tracker.
  //
  // Several bids run at once, so nothing here assumes it is the only watcher:
  // each watch remembers how many ZIPs the chat already held and only ever
  // claims a card no other watch has taken.
  // ---------------------------------------------------------------------------

  const ZIP_NAME_RE = /([^\s"'<>|\\/]+\.zip)\b/i;
  const CARD_CLICKABLE = 'a[href], button, [role="button"]';
  const HOOK_SOURCE = "cgap-page-hook";

  const WATCH_TIMEOUT_MS = 25 * 60 * 1000; // a long JD can take ChatGPT a while
  const WATCH_POLL_MS = 2000;
  const URL_TIMEOUT_MS = 45000;

  /**
   * The watch runs for twenty minutes with nothing on screen, so it says what
   * it is doing on the ChatGPT tab's console. Open DevTools there and filter
   * for "Auto Prompt" to see exactly how far a bid got.
   */
  function trace(...args) {
    console.log("[ChatGPT Auto Prompt]", ...args);
  }

  /** Card indexes already handed to a job, so two watches never take the same one. */
  const claimedCards = new Set();

  /** Signed download URLs seen by page-hook.js, newest last. */
  const hookUrls = [];
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== HOOK_SOURCE || data.type !== "file-url") return;
    hookUrls.push({ url: data.url, at: Date.now() });
    if (hookUrls.length > 20) hookUrls.shift();
    trace("page hook caught a file URL:", String(data.url).slice(0, 120));
  });

  /**
   * Every ZIP the conversation shows, in document order. Matching on the file
   * name rather than on a card class is deliberate: the name is contracted by
   * the prompt, whereas ChatGPT's markup is not ours and changes often.
   */
  function findZipCards() {
    const root = document.querySelector("main") || document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        ZIP_NAME_RE.test(node.nodeValue || "")
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT,
    });

    const cards = [];
    const seen = new Set();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el || !isVisible(el)) continue;
      // The composer lists what we are about to send; only the reply counts.
      if (el.closest("form")) continue;
      // React delegates its click handling to the document, so clicking the
      // innermost element still reaches the card's own handler - the ancestor
      // lookup is only for the cases where the card really is a link.
      const card = el.closest(CARD_CLICKABLE) || el;
      if (seen.has(card)) continue;
      seen.add(card);
      cards.push({ name: ZIP_NAME_RE.exec(node.nodeValue)[1], el: card, index: cards.length });
    }
    return cards;
  }

  /** assets.js is not injected here, so the content script carries its own. */
  function toBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  /**
   * Click the card - that is the download itself - and come back with a URL the
   * bytes can be read from.
   *
   * Three independent sources, because ChatGPT resolves its downloads in its
   * own code and none of them is guaranteed: the URL its API handed back
   * (caught by page-hook.js), a real link on the card, and - the one that does
   * not care how any of this is built - the download Chrome just took.
   */
  async function resolvePackageUrl(card) {
    const since = Date.now();

    const directHref = () => {
      const anchor = card.el.closest("a[href]") || card.el.querySelector("a[href]");
      return anchor && /^(https?|blob):/.test(anchor.href) ? anchor.href : "";
    };

    const downloadedUrl = async () => {
      const found = await chrome.runtime
        .sendMessage({ type: "CHATGPT_FIND_DOWNLOAD", since })
        .catch(() => null);
      return (found && found.url) || "";
    };

    card.el.scrollIntoView({ block: "center" });
    trace("clicking the file card", card.name, "-", card.el.tagName.toLowerCase());
    card.el.click();

    const deadline = Date.now() + URL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const hooked = hookUrls.filter((entry) => entry.at >= since).pop();
      if (hooked) return { url: hooked.url, from: "the page hook" };

      const href = directHref();
      if (href) return { url: href, from: "the card's own link" };

      const downloaded = await downloadedUrl();
      if (downloaded) return { url: downloaded, from: "Chrome's download list" };

      await sleep(500);
    }
    return { url: "", from: "" };
  }

  /**
   * Read the ZIP in the browser when the storage host allows it. A signed URL
   * on a host that answers no cross-origin request lands in the catch, and the
   * URL alone goes to the tracker server, which is under no such rule.
   */
  async function readPackage(url) {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      return toBase64(new Uint8Array(await response.arrayBuffer()));
    } catch {
      return null;
    }
  }

  function report(jobId, payload) {
    return chrome.runtime.sendMessage({ jobId, ...payload }).catch(() => {
      // The panel may be closed and the worker asleep; the watch carries on.
    });
  }

  async function watchForPackage(jobId) {
    // Whatever the chat already held is not ours - only cards beyond this are.
    const baseline = findZipCards().length;
    trace("watching this chat for job", jobId, "- ZIPs already here:", baseline);
    await report(jobId, { type: "CHATGPT_JOB_UPDATE", state: "watching", detail: "waiting for the resume package" });

    const deadline = Date.now() + WATCH_TIMEOUT_MS;
    let chosen = null;
    let previous = -1;

    while (Date.now() < deadline) {
      const next = findZipCards()
        .slice(baseline)
        .find((card) => !claimedCards.has(card.index));
      // Taken once it has stayed put for a poll and the reply has stopped
      // streaming - a card caught mid-render can still move or be replaced.
      if (next && next.index === previous && !isGenerating()) {
        chosen = next;
        break;
      }
      previous = next ? next.index : -1;
      await sleep(WATCH_POLL_MS);
    }

    if (!chosen) {
      throw new Error(
        "No ZIP turned up in this chat within " + Math.round(WATCH_TIMEOUT_MS / 60000) + " minutes.",
      );
    }

    claimedCards.add(chosen.index);
    trace("found the package:", chosen.name);
    await report(jobId, { type: "CHATGPT_JOB_UPDATE", state: "downloading", detail: chosen.name });

    const { url, from } = await resolvePackageUrl(chosen);
    if (!url) {
      throw new Error(
        "Downloaded " + chosen.name + ", but no URL for it turned up - the page exposed none, and Chrome listed no matching download.",
      );
    }
    trace("download URL resolved from", from);

    const data = await readPackage(url);
    if (!data && !/^https?:/i.test(url)) {
      // A blob: URL only lives in this page, and the tracker cannot fetch one.
      // Failing here is honest; the ZIP is in Downloads for a manual attach.
      throw new Error(
        "Downloaded " + chosen.name + ", but its URL could not be read here and is not one the tracker can fetch.",
      );
    }
    trace(
      data
        ? "read " + Math.round((data.length * 3) / 4 / 1024) + "KB of ZIP in the browser"
        : "could not read the ZIP here (cross-origin) - sending the URL for the server to fetch",
    );

    await report(jobId, { type: "CHATGPT_PACKAGE_READY", name: chosen.name, data, url });
    trace("handed the package to the extension for filing");
  }

  function startPackageWatch(jobId) {
    if (!jobId) {
      // Auto-filing was off, or this send came from the context menu. Either
      // way nothing is watching, so nothing will be downloaded or filed.
      trace("sent without a job - the reply will NOT be downloaded or filed");
      return;
    }
    watchForPackage(jobId).catch((error) => {
      trace("watch failed:", error.message || error);
      report(jobId, { type: "CHATGPT_PACKAGE_FAILED", error: String(error.message || error) });
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "CHATGPT_SEND_PROMPT") return false;

    sendPrompt(message.text, message.files || [], message.jobId)
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
      await sendPrompt(pendingPrompt.text, pendingPrompt.files || [], pendingPrompt.jobId || null);
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
