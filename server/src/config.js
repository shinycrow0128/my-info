import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const here = path.dirname(fileURLToPath(import.meta.url));
export const serverRoot = path.resolve(here, '..');

export const config = {
  port: Number(process.env.PORT || 5000),
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/resume_tracker',
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  uploadDir: path.resolve(serverRoot, process.env.UPLOAD_DIR || 'uploads'),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 15) * 1024 * 1024,
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
