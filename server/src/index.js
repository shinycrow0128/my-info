import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import multer from 'multer';
import mongoose from 'mongoose';
import { config, isAllowedOrigin, PROFILES, STATUSES } from './config.js';
import { connectDb } from './db.js';
import { router as applicationsRouter } from './routes/applications.js';
import { router as analyticsRouter } from './routes/analytics.js';

const app = express();

app.use(morgan('dev'));
app.use(
  cors({
    origin: (origin, cb) => {
      if (isAllowedOrigin(origin)) return cb(null, true);
      const err = new Error(`Origin ${origin} is not allowed by CORS`);
      err.status = 403;
      cb(err);
    },
  }),
);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: mongoose.connection.readyState === 1,
    db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    uptime: process.uptime(),
  });
});

// The frontend reads its dropdown options from here so the roster lives in one place.
app.get('/api/meta', (_req, res) => {
  res.json({ profiles: PROFILES, statuses: STATUSES });
});

app.use('/api/applications', applicationsRouter);
app.use('/api/analytics', analyticsRouter);

app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });
});

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    // The ZIP has its own, larger ceiling than the documents do.
    const limitBytes = err.field === 'package' ? config.maxPackageBytes : config.maxUploadBytes;
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `${err.field || 'File'} is too large (max ${Math.round(limitBytes / 1024 / 1024)} MB)`
        : err.message;
    return res.status(400).json({ error: message });
  }
  if (err instanceof mongoose.Error.ValidationError) {
    return res.status(400).json({ error: err.message });
  }
  if (err instanceof mongoose.Error.CastError) {
    return res.status(400).json({ error: `Invalid id "${err.value}"` });
  }
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ error: err.message || 'Internal server error' });
});

async function main() {
  await connectDb();
  app.listen(config.port, () => {
    console.log(`[api] listening on http://localhost:${config.port}`);
  });
}

main().catch((err) => {
  console.error('[fatal] failed to start server:', err.message);
  process.exit(1);
});
