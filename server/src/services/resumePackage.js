/**
 * Turns the generator's ZIP into the two documents an application is filed
 * with.
 *
 * The prompt (`Resume Generator Prompt.txt`) contracts ChatGPT to return one
 * `Resume_Package_<Candidate>.zip` holding `resume_content.json` and
 * `Cover_Letter_<Candidate>.docx` - a resume DOCX is deliberately NOT in it,
 * because the layout comes from this repo's own template. So the JSON is poured
 * into `Temp_<profile>.docx` by `resume_fill.py` here, and the cover letter is
 * taken from the ZIP as-is.
 *
 * Every call gets its own temp directory: the script's zero-argument mode scans
 * its own folder for one JSON and one template, which two bids running at once
 * would trip over. Explicit paths keep concurrent runs apart.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { config, templatePathFor } from '../config.js';
import { storedNameFor } from '../middleware/upload.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const RESUME_JSON = 'resume_content.json';

function fail(message, status = 422) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** Zip housekeeping entries that are never part of the payload. */
function isJunk(name) {
  const base = path.posix.basename(name);
  return name.startsWith('__MACOSX/') || base.startsWith('.') || base.startsWith('~$');
}

/**
 * A bounded queue in front of the python spawns. Several bids finishing at the
 * same second should not fork a process each; they wait their turn instead.
 */
function createLimiter(max) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= max || !waiting.length) return;
    active += 1;
    waiting.shift()();
  };
  return function run(task) {
    return new Promise((resolve, reject) => {
      waiting.push(() => {
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            next();
          });
      });
      next();
    });
  };
}

const limit = createLimiter(config.packageConcurrency);

async function readZip(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw fail('That file is not a readable ZIP archive.', 400);
  }
  const files = Object.values(zip.files).filter((entry) => !entry.dir && !isJunk(entry.name));
  if (!files.length) throw fail('The ZIP is empty.', 400);
  return files;
}

/** The resume content, by contracted name first and by extension as a fallback. */
function pickJson(files) {
  const jsons = files.filter((f) => f.name.toLowerCase().endsWith('.json'));
  if (!jsons.length) {
    throw fail(`The ZIP has no ${RESUME_JSON} - ChatGPT did not follow the output contract.`);
  }
  const exact = jsons.find((f) => path.posix.basename(f.name).toLowerCase() === RESUME_JSON);
  if (exact) return exact;
  if (jsons.length === 1) return jsons[0];
  throw fail(`The ZIP holds several JSON files and none is named ${RESUME_JSON}.`);
}

/** The cover letter, by contracted name first and by extension as a fallback. */
function pickCoverLetter(files) {
  const docs = files.filter((f) => f.name.toLowerCase().endsWith('.docx'));
  if (!docs.length) return null;
  return docs.find((f) => path.posix.basename(f.name).toLowerCase().startsWith('cover')) || docs[0];
}

export async function extractDocxText(filePath) {
  if (path.extname(filePath).toLowerCase() !== '.docx') return '';
  try {
    const { value } = await mammoth.extractRawText({ path: filePath });
    return value.trim();
  } catch (err) {
    console.warn(`[package] could not read text from ${path.basename(filePath)}:`, err.message);
    return '';
  }
}

async function writeStoredFile(buffer, originalName, mimeType) {
  const storedName = storedNameFor(originalName);
  const target = path.join(config.uploadDir, storedName);
  await fs.writeFile(target, buffer);
  return {
    originalName,
    storedName,
    mimeType,
    size: buffer.length,
    text: await extractDocxText(target),
  };
}

/** resume_fill.py, on one JSON and one template, writing one DOCX. */
function runResumeFill({ jsonPath, templatePath, outPath }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      config.pythonBin,
      [config.resumeFillScript, '--json', jsonPath, '--template', templatePath, '--out', outPath],
      {
        // The candidate name reaches stdout, and Windows' default console
        // codepage cannot always encode it - which would kill an otherwise
        // healthy run on the print, not on the document.
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        timeout: config.packageTimeoutMs,
        windowsHide: true,
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      reject(
        err.code === 'ENOENT'
          ? fail(
              `Could not run "${config.pythonBin}". Install Python with python-docx, or set PYTHON_BIN in server/.env.`,
              500,
            )
          : err,
      );
    });

    child.on('close', (code, signal) => {
      if (signal) {
        reject(fail(`resume_fill.py was killed after ${config.packageTimeoutMs}ms (${signal}).`, 504));
        return;
      }
      if (code !== 0) {
        // These are content errors - a missing placeholder value, a bad key -
        // so the message is worth showing whole rather than logging away.
        const detail = (stderr || stdout).trim().split('\n').slice(-6).join(' ').slice(0, 600);
        reject(fail(`resume_fill.py failed: ${detail || `exit code ${code}`}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Unpack, fill, and store. Returns the two file descriptors ready to be put on
 * an Application, plus anything worth telling the user about a partial result.
 */
export async function buildFromPackage(buffer, { profileName }) {
  const files = await readZip(buffer);
  const jsonEntry = pickJson(files);
  const coverEntry = pickCoverLetter(files);
  const warnings = [];
  if (!coverEntry) warnings.push('The ZIP had no cover letter DOCX; only the resume was filed.');

  const templatePath = templatePathFor(profileName);
  try {
    await fs.access(templatePath);
  } catch {
    throw fail(`No resume template for "${profileName}" at ${templatePath}.`, 500);
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-pkg-'));
  try {
    const jsonPath = path.join(dir, RESUME_JSON);
    const outPath = path.join(dir, 'Final_Resume.docx');
    await fs.writeFile(jsonPath, await jsonEntry.async('nodebuffer'));

    await limit(() => runResumeFill({ jsonPath, templatePath, outPath }));

    const resumeName = `Resume_${profileName.replace(/\s+/g, '_')}.docx`;
    const resume = await writeStoredFile(await fs.readFile(outPath), resumeName, DOCX_MIME);

    let coverLetter = null;
    if (coverEntry) {
      coverLetter = await writeStoredFile(
        await coverEntry.async('nodebuffer'),
        path.posix.basename(coverEntry.name),
        DOCX_MIME,
      );
    }

    return { resume, coverLetter, warnings };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Fetch the ZIP the extension could only hand over as a URL. ChatGPT's download
 * links are short-lived signed URLs on a storage host that does not answer
 * cross-origin browser requests - but node is not a browser, so the download
 * lands here instead of in the extension.
 */
export async function fetchPackage(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw fail('packageUrl is not a valid URL.', 400);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw fail('packageUrl must be http(s).', 400);

  const response = await fetch(url, { redirect: 'follow' }).catch((err) => {
    throw fail(`Could not download the package: ${err.message}`, 502);
  });
  if (!response.ok) {
    throw fail(`Could not download the package (${response.status} from ${parsed.host}).`, 502);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > config.maxPackageBytes) {
    throw fail(`The downloaded package is larger than ${config.maxPackageBytes} bytes.`, 413);
  }
  return buffer;
}
