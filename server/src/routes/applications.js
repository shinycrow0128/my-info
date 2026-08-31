import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import mammoth from 'mammoth';
import { Application } from '../models/Application.js';
import { uploadResume } from '../middleware/upload.js';
import { config, PROFILES, STATUSES } from '../config.js';

export const router = express.Router();

const SORTABLE = new Set(['createdAt', 'appliedAt', 'jobTitle', 'profileName', 'company', 'status']);

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

// multer is callback based; promisify it so route handlers can await the parse.
function parseUpload(req, res) {
  return new Promise((resolve, reject) => {
    uploadResume(req, res, (err) => (err ? reject(err) : resolve()));
  });
}

async function extractText(file) {
  if (!file || path.extname(file.originalname).toLowerCase() !== '.docx') return '';
  try {
    const { value } = await mammoth.extractRawText({ path: file.path });
    return value.trim();
  } catch (err) {
    console.warn(`[upload] could not read text from ${file.originalname}:`, err.message);
    return '';
  }
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

function fileToResume(file, text) {
  return {
    originalName: file.originalname,
    storedName: file.filename,
    mimeType: file.mimetype,
    size: file.size,
    text,
  };
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
      ];
    }

    const [rows, total] = await Promise.all([
      Application.find(filter)
        .select('-resume.text')
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

// GET /api/applications/:id/resume - send the stored resume back to the browser.
router.get(
  '/:id/resume',
  wrap(async (req, res) => {
    const doc = await Application.findById(req.params.id).select('resume');
    if (!doc || !doc.resume || !doc.resume.storedName) {
      return res.status(404).json({ error: 'No resume on file' });
    }
    const filePath = path.join(config.uploadDir, doc.resume.storedName);
    res.download(filePath, doc.resume.originalName, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Resume file is missing on disk' });
    });
  }),
);

router.post(
  '/',
  wrap(async (req, res) => {
    await parseUpload(req, res);
    let fields;
    try {
      fields = readFields(req.body);
    } catch (err) {
      if (req.file) await removeFile(req.file.filename);
      throw err;
    }

    if (req.file) fields.resume = fileToResume(req.file, await extractText(req.file));

    const doc = await Application.create(fields);
    res.status(201).json(doc.toJSON());
  }),
);

router.put(
  '/:id',
  wrap(async (req, res) => {
    await parseUpload(req, res);
    const doc = await Application.findById(req.params.id);
    if (!doc) {
      if (req.file) await removeFile(req.file.filename);
      return res.status(404).json({ error: 'Application not found' });
    }

    let fields;
    try {
      fields = readFields(req.body, { partial: true });
    } catch (err) {
      if (req.file) await removeFile(req.file.filename);
      throw err;
    }

    const previous = doc.resume ? doc.resume.storedName : null;
    Object.assign(doc, fields);
    if (req.file) doc.resume = fileToResume(req.file, await extractText(req.file));

    await doc.save();
    // Only drop the old file once the new record is safely persisted.
    if (req.file && previous) await removeFile(previous);
    res.json(doc.toJSON());
  }),
);

router.delete(
  '/:id',
  wrap(async (req, res) => {
    const doc = await Application.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Application not found' });
    if (doc.resume) await removeFile(doc.resume.storedName);
    res.json({ ok: true, id: req.params.id });
  }),
);
