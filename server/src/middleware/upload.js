import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { config } from '../config.js';

fs.mkdirSync(config.uploadDir, { recursive: true });

const ALLOWED_EXT = new Set(['.docx', '.doc', '.pdf']);

/** The on-disk name for an upload: unique, but keeping the original extension. */
export function storedNameFor(originalName) {
  const ext = path.extname(originalName).toLowerCase();
  return `${Date.now()}-${crypto.randomUUID()}${ext}`;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.uploadDir),
  filename: (_req, file, cb) => cb(null, storedNameFor(file.originalname)),
});

/**
 * Both documents ride on the same multipart request. `resume` alone still
 * works, which is what the extension's older attach call sends.
 */
export const uploadDocuments = multer({
  storage,
  limits: { fileSize: config.maxUploadBytes },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      cb(new Error(`Unsupported file type "${ext}". Upload a .docx, .doc or .pdf file.`));
      return;
    }
    cb(null, true);
  },
}).fields([
  { name: 'resume', maxCount: 1 },
  { name: 'coverLetter', maxCount: 1 },
]);

/**
 * The generator's ZIP. It is unpacked and thrown away rather than stored, so it
 * stays in memory - and it gets its own size limit, being an archive of two.
 */
export const uploadPackage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxPackageBytes },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext && ext !== '.zip') {
      cb(new Error(`Expected the generator's .zip, got "${ext}".`));
      return;
    }
    cb(null, true);
  },
}).single('package');
