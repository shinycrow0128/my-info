const promptEl = document.getElementById("prompt");
const promptLabelEl = document.getElementById("prompt-label");
const sendEl = document.getElementById("send");
const statusEl = document.getElementById("status");
const resumeModeEl = document.getElementById("resume-mode");
const resumeFieldsEl = document.getElementById("resume-fields");
const templateEl = document.getElementById("template");
const autoFilesEl = document.getElementById("auto-files");
const attachFilesEl = document.getElementById("attach-files");
const startPromptEl = document.getElementById("start-prompt");
const resetStartPromptEl = document.getElementById("reset-start-prompt");

for (const template of RESUME_TEMPLATES) {
  const option = document.createElement("option");
  option.value = template.id;
  option.textContent = template.label;
  templateEl.append(option);
}

chrome.storage.local
  .get(["draft", "resumeMode", "attachFiles", "templateId", "startPrompt"])
  .then(({ draft, resumeMode, attachFiles, templateId, startPrompt }) => {
    if (draft) promptEl.value = draft;
    resumeModeEl.checked = resumeMode !== false;
    attachFilesEl.checked = attachFiles !== false;
    if (templateId) templateEl.value = templateId;
    startPromptEl.value = startPrompt || DEFAULT_START_PROMPT;
    renderMode();
    promptEl.focus();
  });

promptEl.addEventListener("input", () => {
  chrome.storage.local.set({ draft: promptEl.value });
});

// Stored so the context menu wraps its selection the same way.
startPromptEl.addEventListener("input", () => {
  chrome.storage.local.set({ startPrompt: startPromptEl.value });
});

resetStartPromptEl.addEventListener("click", () => {
  startPromptEl.value = DEFAULT_START_PROMPT;
  chrome.storage.local.remove("startPrompt");
  startPromptEl.focus();
});

// The template choice is stored so the context menu can use it too.
templateEl.addEventListener("change", () => {
  chrome.storage.local.set({ templateId: templateEl.value });
  renderMode();
});

resumeModeEl.addEventListener("change", () => {
  chrome.storage.local.set({ resumeMode: resumeModeEl.checked });
  renderMode();
});

// Stored so the context menu attaches (or skips) the same files.
attachFilesEl.addEventListener("change", () => {
  chrome.storage.local.set({ attachFiles: attachFilesEl.checked });
  renderMode();
});

promptEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    send();
  }
});

sendEl.addEventListener("click", send);

/** Resume mode swaps the labels and shows what will be attached for you. */
function renderMode() {
  const on = resumeModeEl.checked;

  resumeFieldsEl.hidden = !on;
  promptLabelEl.textContent = on ? "Job description" : "Prompt";
  promptEl.placeholder = on
    ? "Paste the job description here…"
    : "Type or paste the text to send to ChatGPT…";

  if (on && attachFilesEl.checked) {
    autoFilesEl.textContent = "";
    autoFilesEl.append(
      document.createTextNode("Attaches automatically: "),
      strong(templateById(templateEl.value).path.split("/").pop()),
      document.createTextNode(" + "),
      strong(GENERATOR_PROMPT_PATH)
    );
  } else {
    autoFilesEl.textContent = "";
  }
}

function strong(text) {
  const el = document.createElement("b");
  el.textContent = text;
  return el;
}

function setStatus(text, state = "") {
  statusEl.textContent = text;
  statusEl.dataset.state = state;
}

function setBusy(busy) {
  sendEl.disabled = busy;
  startPromptEl.disabled = busy;
  attachFilesEl.disabled = busy;
}

async function send() {
  const resumeMode = resumeModeEl.checked;
  const input = promptEl.value.trim();

  if (!input) {
    setStatus(
      resumeMode ? "Paste the job description first." : "Type something first.",
      "error"
    );
    promptEl.focus();
    return;
  }

  setBusy(true);
  setStatus("Preparing…");

  try {
    // Bundled resume files, in the order the generator prompt expects.
    const files =
      resumeMode && attachFilesEl.checked
        ? await buildResumeAttachments(templateEl.value)
        : [];
    const text = resumeMode
      ? buildResumePrompt(input, startPromptEl.value)
      : input;

    setStatus(files.length ? "Uploading…" : "Sending…");

    const response = await chrome.runtime.sendMessage({
      type: "CHATGPT_DELIVER_PROMPT",
      text,
      files,
    });

    if (!response?.ok) throw new Error(response?.error || "Unknown error.");

    setStatus("Done - " + response.detail + ".", "ok");
    promptEl.value = "";
    await chrome.storage.local.remove("draft");
    setTimeout(() => window.close(), 900);
  } catch (error) {
    setStatus(String(error.message || error), "error");
  } finally {
    setBusy(false);
  }
}
