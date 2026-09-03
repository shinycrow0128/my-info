/**
 * Service worker: routes a piece of text to a ChatGPT tab.
 *
 * Two entry points feed it - the popup, and the "Send to ChatGPT" context menu
 * on any page's selected text. Both end up in `deliverPrompt()`, which sends
 * into the ChatGPT tab that is already open and clicks send once the prompt is
 * in place. A tab is only created when there is none.
 */

// Classic (non-module) service worker, so the shared resume helpers load here.
importScripts("assets.js");

/**
 * The toolbar icon opens the side panel, which docks to the right of the
 * browser window and stays open while you browse. This only works because the
 * action declares no `default_popup` - one would win over the panel.
 */
if (chrome.sidePanel) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.warn("[ChatGPT Auto Prompt]", error));
} else {
  // Chrome older than 114 has no side panel; the popped-out window stands in.
  // No `screen` in a service worker, so Chrome places this one itself.
  chrome.action.onClicked.addListener(() => {
    chrome.windows.create({
      url: chrome.runtime.getURL("popup.html?view=window"),
      type: "popup",
      width: 420,
      height: 900,
    });
  });
}

// Only used when no ChatGPT tab is open at all.
const CHATGPT_URL = "https://chatgpt.com/";
const CHATGPT_TAB_MATCH = ["https://chatgpt.com/*", "https://chat.openai.com/*"];
const MENU_ID = "send-selection-to-chatgpt";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Send "%s" to ChatGPT as a JD',
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== MENU_ID || !info.selectionText) return;
  sendSelection(info.selectionText).catch((error) =>
    console.warn("[ChatGPT Auto Prompt]", error)
  );
});

/**
 * Selected text goes through the same resume pipeline as the panel, using the
 * template last chosen there - so a JD can be sent straight off a job listing.
 */
async function sendSelection(selectionText) {
  const { templateId } = await chrome.storage.local.get(["templateId"]);
  const files = await buildResumeAttachments(templateId);
  return deliverPrompt(buildResumePrompt(selectionText), files);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Content scripts ask which tab they live in, to claim a queued prompt.
  if (message?.type === "CHATGPT_WHOAMI") {
    sendResponse({ tabId: sender.tab?.id ?? null });
    return false;
  }

  if (message?.type !== "CHATGPT_DELIVER_PROMPT") return false;

  deliverPrompt(message.text, message.files || [])
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));

  return true;
});

/** Prefer a ChatGPT tab in the current window, otherwise any window. */
async function findChatGptTab() {
  const current = await chrome.tabs.query({
    url: CHATGPT_TAB_MATCH,
    currentWindow: true,
  });
  if (current.length) return current[0];

  const anywhere = await chrome.tabs.query({ url: CHATGPT_TAB_MATCH });
  return anywhere[0] || null;
}

async function focusTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId != null) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
}

/** Message the content script, injecting it first if the tab predates install. */
async function messageTab(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return await chrome.tabs.sendMessage(tabId, payload);
  }
}

/**
 * Park the payload for a tab that is about to (re)load. The content script
 * claims it by tab id as soon as it runs on the new document.
 */
async function queuePrompt(tabId, text, files) {
  await chrome.storage.local.set({
    pendingPrompt: { text, files, tabId, createdAt: Date.now() },
  });
}

async function deliverPrompt(text, files = []) {
  const trimmed = (text || "").trim();
  // A file on its own is a valid prompt; only both being empty is an error.
  if (!trimmed && !files.length) throw new Error("Nothing to send - add text or a file.");

  const existing = await findChatGptTab();

  if (existing) {
    // Straight into whatever chat is on screen - no navigation, so an open
    // conversation is continued rather than replaced.
    await focusTab(existing);
    const response = await messageTab(existing.id, {
      type: "CHATGPT_SEND_PROMPT",
      text: trimmed,
      files,
    });
    if (!response?.ok) throw new Error(response?.error || "The ChatGPT tab did not respond.");
    return { detail: response.detail, tabId: existing.id };
  }

  const tab = await chrome.tabs.create({ url: CHATGPT_URL, active: true });
  await queuePrompt(tab.id, trimmed, files);
  return { detail: "opened a new ChatGPT tab", tabId: tab.id };
}
