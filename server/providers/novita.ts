import path from 'node:path';
import { config } from '../config.js';
import { downloadToFile } from './net.js';
import { ProviderError, type MotionRequest, type Provider } from './types.js';

/** Novita AI free signup credits, asynchronous v3 task API. */
export function createNovitaProviders(apiKey: string): Provider[] {
  return [
    {
      id: 'novita:wan-2.2-i2v',
      label: 'wan 2.2 i2v',
      service: 'Novita AI',
      model: 'Wan 2.2 Image-to-Video',
      maxSeconds: 5,
      requires: {
        env: 'NOVITA_API_KEY',
        signupUrl: 'https://novita.ai/settings/key-management',
        note: 'Free account credit on signup',
      },
      isConfigured: () => apiKey.length > 0,
      generate: (req, signal) => run(apiKey, req, signal),
    },
  ];
}

async function run(apiKey: string, req: MotionRequest, signal: AbortSignal) {
  const imageUrl = await req.getPublicImageUrl();
  const createRes = await fetch('https://api.novita.ai/v3/async/wan-2.2-i2v', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { prompt: req.prompt, negative_prompt: req.negativePrompt, img_url: imageUrl },
      parameters: { duration: Math.min(5, req.seconds), prompt_extend: true, seed: req.seed },
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!createRes.ok) {
    const raw = (await createRes.text().catch(() => '')).slice(0, 300);
    // Novita explains refusals in the body, e.g. {"reason":"NOT_ENOUGH_BALANCE"};
    // surfacing it beats leaving the user with a bare 403.
    let reason = '';
    try {
      const parsed = JSON.parse(raw) as { reason?: string; message?: string };
      reason = parsed.reason ?? parsed.message ?? '';
    } catch {
      /* non-JSON error body */
    }
    throw new ProviderError(
      `Novita rejected the task (HTTP ${createRes.status})${reason ? `: ${reason.toLowerCase().replace(/_/g, ' ')}` : ''}`,
      {
        status: createRes.status,
        retryable: createRes.status === 429 || createRes.status >= 500,
        raw,
      },
    );
  }

  const { task_id: taskId } = (await createRes.json()) as { task_id?: string };
  if (!taskId) throw new ProviderError('Novita did not return a task id');

  const deadline = Date.now() + 9 * 60_000;
  while (Date.now() < deadline) {
    await sleep(4000, signal);
    const res = await fetch(`https://api.novita.ai/v3/async/task-result?task_id=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) continue;
    const json = (await res.json()) as {
      task?: { status?: string; reason?: string; videos?: { video_url?: string; video_url_ttl?: number }[] };
    };
    const status = json.task?.status ?? '';
    if (status === 'TASK_STATUS_FAILED') {
      throw new ProviderError(`Novita task failed: ${json.task?.reason ?? 'unknown reason'}`, {
        retryable: false,
      });
    }
    if (status === 'TASK_STATUS_SUCCEED') {
      const url = json.task?.videos?.[0]?.video_url;
      if (!url) throw new ProviderError('Novita finished without a video URL');
      const dest = path.join(config.segmentDir, `novita-${req.seed}-${Date.now()}.mp4`);
      await downloadToFile(url, dest, AbortSignal.timeout(180_000));
      return { videoPath: dest };
    }
  }
  throw new ProviderError('Novita generation timed out', { retryable: true });
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new ProviderError('Cancelled', { retryable: false }));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderError('Cancelled', { retryable: false }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
