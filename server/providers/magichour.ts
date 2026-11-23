import path from 'node:path';
import { config } from '../config.js';
import { downloadToFile, sleep } from './net.js';
import { ProviderError, type MotionRequest, type Provider } from './types.js';

/** Magic Hour free-tier credits; LTX on the free tier is limited to 5s @ 480p. */
export function createMagicHourProviders(apiKey: string): Provider[] {
  return [
    {
      id: 'magichour:ltx-2.5',
      label: 'ltx 2.5',
      service: 'Magic Hour',
      model: 'LTX 2.5 (free tier, 480p)',
      maxSeconds: 5,
      requires: {
        env: 'MAGIC_HOUR_API_KEY',
        signupUrl: 'https://magichour.ai/developer',
        note: 'Free tier credits',
      },
      isConfigured: () => apiKey.length > 0,
      generate: (req, signal) => run(apiKey, req, signal),
    },
  ];
}

async function run(apiKey: string, req: MotionRequest, signal: AbortSignal) {
  const imageUrl = await req.getPublicImageUrl();
  const createRes = await fetch('https://api.magichour.ai/v1/image-to-video', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      name: 'Product motion',
      end_seconds: Math.min(5, Math.ceil(req.seconds)),
      model: 'ltx-2.5',
      resolution: '480p',
      style: { prompt: req.prompt },
      assets: { image_file_path: imageUrl },
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!createRes.ok) {
    const raw = (await createRes.text().catch(() => '')).slice(0, 300);
    // Magic Hour explains refusals in the body (e.g. 402 out of free credits),
    // so include it rather than reporting a bare status code.
    let reason = '';
    try {
      const parsed = JSON.parse(raw) as { message?: string; error?: string; code?: string };
      reason = parsed.message ?? parsed.error ?? parsed.code ?? '';
    } catch {
      /* non-JSON error body */
    }
    throw new ProviderError(
      `Magic Hour rejected the job (HTTP ${createRes.status})${reason ? `: ${reason}` : ''}`,
      {
        status: createRes.status,
        retryable: createRes.status === 429 || createRes.status >= 500,
        raw,
      },
    );
  }

  const body = (await createRes.json()) as {
    id?: string;
    status?: string;
    downloads?: { url?: string }[];
  };

  if (body.status === 'complete' && body.downloads?.[0]?.url) {
    return persist(body.downloads[0].url, req);
  }

  const id = body.id;
  if (!id) throw new ProviderError('Magic Hour did not return a project id');

  const deadline = Date.now() + 9 * 60_000;
  while (Date.now() < deadline) {
    await sleep(4000, signal);
    // Results live on the video-projects resource: /v1/image-to-video/{id} is a 404.
    const res = await fetch(`https://api.magichour.ai/v1/video-projects/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) continue;
    const job = (await res.json()) as {
      status?: string;
      downloads?: { url?: string }[];
      download?: { url?: string } | null;
      error?: { message?: string } | null;
    };
    if (job.status === 'error') {
      throw new ProviderError(`Magic Hour failed: ${job.error?.message ?? 'unknown error'}`, {
        retryable: false,
      });
    }
    if (job.status === 'complete') {
      const url = job.downloads?.[0]?.url ?? job.download?.url;
      if (!url) throw new ProviderError('Magic Hour finished without a download URL');
      return persist(url, req);
    }
  }
  throw new ProviderError('Magic Hour generation timed out', { retryable: true });
}

async function persist(url: string, req: MotionRequest) {
  const dest = path.join(config.segmentDir, `magichour-${req.seed}-${Date.now()}.mp4`);
  await downloadToFile(url, dest, AbortSignal.timeout(180_000));
  return { videoPath: dest };
}
