/**
 * Resume-mode assets, shared by the popup (<script src>) and the service
 * worker (importScripts). Everything here ships inside the extension folder,
 * so it is read with fetch(chrome.runtime.getURL(...)) - no file picker and no
 * filesystem access needed.
 */

const RESUME_TEMPLATES = [
  {
    id: "adam",
    label: "Adam Corey Everitte",
    path: "Temp/Temp_Adam Corey Everitte.docx",
  },
  {
    id: "cody",
    label: "Cody Tylor Wolfe",
    path: "Temp/Temp_Cody Tylor Wolfe.docx",
  },
  {
    id: "russell",
    label: "Russell Aaron Turner",
    path: "Temp/Temp_Russell Aaron Turner.docx",
  },
];

const GENERATOR_PROMPT_PATH = "Resume Generator Prompt.txt";

/** The fixed opening line the job description is appended to. */
const START_PROMPT =
  "Give me tailored resume based on attached file and JD :";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** The wrapper the job description gets dropped into. */
function buildResumePrompt(jobDescription) {
  return START_PROMPT + " " + jobDescription.trim();
}

function templateById(id) {
  return RESUME_TEMPLATES.find((t) => t.id === id) || RESUME_TEMPLATES[0];
}

function bytesToBase64(bytes) {
  // Chunked: String.fromCharCode(...bytes) blows the argument limit on big files.
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Read a file bundled with the extension into the base64 attachment shape. */
async function loadBundledFile(path, mime) {
  // encodeURI because these names carry spaces and parentheses.
  const response = await fetch(chrome.runtime.getURL(encodeURI(path)));
  if (!response.ok) {
    throw new Error('Bundled file missing from the extension folder: "' + path + '".');
  }
  const buffer = await response.arrayBuffer();
  return {
    name: path.split("/").pop(),
    type: mime,
    lastModified: Date.now(),
    data: bytesToBase64(new Uint8Array(buffer)),
  };
}

/**
 * The two files every resume-mode prompt carries, in the order the generator
 * prompt expects to see them: the DOCX template first, instructions second.
 */
async function buildResumeAttachments(templateId) {
  const template = templateById(templateId);
  return [
    await loadBundledFile(template.path, DOCX_MIME),
    await loadBundledFile(GENERATOR_PROMPT_PATH, "text/plain"),
  ];
}
