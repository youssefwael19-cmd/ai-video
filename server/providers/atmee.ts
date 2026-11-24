import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { downloadToFile, sleep, withDeadline } from './net.js';
import { ProviderError, type Aspect, type MotionRequest, type Provider } from './types.js';

/**
 * Atmee renders a clip from a photo and a motion prompt on every plan, Free
 * included (0.1-2 credits a clip). A cold renderer answers 409 with a
 * Retry-After header instead of holding the request open, so the same
 * Idempotency-Key is reused on every retry and the clip is charged once.
 */
const BASE = 'https://api.atmanity.us';

interface ClipSize {
  width: number;
  height: number;
}

/**
 * Highest resolution first: 720p is 0.8 credits for a 5s 9:16 clip against 0.3
 * for 480p, and it is the difference between generated detail and an upscale.
 * 1080p is listed as coming soon, and the renderer serves only the sizes in its
 * price list, so a refusal steps one size down rather than giving up the beat.
 */
const SIZES: Record<Aspect, ClipSize[]> = {
  '9:16': [
    { width: 720, height: 1280 },
    { width: 468, height: 832 },
  ],
  '16:9': [
    { width: 1280, height: 720 },
    { width: 832, height: 468 },
  ],
  '1:1': [
    { width: 720, height: 720 },
    { width: 480, height: 480 },
  ],
};

export function createAtmeeProviders(apiKey: string): Provider[] {
  return [
    {
      id: 'atmee:v2-clips',
      label: 'atmee v2',
      service: 'Atmee',
      model: 'Atmee V2 clip renderer (720p, free plan credits)',
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
  const sizes = SIZES[req.aspect] ?? SIZES['1:1'];
  let sizeIndex = 0;
  let idempotencyKey = randomUUID();
  const deadline = Date.now() + 9 * 60_000;
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
        resolution: sizes[sizeIndex],
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

    // A size that is not served answers 400 invalid_input (naming the sizes),
    // and credits that cannot cover 720p answer 402. Either way the beat is
    // better at 480p than not at all, so step one size down and ask again.
    const sizeRefused =
      ((res.status === 400 || res.status === 422) &&
        /resolution|\bsizes?\b/i.test(`${code} ${body.message ?? ''}`)) ||
      res.status === 402;
    if (sizeRefused && sizeIndex + 1 < sizes.length) {
      sizeIndex += 1;
      // A key reused with different inputs is itself a 400 invalid_input.
      idempotencyKey = randomUUID();
      lastState = `the ${sizes[sizeIndex - 1].width}x${sizes[sizeIndex - 1].height} size was refused`;
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

