import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { Application } from '../models/Application.js';
import { uploadDocuments, uploadPackage } from '../middleware/upload.js';
import { buildFromPackage, extractDocxText, fetchPackage } from '../services/resumePackage.js';
import { config, PROFILES, STATUSES } from '../config.js';

export const router = express.Router();

const SORTABLE = new Set(['createdAt', 'appliedAt', 'jobTitle', 'profileName', 'company', 'status']);

// The two documents an application carries. Both are optional on every route:
// ChatGPT has usually not written either one at the moment the job is filed.
const DOCUMENTS = ['resume', 'coverLetter'];

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

// multer is callback based; promisify it so route handlers can await the parse.
function runMulter(middleware, req, res) {
  return new Promise((resolve, reject) => {
    middleware(req, res, (err) => (err ? reject(err) : resolve()));
  });
}

const parseUpload = (req, res) => runMulter(uploadDocuments, req, res);
const parsePackage = (req, res) => runMulter(uploadPackage, req, res);

/** The uploaded file for a field, or null - `.fields()` hands back arrays. */
function uploaded(req, field) {
  return (req.files && req.files[field] && req.files[field][0]) || null;
}

async function extractText(file) {
  if (!file) return '';
  return extractDocxText(file.path);
}

async function removeFile(storedName) {
  if (!storedName) return;
  try {
    await fs.unlink(path.join(config.uploadDir, storedName));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[upload] cleanup failed:', err.message);
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function readFields(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => body[k] !== undefined && body[k] !== null;

  if (has('profileName')) {
    const profileName = String(body.profileName).trim();
    if (!PROFILES.includes(profileName)) {
      throw badRequest(`profileName must be one of: ${PROFILES.join(', ')}`);
    }
    out.profileName = profileName;
  } else if (!partial) {
    throw badRequest('profileName is required');
  }

  if (has('jobTitle')) {
    const jobTitle = String(body.jobTitle).trim();
    if (!jobTitle) throw badRequest('jobTitle cannot be empty');
    out.jobTitle = jobTitle;
  } else if (!partial) {
    throw badRequest('jobTitle is required');
  }

  if (has('jobLink')) out.jobLink = String(body.jobLink).trim();
  if (has('jobDescription')) out.jobDescription = String(body.jobDescription);
  if (has('company')) out.company = String(body.company).trim();
  if (has('notes')) out.notes = String(body.notes);

  if (has('status')) {
    const status = String(body.status).trim();
    if (!STATUSES.includes(status)) {
      throw badRequest(`status must be one of: ${STATUSES.join(', ')}`);
    }
    out.status = status;
  }

  if (has('appliedAt') && String(body.appliedAt).trim()) {
    const raw = String(body.appliedAt).trim();
    // appliedAt is a calendar day, not an instant. Pin a YYYY-MM-DD value to UTC
    // midnight so the day it reads back as never depends on the reader's timezone.
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    const appliedAt = dateOnly
      ? new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])))
      : new Date(raw);
    if (Number.isNaN(appliedAt.getTime())) throw badRequest('appliedAt is not a valid date');
    out.appliedAt = appliedAt;
  }

  return out;
}

function fileToStored(file, text) {
  return {
    originalName: file.originalname,
    storedName: file.filename,
    mimeType: file.mimetype,
    size: file.size,
    text,
  };
}

/** Drop every file this request wrote - used when it is rejected after parsing. */
async function discardUploads(req) {
  for (const field of DOCUMENTS) {
    const file = uploaded(req, field);
    if (file) await removeFile(file.filename);
  }
}

/**
 * Put the uploaded documents on the record and return the stored names they
 * replaced, so the old files are only unlinked once the save has gone through.
 */
async function applyUploads(req, doc) {
  const replaced = [];
  for (const field of DOCUMENTS) {
    const file = uploaded(req, field);
    if (!file) continue;
    if (doc[field] && doc[field].storedName) replaced.push(doc[field].storedName);
    doc[field] = fileToStored(file, await extractText(file));
  }
  return replaced;
}

// GET /api/applications - the table feed: filter, search, sort, paginate.
router.get(
  '/',
  wrap(async (req, res) => {
    const { profileName, status, q } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25));
    const sortBy = SORTABLE.has(req.query.sortBy) ? req.query.sortBy : 'createdAt';
    const sortDir = req.query.sortDir === 'asc' ? 1 : -1;

    const filter = {};
    if (profileName && PROFILES.includes(profileName)) filter.profileName = profileName;
    if (status && STATUSES.includes(status)) filter.status = status;
    if (q && String(q).trim()) {
      const escaped = escapeRegex(String(q).trim());
      const rx = new RegExp(escaped, 'i');
      filter.$or = [
        { jobTitle: rx },
        { company: rx },
        { jobDescription: rx },
        { notes: rx },
        { 'resume.originalName': rx },
        { 'resume.text': rx },
        { 'coverLetter.originalName': rx },
        { 'coverLetter.text': rx },
      ];
    }

    const [rows, total] = await Promise.all([
      Application.find(filter)
        .select('-resume.text -coverLetter.text')
        .sort({ [sortBy]: sortDir })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Application.countDocuments(filter),
    ]);

    res.json({
      items: rows.map(({ _id, __v, ...rest }) => ({ id: String(_id), ...rest })),
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  }),
);

// GET /api/applications/stats - counts per profile and per status for the dashboard.
router.get(
  '/stats',
  wrap(async (_req, res) => {
    const [byProfile, byStatus, total] = await Promise.all([
      Application.aggregate([{ $group: { _id: '$profileName', count: { $sum: 1 } } }]),
      Application.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      Application.countDocuments(),
    ]);
    const toMap = (rows) => Object.fromEntries(rows.map((r) => [r._id, r.count]));
    res.json({ total, byProfile: toMap(byProfile), byStatus: toMap(byStatus) });
  }),
);

// GET /api/applications/company-lookup - everything filed under a company name.
// Fed by the Ctrl+Shift+X peek panel: the user selects a company anywhere in the UI
// and gets back who applied there, for what, and where each one stands.
router.get(
  '/company-lookup',
  wrap(async (req, res) => {
    const term = String(req.query.q || '')
      .trim()
      .replace(/\s+/g, ' ');
    if (term.length < 2) throw badRequest('q must be at least 2 characters');
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));

    const escaped = escapeRegex(term);
    // Substring, case-insensitive: selecting "acme" finds "Acme Corp" too.
    const filter = { company: new RegExp(escaped, 'i') };
    const exactRx = new RegExp(`^${escaped}$`, 'i');

    const [rows, total, byStatus, companies] = await Promise.all([
      Application.aggregate([
        { $match: filter },
        { $addFields: { exact: { $regexMatch: { input: '$company', regex: exactRx } } } },
        // Exact company matches float above the merely-similar ones.
        { $sort: { exact: -1, appliedAt: -1 } },
        { $limit: limit },
        {
          $project: {
            profileName: 1,
            jobTitle: 1,
            company: 1,
            status: 1,
            appliedAt: 1,
            jobLink: 1,
            exact: 1,
          },
        },
      ]),
      Application.countDocuments(filter),
      Application.aggregate([{ $match: filter }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
      Application.distinct('company', filter),
    ]);

    res.json({
      term,
      total,
      shown: rows.length,
      companies: companies.filter(Boolean).sort(),
      byStatus: Object.fromEntries(byStatus.map((r) => [r._id, r.count])),
      items: rows.map(({ _id, ...rest }) => ({ id: String(_id), ...rest })),
    });
  }),
);

router.get(
  '/:id',
  wrap(async (req, res) => {
    const doc = await Application.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Application not found' });
    res.json(doc.toJSON());
  }),
);

// GET /api/applications/:id/resume and /cover-letter - send a stored document
// back to the browser. Same handler; only the field differs.
function sendDocument(field, label) {
  return wrap(async (req, res) => {
    const doc = await Application.findById(req.params.id).select(field);
    const stored = doc && doc[field];
    if (!stored || !stored.storedName) {
      return res.status(404).json({ error: `No ${label} on file` });
    }
    const filePath = path.join(config.uploadDir, stored.storedName);
    res.download(filePath, stored.originalName, (err) => {
      if (err && !res.headersSent) {
        res.status(404).json({ error: `The ${label} file is missing on disk` });
      }
    });
  });
}

router.get('/:id/resume', sendDocument('resume', 'resume'));
router.get('/:id/cover-letter', sendDocument('coverLetter', 'cover letter'));

router.post(
  '/',
  wrap(async (req, res) => {
    await parseUpload(req, res);
    let fields;
    try {
      fields = readFields(req.body);
    } catch (err) {
      await discardUploads(req);
      throw err;
    }

    const doc = new Application(fields);
    await applyUploads(req, doc);
    await doc.save();
    res.status(201).json(doc.toJSON());
  }),
);

router.put(
  '/:id',
  wrap(async (req, res) => {
    await parseUpload(req, res);
    const doc = await Application.findById(req.params.id);
    if (!doc) {
      await discardUploads(req);
      return res.status(404).json({ error: 'Application not found' });
    }

    let fields;
    try {
      fields = readFields(req.body, { partial: true });
    } catch (err) {
      await discardUploads(req);
      throw err;
    }

    Object.assign(doc, fields);
    const replaced = await applyUploads(req, doc);

    await doc.save();
    // Only drop the old files once the new record is safely persisted.
    for (const storedName of replaced) await removeFile(storedName);
    res.json(doc.toJSON());
  }),
);

/**
 * POST /api/applications/:id/package - the whole point of the automation.
 *
 * The Chrome extension hands over the `Resume_Package_<Candidate>.zip` ChatGPT
 * produced, either as an uploaded file (`package`) or, when the browser could
 * not read the signed download cross-origin, as a `packageUrl` for this server
 * to fetch. Either way it is unzipped, `resume_content.json` is poured into the
 * profile's template by resume_fill.py, and the resume plus the cover letter
 * land on the record in one shot.
 */
router.post(
  '/:id/package',
  wrap(async (req, res) => {
    await parsePackage(req, res);

    const doc = await Application.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Application not found' });

    // The profile decides which template gets filled; the record's own is the
    // default, and a body override still has to be a known profile.
    let profileName = doc.profileName;
    if (req.body && req.body.profileName) {
      profileName = String(req.body.profileName).trim();
      if (!PROFILES.includes(profileName)) {
        throw badRequest(`profileName must be one of: ${PROFILES.join(', ')}`);
      }
    }

    const packageUrl = req.body && req.body.packageUrl ? String(req.body.packageUrl).trim() : '';
    const buffer = req.file ? req.file.buffer : packageUrl ? await fetchPackage(packageUrl) : null;
    if (!buffer) throw badRequest('Send the ZIP as `package`, or a `packageUrl` to fetch it from.');

    const { resume, coverLetter, warnings } = await buildFromPackage(buffer, { profileName });

    const replaced = [
      doc.resume && doc.resume.storedName,
      coverLetter && doc.coverLetter && doc.coverLetter.storedName,
    ].filter(Boolean);

    doc.resume = resume;
    if (coverLetter) doc.coverLetter = coverLetter;

    try {
      await doc.save();
    } catch (err) {
      // The record did not take them, so the files it would have pointed at are
      // orphans - clean up rather than leaving them in uploads/.
      await removeFile(resume.storedName);
      if (coverLetter) await removeFile(coverLetter.storedName);
      throw err;
    }

    for (const storedName of replaced) await removeFile(storedName);
    res.json({ ...doc.toJSON(), warnings });
  }),
);

router.delete(
  '/:id',
  wrap(async (req, res) => {
    const doc = await Application.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Application not found' });
    for (const field of DOCUMENTS) {
      if (doc[field]) await removeFile(doc[field].storedName);
    }
    res.json({ ok: true, id: req.params.id });
  }),
);
