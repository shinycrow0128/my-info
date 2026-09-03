const promptEl = document.getElementById("prompt");
const sendEl = document.getElementById("send");
const statusEl = document.getElementById("status");
const templateEl = document.getElementById("template");

const saveTrackEl = document.getElementById("save-track");
const trackFieldsEl = document.getElementById("track-fields");
const trackErrorEl = document.getElementById("track-error");
const trackRetryEl = document.getElementById("track-retry");
const retryMetaEl = document.getElementById("retry-meta");
const profileNameEl = document.getElementById("profile-name");
const statusSelectEl = document.getElementById("track-status");
const jobTitleEl = document.getElementById("job-title");
const companyEl = document.getElementById("company");
const jobLinkEl = document.getElementById("job-link");
const appliedAtEl = document.getElementById("applied-at");
const resumeFileEl = document.getElementById("resume-file");
const notesEl = document.getElementById("notes");

const popoutEl = document.getElementById("popout");

const pendingEl = document.getElementById("pending");
const pendingTitleEl = document.getElementById("pending-title");
const pendingFileEl = document.getElementById("pending-file");
const pendingAttachEl = document.getElementById("pending-attach");
const pendingDismissEl = document.getElementById("pending-dismiss");

// Fields the tracker section keeps across an accidental popup close. The
// page-derived ones are re-read from the tab instead when it has moved on.
const TRACK_DRAFT_FIELDS = ["jobTitle", "company", "jobLink", "appliedAt", "notes"];
const PAGE_DERIVED = ["jobTitle", "company", "jobLink"];

// The same page serves the docked side panel and the popped-out window; the
// window is the one opened with ?view=window, and it has nothing to pop out of.
const IS_POPOUT = new URLSearchParams(location.search).get("view") === "window";

const POPOUT_WIDTH = 420;

let metaLoaded = false;

// What the page last suggested, so a hand-typed field is never overwritten
// when you move to the next listing.
let pageGuess = { jobTitle: "", company: "", jobLink: "" };

for (const template of RESUME_TEMPLATES) {
  const option = document.createElement("option");
  option.value = template.id;
  option.textContent = template.label;
  templateEl.append(option);
}

init();

async function init() {
  const stored = await chrome.storage.local.get([
    "draft",
    "templateId",
    "trackProfile",
    "trackStatus",
    "trackDraft",
    "pendingApplication",
  ]);

  if (stored.draft) promptEl.value = stored.draft;
  if (stored.templateId) templateEl.value = stored.templateId;

  popoutEl.hidden = IS_POPOUT;
  renderPending(stored.pendingApplication);
  promptEl.focus();

  await fillTrackFields(stored);
  // The roster is the server's; without it the Profile dropdown stays empty.
  await loadMeta(stored);
}

/**
 * Job title, company and link come from the page you are looking at. A saved
 * draft only wins if you are still on the tab it was typed against - otherwise
 * it would put the previous job's title on this one.
 */
async function fillTrackFields(stored) {
  const draft = stored.trackDraft || {};
  const tab = await activeTab();
  const sameTab = Boolean(tab && draft.url && draft.url === tab.url);
  const guess = tab ? guessFromTab(tab) : { jobTitle: "", company: "", jobLink: "" };
  pageGuess = guess;

  for (const key of TRACK_DRAFT_FIELDS) {
    const keepDraft = sameTab || !PAGE_DERIVED.includes(key);
    const saved = keepDraft ? draft[key] : undefined;
    trackInput(key).value = saved ? saved : guess[key] || "";
  }

  if (!appliedAtEl.value) appliedAtEl.value = todayInput();
}

async function loadMeta(stored) {
  try {
    const meta = await fetchTrackerMeta();
    fillSelect(profileNameEl, meta.profiles, stored.trackProfile, "Select a profile…");
    fillSelect(statusSelectEl, meta.statuses, stored.trackStatus || "applied");
    // The template is the profile, and it is the one the user already picked -
    // so it wins over whatever was stored.
    syncProfileToTemplate();
    metaLoaded = true;
    setTrackError("");
  } catch (error) {
    setTrackError(String(error.message || error));
  }
}

function fillSelect(select, values, selected, placeholder) {
  select.textContent = "";
  if (placeholder) {
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = placeholder;
    select.append(blank);
  }
  for (const value of values || []) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.append(option);
  }
  if (selected && (values || []).includes(selected)) select.value = selected;
}

function trackInput(key) {
  return {
    jobTitle: jobTitleEl,
    company: companyEl,
    jobLink: jobLinkEl,
    appliedAt: appliedAtEl,
    notes: notesEl,
  }[key];
}

/** A chrome:// or extension page has nothing worth lifting off it. */
function isPage(tab) {
  return Boolean(tab && /^https?:/.test(tab.url || ""));
}

/**
 * The page the user is actually looking at. In the side panel that is simply
 * the active tab of the window the panel is docked in. The popped-out window
 * is its own window, whose "active tab" is this very page - so it falls back
 * to a real browser window, preferring the focused one.
 */
async function activeTab() {
  const [here] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (isPage(here)) return here;

  const windows = await chrome.windows.getAll({
    populate: true,
    windowTypes: ["normal"],
  });
  const ordered = [...windows].sort((a, b) => Number(b.focused) - Number(a.focused));
  for (const win of ordered) {
    const tab = (win.tabs || []).find((t) => t.active);
    if (isPage(tab)) return tab;
  }
  return null;
}

/**
 * Job boards title their pages "<role> at <company> | <board>" often enough
 * that this saves most of the typing. It is a guess, and always editable.
 */
function guessFromTab(tab) {
  // LinkedIn prefixes an unread count; the board's own name trails the title.
  const raw = (tab.title || "").replace(/^\(\d+\)\s*/, "").trim();
  const head = raw.split(/\s+[|·]\s+/)[0].trim();
  const split =
    /^(.+?)\s+(?:at|@)\s+(.+)$/i.exec(head) || /^(.+?)\s+[-–]\s+(.+)$/.exec(head);

  return {
    jobTitle: split ? split[1].trim() : head,
    company: split ? split[2].trim() : "",
    jobLink: tab.url || "",
  };
}

/** "Today" where the user is - toISOString rolls over early behind UTC. */
function todayInput() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return now.getFullYear() + "-" + month + "-" + day;
}

/**
 * Follow the browser: a panel that stays open while you click through job
 * listings should show the listing in front of you. Fields you have edited
 * yourself are left alone - only untouched ones move to the new page.
 */
async function refreshFromPage() {
  const tab = await activeTab();
  if (!tab) return;

  const next = guessFromTab(tab);
  for (const key of PAGE_DERIVED) {
    const el = trackInput(key);
    if (el.value === "" || el.value === pageGuess[key]) el.value = next[key];
  }
  pageGuess = next;
  saveTrackDraft();
}

chrome.tabs.onActivated.addListener(refreshFromPage);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  // Title and URL arrive separately, and often after the tab first opens.
  if (tab.active && (changeInfo.url || changeInfo.title)) refreshFromPage();
});
// The popped-out window follows whichever browser window you focus.
chrome.windows.onFocusChanged.addListener(refreshFromPage);

promptEl.addEventListener("input", () => {
  chrome.storage.local.set({ draft: promptEl.value });
});

// The template choice is stored so the context menu can use it too.
templateEl.addEventListener("change", () => {
  chrome.storage.local.set({ templateId: templateEl.value });
  syncProfileToTemplate();
});

/**
 * A tracker profile and a resume template are the same person - the two lists
 * hold the same names on purpose - so the two dropdowns move together. Setting
 * `.value` fires no change event, so neither direction loops.
 */
function syncProfileToTemplate() {
  const label = templateById(templateEl.value).label;
  if (![...profileNameEl.options].some((option) => option.value === label)) {
    // The server's roster is the authority; it may not know this template yet.
    return false;
  }
  profileNameEl.value = label;
  chrome.storage.local.set({ trackProfile: label });
  return true;
}

function syncTemplateToProfile() {
  const template = RESUME_TEMPLATES.find((t) => t.label === profileNameEl.value);
  if (!template) return false;
  templateEl.value = template.id;
  chrome.storage.local.set({ templateId: template.id });
  return true;
}

// A tracker that was down when the panel opened gets another chance here.
retryMetaEl.addEventListener("click", async () => {
  retryMetaEl.disabled = true;
  setTrackError("Reaching the tracker…");
  await loadMeta(await chrome.storage.local.get(["trackProfile", "trackStatus"]));
  retryMetaEl.disabled = false;
});

profileNameEl.addEventListener("change", () => {
  chrome.storage.local.set({ trackProfile: profileNameEl.value });
  syncTemplateToProfile();
});

statusSelectEl.addEventListener("change", () => {
  chrome.storage.local.set({ trackStatus: statusSelectEl.value });
});

for (const key of TRACK_DRAFT_FIELDS) {
  trackInput(key).addEventListener("input", saveTrackDraft);
}

promptEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    send();
  }
});

sendEl.addEventListener("click", send);
saveTrackEl.addEventListener("click", saveApplication);
popoutEl.addEventListener("click", openPopout);
pendingAttachEl.addEventListener("click", attachPendingResume);
pendingDismissEl.addEventListener("click", () => {
  chrome.storage.local.remove("pendingApplication");
  renderPending(null);
});

/**
 * Reopen the panel as a window pinned to the right edge of the screen. Chrome
 * cannot keep it above other windows, but it survives tab switches and can sit
 * beside a ChatGPT window or on a second monitor.
 */
async function openPopout() {
  const { popoutWindowId } = await chrome.storage.local.get("popoutWindowId");
  if (popoutWindowId) {
    try {
      await chrome.windows.update(popoutWindowId, { focused: true });
      window.close();
      return;
    } catch {
      // It was closed since; fall through and make a new one.
    }
  }

  // availLeft matters on a multi-monitor setup: it is not always 0.
  const created = await chrome.windows.create({
    url: chrome.runtime.getURL("popup.html?view=window"),
    type: "popup",
    width: POPOUT_WIDTH,
    height: Math.max(400, screen.availHeight - 60),
    left: Math.max(0, (screen.availLeft || 0) + screen.availWidth - POPOUT_WIDTH),
    top: screen.availTop || 0,
  });

  await chrome.storage.local.set({ popoutWindowId: created.id });
  // Popping out replaces the panel rather than duplicating it.
  window.close();
}

async function saveTrackDraft() {
  const tab = await activeTab();
  const trackDraft = { url: tab ? tab.url : "" };
  for (const key of TRACK_DRAFT_FIELDS) trackDraft[key] = trackInput(key).value;
  chrome.storage.local.set({ trackDraft });
}

function renderPending(pending) {
  if (!pending || !pending.id) {
    pendingEl.hidden = true;
    return;
  }
  pendingTitleEl.textContent = pending.label || "last application";
  pendingFileEl.value = "";
  pendingEl.hidden = false;
}

function setTrackError(text) {
  trackErrorEl.textContent = text;
  trackErrorEl.hidden = !text;
  // Nothing to retry once the roster is in.
  trackRetryEl.hidden = metaLoaded || !text;
}

function setStatus(text, state = "") {
  statusEl.textContent = text;
  statusEl.dataset.state = state;
}

function setBusy(busy) {
  // Both buttons rest while either one is working - they share a status line.
  sendEl.disabled = busy;
  saveTrackEl.disabled = busy;
  templateEl.disabled = busy;
  promptEl.disabled = busy;
  for (const el of trackFieldsEl.querySelectorAll("input, select, textarea")) {
    el.disabled = busy;
  }
}

/** Throws with the message the popup should show; the server checks these too. */
function readTrackFields(jobDescription) {
  if (!profileNameEl.value) throw new Error("Pick a profile for the tracker.");
  if (!jobTitleEl.value.trim()) throw new Error("The tracker needs a job title.");

  return {
    profileName: profileNameEl.value,
    jobTitle: jobTitleEl.value.trim(),
    company: companyEl.value.trim(),
    jobLink: jobLinkEl.value.trim(),
    jobDescription,
    status: statusSelectEl.value,
    appliedAt: appliedAtEl.value,
    notes: notesEl.value,
  };
}

async function send() {
  const input = promptEl.value.trim();

  if (!input) {
    setStatus("Paste the job description first.", "error");
    promptEl.focus();
    return;
  }

  setBusy(true);
  setStatus("Preparing…");

  try {
    // Bundled resume files, in the order the generator prompt expects. There
    // is no send without them - a naked JD gets a resume for whoever ChatGPT
    // happens to remember.
    const files = await buildResumeAttachments(templateEl.value);
    const text = buildResumePrompt(input);

    setStatus("Uploading…");

    const response = await chrome.runtime.sendMessage({
      type: "CHATGPT_DELIVER_PROMPT",
      text,
      files,
    });

    if (!response?.ok) throw new Error(response?.error || "Unknown error.");

    // The box is left alone: Save to tracker reads the job description out of
    // it, and it is paste-over-able for the next job either way.
    setStatus("Done - " + response.detail + ".", "ok");
  } catch (error) {
    setStatus(String(error.message || error), "error");
  } finally {
    setBusy(false);
  }
}

/**
 * Files the application. Independent of the ChatGPT send - either order works,
 * and neither button touches the other's fields. The job description is read
 * from the prompt box, which is why sending does not empty it while the
 * tracker section is open.
 */
async function saveApplication() {
  let fields;
  try {
    fields = readTrackFields(promptEl.value.trim());
  } catch (error) {
    setStatus(error.message, "error");
    return;
  }

  const file = resumeFileEl.files[0] || null;

  setBusy(true);
  setStatus("Saving to the tracker…");

  let saved;
  try {
    saved = await createApplication(fields, file);
  } catch (error) {
    setStatus(String(error.message || error), "error");
    return;
  } finally {
    setBusy(false);
  }

  await clearTrackDraft();

  if (file) {
    setStatus("Saved to the tracker with the resume.", "ok");
    return;
  }

  // No file yet: park the id so the next popup visit can attach the real one.
  await chrome.storage.local.set({
    pendingApplication: {
      id: saved.id,
      label: [saved.jobTitle, saved.company].filter(Boolean).join(" - "),
      createdAt: Date.now(),
    },
  });
  setStatus("Saved. Attach the resume from this panel once you have it.", "ok");
}

async function clearTrackDraft() {
  await chrome.storage.local.remove("trackDraft");
  for (const key of TRACK_DRAFT_FIELDS) trackInput(key).value = "";
  resumeFileEl.value = "";
  appliedAtEl.value = todayInput();
}

async function attachPendingResume() {
  const file = pendingFileEl.files[0] || null;
  if (!file) {
    setStatus("Pick the resume file to attach.", "error");
    return;
  }

  const { pendingApplication } = await chrome.storage.local.get("pendingApplication");
  if (!pendingApplication) return renderPending(null);

  pendingAttachEl.disabled = true;
  setStatus("Attaching…");
  try {
    await attachResume(pendingApplication.id, file);
    await chrome.storage.local.remove("pendingApplication");
    renderPending(null);
    setStatus("Resume attached.", "ok");
  } catch (error) {
    setStatus(String(error.message || error), "error");
  } finally {
    pendingAttachEl.disabled = false;
  }
}
