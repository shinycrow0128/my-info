/**
 * The side panel: one form, one button.
 *
 * Filing a bid and generating its documents used to be two separate actions.
 * They are one now - "Send to ChatGPT" files the application from the fields
 * above it and sends the job description in the same click. The resume and the
 * cover letter are neither asked for nor handed back here: they are written by
 * the server onto the tracker record, and the panel only reports that they
 * were. The tracker UI is where a filed bid is read.
 */

const promptEl = document.getElementById("prompt");
const sendEl = document.getElementById("send");
const statusEl = document.getElementById("status");

const trackErrorEl = document.getElementById("track-error");
const trackRetryEl = document.getElementById("track-retry");
const retryMetaEl = document.getElementById("retry-meta");
const profileNameEl = document.getElementById("profile-name");
const statusSelectEl = document.getElementById("track-status");
const jobTitleEl = document.getElementById("job-title");
const companyEl = document.getElementById("company");
const jobLinkEl = document.getElementById("job-link");
const appliedAtEl = document.getElementById("applied-at");
const notesEl = document.getElementById("notes");

const popoutEl = document.getElementById("popout");

const jobsEl = document.getElementById("jobs");

// Fields the form keeps across an accidental panel close. The page-derived
// ones are re-read from the tab instead when it has moved on.
const TRACK_DRAFT_FIELDS = ["jobTitle", "company", "jobLink", "appliedAt", "notes"];
const PAGE_DERIVED = ["jobTitle", "company", "jobLink"];

// Everything the send disables while it runs.
const FORM_ELEMENTS = [
  promptEl,
  profileNameEl,
  statusSelectEl,
  jobTitleEl,
  companyEl,
  jobLinkEl,
  appliedAtEl,
  notesEl,
];

// The same page serves the docked side panel and the popped-out window; the
// window is the one opened with ?view=window, and it has nothing to pop out of.
const IS_POPOUT = new URLSearchParams(location.search).get("view") === "window";

const POPOUT_WIDTH = 420;

let metaLoaded = false;

// What the page last suggested, so a hand-typed field is never overwritten
// when you move to the next listing.
let pageGuess = { jobTitle: "", company: "", jobLink: "" };

init();

async function init() {
  const stored = await chrome.storage.local.get([
    "draft",
    "trackProfile",
    "trackStatus",
    "trackDraft",
    "jobs",
  ]);

  if (stored.draft) promptEl.value = stored.draft;

  popoutEl.hidden = IS_POPOUT;
  renderJobs(stored.jobs);
  promptEl.focus();

  // The bundled templates are the offline-safe roster: a profile can be picked
  // - and so a prompt sent - even with the tracker down.
  fillProfiles(
    RESUME_TEMPLATES.map((template) => template.label),
    stored.trackProfile,
  );
  await fillTrackFields(stored);
  // The server's own roster wins once it answers; it is what the API validates.
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
    // A name this build has no template for is still offered - it files fine,
    // it just falls back to a bundled template for the ChatGPT attachment.
    const profiles = [
      ...new Set([...(meta.profiles || []), ...RESUME_TEMPLATES.map((t) => t.label)]),
    ];
    fillProfiles(profiles, profileNameEl.value || stored.trackProfile);
    fillSelect(statusSelectEl, meta.statuses, stored.trackStatus || "applied");
    metaLoaded = true;
    setTrackError("");
  } catch (error) {
    setTrackError(String(error.message || error));
  }
}

/**
 * The profile is the resume template as well - the two lists hold the same
 * names on purpose - so choosing one here settles both, and the context menu
 * (which has no panel to read) picks the template up from storage.
 */
function fillProfiles(profiles, selected) {
  fillSelect(profileNameEl, profiles, selected, "Select a profile…");
  rememberProfile();
}

function rememberProfile() {
  const profileName = profileNameEl.value;
  const patch = { trackProfile: profileName };
  const template = RESUME_TEMPLATES.find((t) => t.label === profileName);
  if (template) patch.templateId = template.id;
  chrome.storage.local.set(patch);
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

// ChatGPT's own tabs. Guessing a job title off one gives "ChatGPT", which is
// then what the bid is filed and labelled as - so they are skipped like a
// chrome:// page is.
const OWN_TABS = /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//;

/** A page worth lifting a job listing off: not chrome://, not ChatGPT itself. */
function isPage(tab) {
  const url = (tab && tab.url) || "";
  return /^https?:/.test(url) && !OWN_TABS.test(url);
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

// A tracker that was down when the panel opened gets another chance here.
retryMetaEl.addEventListener("click", async () => {
  retryMetaEl.disabled = true;
  setTrackError("Reaching the tracker…");
  await loadMeta(await chrome.storage.local.get(["trackProfile", "trackStatus"]));
  retryMetaEl.disabled = false;
});

profileNameEl.addEventListener("change", rememberProfile);

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
popoutEl.addEventListener("click", openPopout);

// The jobs are written by the service worker as each watch reports in, so the
// panel follows storage rather than polling anything.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.jobs) renderJobs(changes.jobs.newValue);
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

/* -------------------------------------------------------------------------
   Bids in flight

   One row per application that is still waiting on its documents - sent and
   being watched, downloaded and being filed, or stuck. It says how far the bid
   got and nothing else: the documents themselves belong to the tracker record,
   which is where they are read from. Several bids run at once, so this is a
   list, and a stuck row carries its own way out.
   ------------------------------------------------------------------------- */

const JOB_STATE_LABELS = {
  awaiting: "waiting",
  watching: "watching chat",
  downloading: "downloading",
  uploading: "filing",
  done: "filed",
  failed: "failed",
  orphan: "downloaded",
};

const FINISHED_STATES = ["done", "orphan"];
const FINISHED_SHOWN = 3;

/**
 * Everything still in flight, plus the last few that landed. On a busy day the
 * finished rows would otherwise bury the bids that still need something.
 */
function renderJobs(jobs) {
  const list = Object.values(jobs || {}).sort(
    (a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0),
  );
  let finished = 0;
  const shown = list.filter((job) => {
    if (!FINISHED_STATES.includes(job.state)) return true;
    finished += 1;
    return finished <= FINISHED_SHOWN;
  });

  jobsEl.textContent = "";
  jobsEl.hidden = !shown.length;
  for (const job of shown) jobsEl.append(jobRow(job));
}

async function refreshJobs() {
  const { jobs } = await chrome.storage.local.get("jobs");
  renderJobs(jobs);
}

function linkButton(text, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "link";
  button.textContent = text;
  button.addEventListener("click", onClick);
  return button;
}

function jobRow(job) {
  const row = document.createElement("div");
  row.className = "job";
  row.dataset.state = job.state;

  const head = document.createElement("div");
  head.className = "job-head";
  const label = document.createElement("span");
  label.className = "job-label";
  label.textContent = job.label || "Untitled bid";
  label.title = label.textContent;
  const state = document.createElement("span");
  state.className = "job-state";
  state.textContent = JOB_STATE_LABELS[job.state] || job.state;
  head.append(label, state);

  const detail = document.createElement("p");
  detail.className = "job-detail";
  detail.textContent = job.error || job.detail || "";
  detail.hidden = !detail.textContent;

  row.append(head, detail);

  const actions = document.createElement("div");
  actions.className = "job-actions";

  // Retrying costs nothing: the ZIP is still on the job until the tracker
  // has taken it.
  if (job.state === "failed" && job.package) {
    actions.append(linkButton("Retry", () => retryJob(job.id)));
  }
  actions.append(linkButton("Dismiss", () => forgetJob(job.id)));
  row.append(actions);

  return row;
}

function forgetJob(id) {
  return chrome.runtime.sendMessage({ type: "CHATGPT_FORGET_JOB", jobId: id });
}

async function retryJob(id) {
  setStatus("Filing into the tracker…");
  const response = await chrome.runtime.sendMessage({ type: "CHATGPT_RETRY_JOB", jobId: id });
  setStatus(
    response?.ok ? "Retried." : String(response?.error || "Retry failed."),
    response?.ok ? "ok" : "error",
  );
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
  sendEl.disabled = busy;
  for (const el of FORM_ELEMENTS) el.disabled = busy;
}

/** Throws with the message the panel should show; the server checks these too. */
function readTrackFields(jobDescription) {
  if (!profileNameEl.value) throw new Error("Pick a profile first.");
  if (!jobTitleEl.value.trim()) throw new Error("The job title is needed to file this one.");

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

/**
 * The one action: file the application, then send its job description to
 * ChatGPT with the profile's resume template attached. The record is created
 * first because the ZIP comes back minutes from now and needs somewhere to
 * land - its id rides along with the send.
 */
async function send() {
  const jobDescription = promptEl.value.trim();

  if (!jobDescription) {
    setStatus("Paste the job description first.", "error");
    promptEl.focus();
    return;
  }

  let fields;
  try {
    fields = readTrackFields(jobDescription);
  } catch (error) {
    setStatus(error.message, "error");
    return;
  }

  setBusy(true);
  setStatus("Preparing…");

  try {
    // Bundled resume files, in the order the generator prompt expects. There
    // is no send without them - a naked JD gets a resume for whoever ChatGPT
    // happens to remember.
    const files = await buildResumeAttachments(templateIdFor(fields.profileName));
    const job = await ensureApplication(fields);

    setStatus("Uploading…");

    const response = await chrome.runtime.sendMessage({
      type: "CHATGPT_DELIVER_PROMPT",
      text: buildResumePrompt(jobDescription),
      files,
      job,
    });

    if (!response?.ok) throw new Error(response?.error || "Unknown error.");

    // Filed and sent: the form empties for the next listing, and the row in
    // the list above is where this bid is followed from here.
    await clearForm();
    await refreshJobs();
    setStatus("Filed " + job.label + " - " + response.detail + ".", "ok");
  } catch (error) {
    setStatus(String(error.message || error), "error");
  } finally {
    setBusy(false);
  }
}

/** The bundled template for a profile; the roster may know names this build does not. */
function templateIdFor(profileName) {
  const template = RESUME_TEMPLATES.find((t) => t.label === profileName);
  return template ? template.id : RESUME_TEMPLATES[0].id;
}

/**
 * The record this bid files into. A job filed by a send that failed before it
 * reached ChatGPT is reused rather than duplicated, so pressing the button
 * again after a missing tab is still one application.
 */
async function ensureApplication(fields) {
  const reusable = await findReusableJob(fields);
  if (reusable) return reusable;

  const saved = await createApplication(fields);
  return {
    applicationId: saved.id,
    label: labelFor(saved),
    profileName: saved.profileName,
    jobTitle: saved.jobTitle,
    company: saved.company,
  };
}

/** The same job, filed but never sent - matched on what the user typed. */
async function findReusableJob(fields) {
  const { jobs } = await chrome.storage.local.get("jobs");
  const match = Object.values(jobs || {}).find(
    (job) =>
      job.state === "awaiting" &&
      job.applicationId &&
      job.profileName === fields.profileName &&
      job.jobTitle === fields.jobTitle &&
      (job.company || "") === (fields.company || ""),
  );
  return match
    ? {
        id: match.id,
        applicationId: match.applicationId,
        label: match.label,
        profileName: match.profileName,
        jobTitle: match.jobTitle,
        company: match.company,
      }
    : null;
}

function labelFor(saved) {
  return [saved.jobTitle, saved.company].filter(Boolean).join(" - ") || "Untitled bid";
}

/** Emptied on a send that went through, ready for the next listing. */
async function clearForm() {
  await chrome.storage.local.remove(["trackDraft", "draft"]);
  for (const key of TRACK_DRAFT_FIELDS) trackInput(key).value = "";
  promptEl.value = "";
  appliedAtEl.value = todayInput();
  // Nothing is hand-typed any more, so the listing on screen fills the
  // page-derived fields again.
  pageGuess = { jobTitle: "", company: "", jobLink: "" };
  await refreshFromPage();
}
