/**
 * Service worker: routes a piece of text to a ChatGPT tab, then files what
 * comes back.
 *
 * Two entry points feed it - the popup, and the "Send to ChatGPT" context menu
 * on any page's selected text. Both end up in `deliverPrompt()`, which sends
 * into the ChatGPT tab that is already open and clicks send once the prompt is
 * in place. A tab is only created when there is none.
 *
 * Each send can carry a *job*: the tracker record this bid belongs to. The
 * content script watches that chat for the generated ZIP and hands it back
 * here, where it is posted to the tracker. Jobs live in storage rather than in
 * memory, because the worker is stopped between messages and several bids are
 * in flight at once - see the job registry at the foot of this file.
 */

// Classic (non-module) service worker, so the shared helpers load here.
importScripts("assets.js", "tracker.js");

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
  // Earlier builds kept a copy of every filed document here. The tracker holds
  // them now, so an upgrade drops what those builds left behind.
  chrome.storage.local.remove("jobDocs");
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
  // No tracker record: a right-click has no job title or profile to file one
  // under. The job still exists so the ZIP is downloaded when it arrives.
  const job = await createJob({
    applicationId: null,
    label: selectionText.trim().slice(0, 60),
    profileName: templateById(templateId).label,
  });
  return deliverPrompt(buildResumePrompt(selectionText), files, job.id);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Content scripts ask which tab they live in, to claim a queued prompt.
  if (message?.type === "CHATGPT_WHOAMI") {
    sendResponse({ tabId: sender.tab?.id ?? null });
    return false;
  }

  const answer = (promise) => {
    promise
      .then((result) => sendResponse({ ok: true, ...(result || {}) }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true; // keep the channel open for the async reply
  };

  switch (message?.type) {
    case "CHATGPT_DELIVER_PROMPT":
      return answer(startSend(message));

    // Reported by the content script as it watches a chat.
    case "CHATGPT_JOB_UPDATE":
      return answer(patchJob(message.jobId, { state: message.state, detail: message.detail || "" }));

    case "CHATGPT_PACKAGE_READY":
      return answer(receivePackage(message));

    case "CHATGPT_PACKAGE_FAILED":
      return answer(
        patchJob(message.jobId, { state: "failed", error: message.error || "The watch failed." }),
      );

    // From the panel: try the tracker again with the ZIP already in hand.
    case "CHATGPT_RETRY_JOB":
      return answer(fileJob(message.jobId));

    // The watch clicked the card and the file downloaded, but nothing on the
    // page gave up its URL - so ask Chrome what it just downloaded.
    case "CHATGPT_FIND_DOWNLOAD":
      return answer(findDownload(message));

    case "CHATGPT_FORGET_JOB":
      return answer(removeJob(message.jobId));

    default:
      return false;
  }
});

/**
 * A send from the panel. The record is already created by then, so the job is
 * registered here and its id travels with the prompt: whichever tab receives
 * it starts watching for that job's ZIP.
 */
async function startSend(message) {
  const job = message.job ? await createJob(message.job) : null;
  const result = await deliverPrompt(message.text, message.files || [], job ? job.id : null);
  // Only the tab is recorded here. The watch announces its own state as it
  // goes, and by now it may already have moved past "watching" - writing that
  // back over it would be a lie the panel then shows.
  if (job) await patchJob(job.id, { tabId: result.tabId });
  return { ...result, jobId: job ? job.id : null };
}

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
async function queuePrompt(tabId, text, files, jobId) {
  await chrome.storage.local.set({
    pendingPrompt: { text, files, tabId, jobId, createdAt: Date.now() },
  });
}

async function deliverPrompt(text, files = [], jobId = null) {
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
      jobId,
    });
    if (!response?.ok) throw new Error(response?.error || "The ChatGPT tab did not respond.");
    return { detail: response.detail, tabId: existing.id };
  }

  const tab = await chrome.tabs.create({ url: CHATGPT_URL, active: true });
  await queuePrompt(tab.id, trimmed, files, jobId);
  return { detail: "opened a new ChatGPT tab", tabId: tab.id };
}

// ---------------------------------------------------------------------------
// Downloads
//
// Clicking the file card is what downloads the ZIP, but ChatGPT resolves the
// URL in its own code and does not always leave it anywhere the page can be
// read from. Chrome, however, always knows: every download passes through
// here. This is the last of the three ways `content.js` tries to find the
// bytes, and the only one that does not depend on ChatGPT's markup.
// ---------------------------------------------------------------------------

const DOWNLOAD_HISTORY = 20;

if (chrome.downloads) {
  chrome.downloads.onCreated.addListener((item) => {
    rememberDownload(item).catch(() => {});
  });
}

async function rememberDownload(item) {
  const { recentDownloads = [] } = await chrome.storage.local.get("recentDownloads");
  recentDownloads.push({
    url: item.finalUrl || item.url || "",
    filename: item.filename || "",
    at: Date.now(),
  });
  await chrome.storage.local.set({
    recentDownloads: recentDownloads.slice(-DOWNLOAD_HISTORY),
  });
}

/** The newest ZIP Chrome has taken since a watch clicked its card. */
async function findDownload({ since = 0 }) {
  const { recentDownloads = [] } = await chrome.storage.local.get("recentDownloads");
  // A couple of seconds of slack: a download can be registered fractionally
  // before the click that caused it is timestamped in the content script.
  const recent = recentDownloads.filter((entry) => entry.at >= since - 3000 && entry.url);
  const zip = recent.filter((entry) => /\.zip/i.test(entry.filename + " " + entry.url)).pop();
  // Chrome has often not settled on a filename yet when a download is created,
  // and a signed URL carries the name in a query parameter rather than its
  // path - so within this narrow window the newest download stands in. A
  // finished document saved from the panel is named, and is never it.
  const fallback = recent.filter((entry) => !/\.(docx?|pdf)$/i.test(entry.filename)).pop();
  const match = zip || fallback;
  return { url: match ? match.url : "" };
}

// ---------------------------------------------------------------------------
// Job registry
//
// One job is one bid: the tracker record, the chat being watched, and the ZIP
// once it arrives. It all lives in chrome.storage.local because this worker is
// stopped whenever it goes idle - which, over the twenty-odd minutes ChatGPT
// takes, it certainly does.
//
// Reads and writes are chained through `queue` so two tabs finishing at the
// same moment cannot both write a whole map back over each other.
// ---------------------------------------------------------------------------

const JOB_STATES_FINISHED = ["done", "orphan"];
const JOB_HISTORY = 40;
const JOB_KEEP_MS = 24 * 60 * 60 * 1000;

let queue = Promise.resolve();

/** Serialize a read-modify-write of the jobs map. */
function editJobs(mutate) {
  const run = queue.then(async () => {
    const { jobs = {} } = await chrome.storage.local.get("jobs");
    const result = await mutate(jobs);
    await chrome.storage.local.set({ jobs: prune(jobs) });
    return result;
  });
  // A failed edit must not wedge every edit behind it.
  queue = run.catch(() => {});
  return run;
}

/** Finished jobs are history, not state - keep them short and recent. */
function prune(jobs) {
  const entries = Object.entries(jobs).sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
  const kept = entries.filter(([, job], index) => {
    if (index >= JOB_HISTORY) return false;
    if (!JOB_STATES_FINISHED.includes(job.state)) return true;
    return Date.now() - (job.updatedAt || 0) < JOB_KEEP_MS;
  });
  return Object.fromEntries(kept);
}

function createJob(job) {
  const id = job.id || crypto.randomUUID();
  return editJobs((jobs) => {
    jobs[id] = {
      state: "awaiting",
      detail: "",
      error: "",
      createdAt: Date.now(),
      ...jobs[id],
      ...job,
      id,
      updatedAt: Date.now(),
    };
    return jobs[id];
  });
}

function patchJob(id, patch) {
  return editJobs((jobs) => {
    if (!jobs[id]) return null;
    jobs[id] = { ...jobs[id], ...patch, updatedAt: Date.now() };
    return jobs[id];
  });
}

function removeJob(id) {
  return editJobs((jobs) => {
    delete jobs[id];
    return { removed: id };
  });
}

async function getJob(id) {
  const { jobs = {} } = await chrome.storage.local.get("jobs");
  return jobs[id] || null;
}

/** The ZIP has arrived from a watched chat. Park it, then try to file it. */
async function receivePackage(message) {
  const patched = await patchJob(message.jobId, {
    state: "uploading",
    detail: message.name || "package downloaded",
    error: "",
    // Kept until the tracker has taken it, so a retry needs no second download.
    package: { name: message.name, data: message.data || null, url: message.url || "" },
  });
  if (!patched) return { skipped: "unknown job" };
  return fileJob(message.jobId);
}

/**
 * Post the ZIP to the tracker, which unpacks it, runs resume_fill.py over the
 * profile's template, and attaches the resume and the cover letter together.
 */
async function fileJob(id) {
  const job = await getJob(id);
  if (!job) return { skipped: "unknown job" };
  if (!job.package) return { skipped: "nothing downloaded yet" };

  if (!job.applicationId) {
    // Nothing to file it into - the ZIP is in the Downloads folder either way.
    await patchJob(id, {
      state: "orphan",
      detail: "downloaded to your Downloads folder - no tracker record to file it into",
      package: null,
    });
    return { orphan: true };
  }

  await patchJob(id, { state: "uploading", error: "" });
  try {
    const saved = await uploadPackage(job.applicationId, job.package, job.profileName);
    // The documents are the tracker's from here on - the panel says they
    // landed and nothing more, because the record is where they live.
    const detail = saved.coverLetter
      ? "resume and cover letter saved to the tracker"
      : "resume saved to the tracker";
    await patchJob(id, {
      state: "done",
      detail,
      error: (saved.warnings || []).join(" "),
      package: null,
    });
    return { filed: detail };
  } catch (error) {
    // The ZIP stays on the job, so Retry in the panel costs nothing.
    await patchJob(id, { state: "failed", error: String(error.message || error) });
    return { failed: true };
  }
}
