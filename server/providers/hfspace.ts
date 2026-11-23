import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { downloadToFile, withDeadline } from './net.js';
import { ProviderError, type MotionRequest, type Provider, type ProviderOutput } from './types.js';

/**
 * Hugging Face Spaces needs no key at all: ZeroGPU Spaces are free for
 * anonymous callers (a small daily GPU quota), so the pool has a working
 * provider with zero setup. A token is still honoured when present, and then
 * the runs draw on that account's own, larger daily quota.
 *
 * All four Spaces share whatever free ZeroGPU quota applies to the caller, so
 * they are exposed as a SINGLE provider in the pool (one slot, one quota, one
 * cooldown). Inside that provider we still rotate across the Spaces: a Space
 * that is asleep, queued, out of GPU time or broken hands the beat to the next
 * one without spending another provider slot or claiming another free quota.
 */

interface SpaceSpec {
  /** owner/space on the Hub */
  space: string;
  apiName: string;
  model: string;
  maxSeconds: number;
  buildInputs: (req: MotionRequest, image: FileData, seconds: number) => unknown[];
}

type FileData = { path: string; meta: { _type: 'gradio.FileData' } };

const filedata = (p: string): FileData => ({ path: p, meta: { _type: 'gradio.FileData' } });

const NEGATIVE = 'blurry, distorted product shape, warped logo, extra limbs, watermark, flickering, text artifacts';

const SPACES: SpaceSpec[] = [
  {
    space: 'zerogpu-aoti/wan2-2-fp8da-aoti-faster',
    apiName: 'generate_video',
    model: 'Wan 2.2 I2V (fp8, fast)',
    maxSeconds: 5,
    buildInputs: (req, image, seconds) => [
      image,
      req.prompt,
      6,
      NEGATIVE,
      seconds,
      1,
      1,
      req.seed,
      false,
    ],
  },
  {
    space: 'Upsampler/wan-2-2-14b-image-to-video',
    apiName: 'generate_video',
    model: 'Wan 2.2 14B I2V',
    maxSeconds: 5,
    buildInputs: (req, image, seconds) => [
      image,
      req.prompt,
      6,
      NEGATIVE,
      seconds,
      1,
      1,
      req.seed,
      false,
      null,
    ],
  },
  {
    space: 'multimodalart/wan-2-2-first-last-frame',
    apiName: 'generate_video',
    model: 'Wan 2.2 first/last frame',
    maxSeconds: 5,
    buildInputs: (req, image, seconds) => [
      image,
      null,
      req.prompt,
      NEGATIVE,
      seconds,
      8,
      1,
      1,
      req.seed,
      false,
    ],
  },
  {
    space: 'Lightricks/ltx-video-distilled',
    apiName: 'image_to_video',
    model: 'LTX-Video distilled',
    maxSeconds: 8,
    buildInputs: (req, image, seconds) => {
      const portrait = req.aspect === '9:16';
      const landscape = req.aspect === '16:9';
      const width = portrait ? 704 : landscape ? 1216 : 960;
      const height = portrait ? 1216 : landscape ? 704 : 960;
      const frames = Math.round(seconds * 24) + 1;
      return [
        req.prompt,
        NEGATIVE,
        image,
        '',
        height,
        width,
        'image-to-video',
        seconds,
        Math.min(257, Math.max(9, frames)),
        req.seed,
        false,
        1,
        false,
      ];
    },
  },
];

interface SpaceHealth {
  failures: number;
  cooldownUntil: number;
  lastError?: string;
}

/**
 * Internal per-Space backoff only. This is deliberately not pool health: the
 * group holds a single gateway slot, so a Space-level failure must not put the
 * whole free Hugging Face quota (and its other three Spaces) into cooldown.
 */
const spaceHealth = new Map<string, SpaceHealth>();

function healthOf(space: string): SpaceHealth {
  let health = spaceHealth.get(space);
  if (!health) {
    health = { failures: 0, cooldownUntil: 0 };
    spaceHealth.set(space, health);
  }
  return health;
}

function cooldownFor(consecutiveFailures: number): number {
  const seconds = Math.min(15 * 60, 45 * Math.pow(3, Math.max(0, consecutiveFailures - 1)));
  return Date.now() + seconds * 1000;
}

export function resetHfSpaceHealth(): void {
  spaceHealth.clear();
}

/** Explain a 401/403 only when we had no token to send in the first place. */
function authNote(status: number, token: string): string {
  if (token) return '';
  return status === 401 || status === 403
    ? ' — this Space wants a Hugging Face token (set HUGGING_FACE_TOKEN)'
    : '';
}

function subdomain(space: string): string {
  return space.toLowerCase().replace(/\//g, '-').replace(/[._]/g, '-') + '.hf.space';
}

/**
 * `hfToken` is optional: pass '' and the Spaces are still called, anonymously.
 */
export function createHuggingFaceProviders(hfToken: string): Provider[] {
  return [
    {
      id: 'hf:spaces',
      label: 'Hugging Face Spaces',
      service: 'Hugging Face Spaces',
      model: 'Wan 2.2 + LTX-Video · 4 Spaces on one free quota',
      maxSeconds: 5,
      requires: {
        env: 'HUGGING_FACE_TOKEN',
        signupUrl: 'https://huggingface.co/settings/tokens',
        note: 'No key needed — anonymous runs get a small daily GPU quota',
      },
      // Zero setup: the Spaces answer anonymous callers, so this provider is
      // always in the pool rather than waiting for a token.
      isConfigured: () => true,
      generate: (req, signal) => runPool(hfToken, req, signal),
    },
  ];
}

/** Rotate over the Spaces on one quota, skipping any Space still backing off. */
async function runPool(
  hfToken: string,
  req: MotionRequest,
  signal: AbortSignal,
): Promise<ProviderOutput> {
  const now = Date.now();
  const ordered = [...SPACES].sort(
    (a, b) => healthOf(a.space).cooldownUntil - healthOf(b.space).cooldownUntil,
  );
  const ready = ordered.filter((spec) => healthOf(spec.space).cooldownUntil <= now);

  if (ready.length === 0) {
    const soonest = Math.min(...ordered.map((spec) => healthOf(spec.space).cooldownUntil || now));
    const seconds = Math.max(1, Math.ceil((soonest - now) / 1000));
    throw new ProviderError(`All 4 Hugging Face Spaces are cooling down (next in ${seconds}s)`, {
      retryable: true,
      status: 429,
    });
  }

  const errors: string[] = [];
  for (const spec of ready) {
    try {
      const output = await runSpace(spec, hfToken, req, signal);
      spaceHealth.delete(spec.space);
      return output;
    } catch (err) {
      if (signal.aborted) throw err;
      const message = err instanceof Error ? err.message : String(err);
      const raw = err instanceof ProviderError ? err.detail.raw : undefined;
      const detail = raw ? `${message} [${raw}]` : message;
      errors.push(`${spec.space}: ${detail}`);
      const health = healthOf(spec.space);
      health.failures += 1;
      health.lastError = detail.slice(0, 300);
      health.cooldownUntil = cooldownFor(health.failures);
    }
  }

  throw new ProviderError(`All 4 Hugging Face Spaces declined — ${errors.join(' | ')}`, {
    retryable: true,
  });
}

async function runSpace(
  spec: SpaceSpec,
  hfToken: string,
  req: MotionRequest,
  signal: AbortSignal,
): Promise<ProviderOutput> {
  const host = subdomain(spec.space);
  const seconds = Math.min(spec.maxSeconds, req.seconds);
  // With no token we send no auth header at all, which is how the Spaces are
  // called anonymously. With a token, Authorization is the only header we set:
  // Hugging Face's proxy injects the ZeroGPU quota identity token (x-ip-token)
  // itself, and supplying our own as x-ip-token makes ZeroGPU reject the call
  // immediately with an empty error (verified against the live Spaces:
  // Authorization alone returns a video).
  const headers: Record<string, string> = hfToken ? { Authorization: `Bearer ${hfToken}` } : {};

  // 1. Upload the photo into the Space's own filesystem.
  const form = new FormData();
  form.append(
    'files',
    new Blob([new Uint8Array(await readFile(req.imagePath))], { type: req.imageMime }),
    `product${path.extname(req.imagePath) || '.png'}`,
  );
  const uploadRes = await fetch(`https://${host}/gradio_api/upload?upload_id=${randomUUID()}`, {
    method: 'POST',
    headers,
    body: form,
    signal: withDeadline(signal, 120_000),
  });
  if (!uploadRes.ok) {
    throw new ProviderError(
      `Space upload failed (HTTP ${uploadRes.status})${authNote(uploadRes.status, hfToken)}`,
      {
        status: uploadRes.status,
        retryable: uploadRes.status >= 500 || uploadRes.status === 429,
        raw: (await uploadRes.text().catch(() => '')).slice(0, 200),
      },
    );
  }
  const uploaded = (await uploadRes.json()) as string[];
  if (!Array.isArray(uploaded) || !uploaded[0]) throw new ProviderError('Space did not return an upload path');

  // 2. Join the queue.
  const inputs = spec.buildInputs(req, filedata(uploaded[0]), seconds);
  const callRes = await fetch(`https://${host}/gradio_api/call/${spec.apiName}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: inputs }),
    signal: withDeadline(signal, 120_000),
  });
  if (!callRes.ok) {
    const body = await callRes.text().catch(() => '');
    throw new ProviderError(
      `Space rejected the job (HTTP ${callRes.status})${authNote(callRes.status, hfToken)}`,
      { status: callRes.status, retryable: true, raw: body.slice(0, 300) },
    );
  }
  const { event_id: eventId } = (await callRes.json()) as { event_id?: string };
  if (!eventId) throw new ProviderError('Space did not return a job id');

  // 3. Read the SSE stream until the job finishes.
  const streamRes = await fetch(`https://${host}/gradio_api/call/${spec.apiName}/${eventId}`, {
    headers,
    signal,
  });
  if (!streamRes.ok || !streamRes.body) {
    throw new ProviderError(`Space stream failed (HTTP ${streamRes.status})`, {
      status: streamRes.status,
      retryable: true,
    });
  }

  const payload = await readSse(
    streamRes.body,
    hfToken ? '' : ' (anonymous — shared daily GPU quota; add HUGGING_FACE_TOKEN for your own)',
  );
  const remote = findVideoPath(payload);
  if (!remote) {
    throw new ProviderError('Space finished without returning a video', {
      retryable: false,
      raw: JSON.stringify(payload).slice(0, 300),
    });
  }

  // 4. Pull the clip into our workspace.
  const url = /^https?:\/\//.test(remote) ? remote : `https://${host}/gradio_api/file=${remote}`;
  const dest = path.join(config.segmentDir, `hf-${req.seed}-${Date.now()}-${randomUUID().slice(0, 6)}.mp4`);
  await downloadToFile(url, dest, withDeadline(signal, 180_000));
  return { videoPath: dest };
}

async function readSse(body: ReadableStream<Uint8Array>, tokenNote = ''): Promise<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let last: unknown = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const event = /event:\s*(\w+)/.exec(block)?.[1];
      const dataLine = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('');
      if (!dataLine) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(dataLine);
      } catch {
        continue;
      }
      if (event === 'error') {
        const text = typeof parsed === 'string' ? parsed : JSON.stringify(parsed ?? null);
        // Gradio sends an empty body when the proxy refuses the run before it
        // starts (ZeroGPU quota, queue policy) — say that plainly instead of
        // guessing at a payload problem.
        throw new ProviderError(
          text === 'null'
            ? `Space refused the run without a message (GPU quota or queue policy)${tokenNote}`
            : `Space returned an error: ${text.slice(0, 160)}`,
          { retryable: true, raw: text.slice(0, 200) },
        );
      }
      if (event === 'complete') return parsed;
      if (event === 'generating' || event === 'data') last = parsed;
    }
  }
  if (last) return last;
  throw new ProviderError('Space stream ended without a result');
}

/** Walk the Gradio payload and return the first mp4-ish path we find. */
function findVideoPath(node: unknown, depth = 0): string | null {
  if (depth > 8) return null;
  if (typeof node === 'string') {
    return /\.(mp4|webm|gif|mov)$/i.test(node) || node.includes('/tmp/gradio/') ? node : null;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findVideoPath(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    // Every value in order: each Space nests the mp4 under different keys.
    for (const value of Object.values(node as Record<string, unknown>)) {
      const hit = findVideoPath(value, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}
