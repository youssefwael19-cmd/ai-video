import http from 'node:http';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { config } from './config.js';
import { ensureDirs, TOTAL_SECONDS } from './compose.js';
import { createJob, getJob, listJobs } from './jobs.js';
import { configuredProviderCount, resetProviderHealth, snapshotProviders } from './gateway.js';
import type { Aspect, StylePreset } from './providers/types.js';

const DEV = process.env.NODE_ENV !== 'production';
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

await ensureDirs();

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/api/state', (_req, res) => {
  res.json({
    providers: snapshotProviders(),
    configured: configuredProviderCount(),
    localFallback: config.enableLocalFallback,
    totalSeconds: TOTAL_SECONDS,
    beats: 3,
  });
});

app.get('/api/jobs', (_req, res) => {
  res.json({ jobs: listJobs() });
});

app.post('/api/providers/reset', (_req, res) => {
  resetProviderHealth();
  res.json({ ok: true, providers: snapshotProviders() });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  return res.json(job);
});

app.post('/api/jobs', upload.single('image'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Upload a product photo' });
  if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
    return res.status(400).json({ error: 'Use a PNG, JPG or WEBP photo' });
  }

  const aspect = (['9:16', '1:1', '16:9'].includes(String(req.body.aspect))
    ? req.body.aspect
    : '9:16') as Aspect;
  const style = (['cinematic', 'studio', 'bold', 'lifestyle'].includes(String(req.body.style))
    ? req.body.style
    : 'cinematic') as StylePreset;
  const brief = String(req.body.brief ?? '').slice(0, 600);

  const ext = file.mimetype === 'image/png' ? '.png' : file.mimetype === 'image/webp' ? '.webp' : '.jpg';
  const imagePath = path.join(config.uploadDir, `${randomUUID()}${ext}`);
  await writeFile(imagePath, file.buffer);

  const job = createJob({ imagePath, imageMime: file.mimetype, brief, style, aspect });
  return res.status(201).json(job);
});

app.use(
  '/media',
  express.static(config.dataDir, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.mp4')) {
        const download = (res.req.query.download ?? '') === '1';
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Cache-Control', 'no-store');
        if (download) {
          res.setHeader('Content-Disposition', `attachment; filename="product-video-${Date.now()}.mp4"`);
        }
      }
    },
  }),
);

const server = http.createServer(app);

if (DEV) {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    // Share the Express HTTP server so HMR upgrades the same port instead of
    // opening a second listener (which the preview proxy would not reach).
    server: { middlewareMode: true, hmr: { server } },
    appType: 'spa',
  });
  app.use(vite.middlewares);
} else {
  const dist = path.join(config.root, 'dist');
  app.use(express.static(dist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(dist, 'index.html'));
  });
}

server.listen(config.port, '0.0.0.0', () => {
  console.log(`Motion Studio listening on http://0.0.0.0:${config.port}`);
  console.log(`Configured free providers: ${configuredProviderCount()}`);
});
