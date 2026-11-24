import http from 'node:http';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { config } from './config.js';
import { ensureDirs, pruneDataDir, TOTAL_SECONDS } from './compose.js';
import { createJob, getJob, listJobs, pruneJobs } from './jobs.js';
import { configuredProviderCount, resetProviderHealth, snapshotProviders } from './gateway.js';
import { isKeyField, loadStoredKeys, saveKey, snapshotSettings } from './settings.js';
import { testKey } from './providers/check.js';
import type { Aspect, StylePreset } from './providers/types.js';

const DEV = process.env.NODE_ENV !== 'production';
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

await ensureDirs();
await loadStoredKeys();
void pruneDataDir().then((removed) => {
  if (removed > 0) console.log(`Pruned ${removed} stale media file(s)`);
});
void pruneJobs();

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

/**
 * The Settings tab writes real API keys, so when SETTINGS_PASSWORD is set the
 * whole settings API needs it. Without the env var the app stays open, which is
 * what a single-user install wants.
 */
function settingsAllowed(req: express.Request, res: express.Response): boolean {
  const required = config.settingsPassword;
  if (!required) return true;
  const provided = req.get('x-settings-password') ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(required);
  if (a.length === b.length && timingSafeEqual(a, b)) return true;
  res.status(401).json({ error: 'Settings password required', passwordRequired: true });
  return false;
}

app.get('/api/settings', (req, res) => {
  if (!settingsAllowed(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  res.json({ passwordRequired: Boolean(config.settingsPassword), slots: snapshotSettings() });
});

app.post('/api/settings', async (req, res) => {
  if (!settingsAllowed(req, res)) return;
  const body = (req.body ?? {}) as { field?: unknown; value?: unknown };
  if (typeof body.field !== 'string') return res.status(400).json({ error: 'Missing key field' });
  if (typeof body.value !== 'string') return res.status(400).json({ error: 'Missing key value' });

  try {
    const slots = await saveKey(body.field, body.value);
    // A new key must be usable immediately, including one that was cooling down.
    resetProviderHealth();
    return res.json({ ok: true, slots, providers: snapshotProviders(), configured: configuredProviderCount() });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Could not save the key' });
  }
});

app.get('/api/jobs', async (_req, res) => {
  res.json({ jobs: await listJobs() });
});

/**
 * Check a key with a read-only provider call — no video, no credits. Tests the
 * value typed in the Settings row when one is sent, otherwise the saved/env key.
 */
app.post('/api/settings/test', async (req, res) => {
  if (!settingsAllowed(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');

  const body = (req.body ?? {}) as { field?: unknown; value?: unknown };
  if (typeof body.field !== 'string' || !isKeyField(body.field)) {
    return res.status(400).json({ error: 'Unknown key field' });
  }

  const typed = typeof body.value === 'string' ? body.value.trim().slice(0, 500) : '';
  const key = typed || config.keys[body.field];
  const result = await testKey(body.field, key);
  return res.json({ ...result, testedValue: typed ? 'typed' : 'saved' });
});

app.post('/api/providers/reset', (_req, res) => {
  resetProviderHealth();
  res.json({ ok: true, providers: snapshotProviders() });
});

app.get('/api/jobs/:id', async (req, res) => {
  const job = await getJob(req.params.id);
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

  // URL-only providers must fetch the photo themselves, so hand them this app's
  // own public address instead of a third-party host that may answer with HTML.
  const proto = (req.get('x-forwarded-proto') ?? req.protocol).split(',')[0].trim() || 'https';
  const host = (req.get('x-forwarded-host') ?? req.get('host') ?? '').split(',')[0].trim();
  const publicBase = host ? `${proto}://${host}` : undefined;

  const job = createJob({ imagePath, imageMime: file.mimetype, brief, style, aspect, publicBase });
  return res.status(201).json(job);
});

// Only the generated media is public. Serving DATA_DIR itself would also expose
// settings.json, which holds the provider API keys.
app.use('/media/uploads', express.static(config.uploadDir));
app.use(
  '/media/renders',
  express.static(config.renderDir, {
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

// A missing video or photo must 404 rather than fall through to index.html.
app.use('/media', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, configured: configuredProviderCount() });
});

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
