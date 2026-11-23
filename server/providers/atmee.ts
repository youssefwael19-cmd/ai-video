import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { downloadToFile, withDeadline } from './net.js';
import { ProviderError, type MotionRequest, type Provider } from './types.js';

/**
 * Atmee renders a clip from a photo and a motion prompt on every plan, Free
 * included (0.1-2 credits a clip). A cold renderer answers 409 with a
 * Retry-After header instead of holding the request open, so the same
 * Idempotency-Key is reused on every retry and the clip is charged once.
 */
const BASE = 'https://api.atmanity.us';

/** Sizes the API serves per frame shape; a refused size is retried as 480². */
const RESOLUTIONS: Record<string, { width: number; height: number }> = {
  '9:16': { width: 480, height: 854 },
  '16:9': { width: 854, height: 480 },
  '1:1': { width: 480, height: 480 },
};

export function createAtmeeProviders(apiKey: string): Provider[] {
  return [
    {
      id: 'atmee:v2-clips',
      label: 'atmee v2',
      service: 'Atmee',
      model: 'Atmee V2 clip renderer (free plan credits)',
      maxSeconds: 15,
      requires: {
        env: 'ATMEE_API_KEY',
        signupUrl: 'https://www.atmee.ai/pricing',
        note: 'Clip generation on the Free plan, no card',
      },
      isConfigured: () => apiKey.length > 0,
      generate: (req, signal) => run(apiKey, req, signal),
    },
  ];
}

async function run(apiKey: string, req: MotionRequest, signal: AbortSignal) {
  const image = await req.getPublicImageUrl();
  const idempotencyKey = randomUUID();
  const deadline = Date.now() + 9 * 60_000;
  let includeResolution = true;
  /** Last non-fatal answer, so a 9-minute spin reports why instead of "timed out". */
  let lastState = 'no response yet';

  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/v1/generation/clips`, {
      method: 'POST',
      headers: {
        'X-Api-Key': apiKey,
        'Idempotency-Key': idempotencyKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        image,
        prompt: req.prompt,
        durationSeconds: Math.min(15, Math.max(1, Math.round(req.seconds))),
        seed: req.seed,
        ...(includeResolution ? { resolution: RESOLUTIONS[req.aspect] ?? RESOLUTIONS['1:1'] } : {}),
      }),
      signal: withDeadline(signal, 120_000),
    });

    // A wrong key answers 401 as plain text, so never assume JSON.
    const text = await res.text().catch(() => '');
    let body: {
      clip?: { url?: string; unavailable?: boolean };
      clips?: { url?: string; unavailable?: boolean }[];
      url?: string;
      error?: string;
      message?: string;
    } = {};
    try {
      body = text ? (JSON.parse(text) as typeof body) : {};
    } catch {
      // Plain-text bodies end with a newline, which would break the log line.
      body = { message: text.trim().slice(0, 200) };
    }

    // The documented envelope is {clip:{url}}, but accept the flat and list
    // forms too rather than declaring a successful render a failure.
    const clip = body.clip ?? body.clips?.[0];
    const clipUrl = clip?.url ?? body.url;

    if (res.ok && clipUrl) {
      const dest = path.join(config.segmentDir, `atmee-${req.seed}-${Date.now()}.mp4`);
      await downloadToFile(clipUrl, dest, withDeadline(signal, 300_000));
      return { videoPath: dest };
    }
    if (res.ok && clip?.unavailable) {
      throw new ProviderError('Atmee returned an expired clip', { retryable: true });
    }
    if (res.ok) lastState = 'the job finished but carried no clip url';

    const code = typeof body.error === 'string' ? body.error : `http_${res.status}`;

    // This size is not being served right now: ask again with the default.
    if (res.status === 400 && includeResolution && /resolution/i.test(`${code} ${body.message ?? ''}`)) {
      includeResolution = false;
      continue;
    }

    if (code === 'request_in_progress' || code === 'rate_limited' || res.status === 409) {
      lastState = cell(code, body.message);
      const wait = Math.min(30, Math.max(1, Number(res.headers.get('retry-after') ?? 10) || 10));
      await sleep(wait * 1000, signal);
      continue;
    }

    throw new ProviderError(
      res.status === 402
        ? `Atmee free credits are spent${body.message ? `: ${body.message}` : ''}`
        : `Atmee rejected the job (${res.status}${body.message ? '' : ` ${code}`})${body.message ? `: ${body.message}` : ''}`,
      {
        status: res.status,
        retryable: res.status === 429 || res.status >= 500,
        raw: text.slice(0, 300),
      },
    );
  }

  throw new ProviderError(`Atmee gave no clip within 9 minutes (last answer: ${lastState})`, {
    retryable: true,
  });
}

function cell(code: string, message?: string): string {
  return message ? `${code}: ${message}` : code;
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
