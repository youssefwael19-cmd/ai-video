import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { downloadToFile, sleep, withDeadline } from './net.js';
import { ProviderError, type MotionRequest, type Provider } from './types.js';

/**
 * Replicate's "try for free" collection includes minimax/video-01 (Hailuo),
 * which does image-to-video from a first frame. Free runs need no card; after a
 * few of them Replicate asks for billing, and the API then answers 402.
 */
const MODEL_OWNER = 'minimax';
const MODEL_NAME = 'video-01';

export function createReplicateProviders(apiToken: string): Provider[] {
  return [
    {
      id: 'replicate:minimax-video-01',
      label: 'minimax video-01',
      service: 'Replicate',
      model: 'MiniMax Video-01 / Hailuo (6s, free test runs)',
      maxSeconds: 6,
      requires: {
        env: 'REPLICATE_API_TOKEN',
        signupUrl: 'https://replicate.com/collections/try-for-free',
        note: 'Free test runs on the try-for-free collection, no card',
      },
      isConfigured: () => apiToken.length > 0,
      generate: (req, signal) => run(apiToken, req, signal),
    },
  ];
}

interface Prediction {
  status?: string;
  output?: unknown;
  error?: string | null;
  urls?: { get?: string };
}

async function run(apiToken: string, req: MotionRequest, signal: AbortSignal) {
  const auth = { Authorization: `Bearer ${apiToken}` };

  let prediction = await create(apiToken, req, signal);
  const deadline = Date.now() + 9 * 60_000;

  while (prediction.status !== 'succeeded') {
    if (prediction.status === 'failed' || prediction.status === 'canceled') {
      throw new ProviderError(
        `Replicate run ${prediction.status}: ${prediction.error ?? 'no reason given'}`,
        { retryable: false },
      );
    }
    if (Date.now() > deadline) {
      throw new ProviderError('Replicate generation timed out', { retryable: true });
    }
    const get = prediction.urls?.get;
    if (!get) throw new ProviderError('Replicate returned no prediction URL');

    await sleep(3000, signal);
    const res = await fetch(get, { headers: auth, signal: withDeadline(signal, 45_000) });
    if (!res.ok) {
      // A key that was revoked mid-run will never recover: stop instead of
      // polling a 401 for the rest of the nine-minute window.
      if ([401, 403, 404].includes(res.status)) {
        throw new ProviderError(`Replicate refused the poll (HTTP ${res.status})`, {
          status: res.status,
          retryable: false,
        });
      }
      continue;
    }
    prediction = (await res.json()) as Prediction;
  }

  const url = pickOutput(prediction.output);
  if (!url) {
    throw new ProviderError('Replicate finished without a video URL', {
      retryable: false,
      raw: JSON.stringify(prediction.output ?? null).slice(0, 200),
    });
  }
  const dest = path.join(config.segmentDir, `replicate-${req.seed}-${Date.now()}.mp4`);
  await downloadToFile(url, dest, withDeadline(signal, 300_000));
  return { videoPath: dest };
}

async function create(
  apiToken: string,
  req: MotionRequest,
  signal: AbortSignal,
): Promise<Prediction> {
  // Replicate accepts the first frame as a data URI, which keeps this provider
  // working even when the public image host is down. Base64 inflates the body by
  // a third and the request has a size limit, so only small photos travel inline
  // and anything larger goes through the hosted URL.
  const bytes = await readFile(req.imagePath);
  const firstFrame =
    bytes.byteLength <= 3 * 1024 * 1024
      ? `data:${normaliseMime(req.imageMime)};base64,${bytes.toString('base64')}`
      : await req.getPublicImageUrl();

  const res = await fetch(
    `https://api.replicate.com/v1/models/${MODEL_OWNER}/${MODEL_NAME}/predictions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
        // Return as soon as the run settles, but never hold the connection open
        // for the whole generation (polling picks it up from urls.get).
        Prefer: 'wait=45',
      },
      body: JSON.stringify({
        input: {
          prompt: `${req.prompt} Keep the product shape, logo and colours unchanged.`,
          first_frame_image: firstFrame,
          // Our prompts are already precise; the optimizer rewrites them.
          prompt_optimizer: false,
        },
      }),
      signal: withDeadline(signal, 90_000),
    },
  );

  if (!res.ok) {
    const raw = (await res.text().catch(() => '')).slice(0, 300);
    const detail = reasonFrom(raw);
    throw new ProviderError(
      res.status === 402
        ? `Replicate free test runs are used up on this account — add billing to continue${detail ? ` (${detail})` : ''}`
        : `Replicate rejected the job (HTTP ${res.status})${detail ? `: ${detail}` : ''}`,
      {
        status: res.status,
        retryable: res.status === 429 || res.status >= 500,
        raw,
      },
    );
  }

  return (await res.json()) as Prediction;
}

/** multer hands back image/jpg for some JPEGs, which is not a valid media type. */
function normaliseMime(mime: string): string {
  const clean = (mime || 'image/png').toLowerCase();
  return clean === 'image/jpg' ? 'image/jpeg' : clean;
}

/** The model returns a URI string; normalise every shape we have seen. */
function pickOutput(output: unknown): string | null {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    for (const item of output) {
      const hit = pickOutput(item);
      if (hit) return hit;
    }
    return null;
  }
  if (output && typeof output === 'object') {
    const obj = output as Record<string, unknown>;
    for (const key of ['url', 'video', 'output']) {
      const hit = pickOutput(obj[key]);
      if (hit) return hit;
    }
  }
  return null;
}

function reasonFrom(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { detail?: string; title?: string; error?: string };
    return parsed.detail ?? parsed.title ?? parsed.error ?? '';
  } catch {
    return raw.slice(0, 160);
  }
}

