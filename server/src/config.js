import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const here = path.dirname(fileURLToPath(import.meta.url));
export const serverRoot = path.resolve(here, '..');
export const repoRoot = path.resolve(serverRoot, '..');

// The Chrome extension folder doubles as the resume toolkit: it holds the DOCX
// templates the generator was seeded with and the script that fills them.
const extensionDir = path.resolve(repoRoot, 'Chatgpt Extension');

export const config = {
  port: Number(process.env.PORT || 5000),
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/resume_tracker',
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  uploadDir: path.resolve(serverRoot, process.env.UPLOAD_DIR || 'uploads'),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 15) * 1024 * 1024,

  // ZIP packages arrive whole, so they get their own (larger) ceiling.
  maxPackageBytes: Number(process.env.MAX_PACKAGE_MB || 25) * 1024 * 1024,
  templatesDir: path.resolve(serverRoot, process.env.TEMPLATES_DIR || path.join(extensionDir, 'Temp')),
  resumeFillScript: path.resolve(
    serverRoot,
    process.env.RESUME_FILL_SCRIPT || path.join(extensionDir, 'resume_fill.py'),
  ),
  pythonBin: process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3'),
  // Several bids can land at once; each one spawns python, so cap how many run
  // together rather than letting a burst of tabs fork a process per request.
  packageConcurrency: Math.max(1, Number(process.env.PACKAGE_CONCURRENCY || 3)),
  packageTimeoutMs: Number(process.env.PACKAGE_TIMEOUT_MS || 120000),
};

/**
 * True for an origin the API will answer. Exact entries come from CORS_ORIGIN;
 * the literal `chrome-extension://*` there allows the whole scheme, because an
 * unpacked extension's id is only known once Chrome has loaded the folder.
 * Swap it for the real `chrome-extension://<id>` once you have one.
 */
export function isAllowedOrigin(origin) {
  // No Origin header: curl, same-origin, and the extension's service worker.
  if (!origin) return true;
  if (config.corsOrigins.includes(origin)) return true;
  return (
    config.corsOrigins.includes('chrome-extension://*') &&
    origin.startsWith('chrome-extension://')
  );
}

// The fixed roster of profiles a resume can be filed under. These are the same
// people as the Chrome extension's RESUME_TEMPLATES, and the names must match
// it exactly - the extension files each application under its template's name.
export const PROFILES = ['Adam Corey Everitte', 'Cody Tylor Wolfe', 'Russell Aaron Turner'];

export const STATUSES = ['applied', 'interview', 'offer', 'rejected'];

/**
 * The DOCX resume_fill.py fills for a profile. Same naming as the files the
 * extension attaches (`Temp_<name>.docx`), so a new profile needs no code -
 * drop the template in, add the name to PROFILES and to RESUME_TEMPLATES.
 */
export function templatePathFor(profileName) {
  return path.join(config.templatesDir, `Temp_${profileName}.docx`);
}
