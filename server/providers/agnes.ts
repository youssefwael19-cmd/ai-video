import path from 'node:path';
import { config } from '../config.js';
import { downloadToFile, sleep, withDeadline } from './net.js';
import { ProviderError, type MotionRequest, type Provider } from './types.js';

/**
 * Agnes AI, free trial model `agnes-video-2.5-flash` (720P, 4-12s, $0/second
 * while the promotion lasts, rate limited to roughly one video a minute).
 * It is an OpenAI-Videos-style async API: create a task, then poll /agnesapi.
 */
const BASE = 'https://apihub.agnes-ai.com';
const MODEL = 'agnes-video-2.5-flash';

export function createAgnesProviders(apiKey: string): Provider[] {
  return [
    {
      id: 'agnes:video-2.5-flash',
      label: 'agnes video flash',
      service: 'Agnes AI',
      model: 'Agnes Video 2.5 Flash (720P, free trial)',
      maxSeconds: 10,
      requires: {
        env: 'AGNES_API_KEY',
        signupUrl: 'https://platform.agnes-ai.com/',
        note: 'Free trial model at $0/second, ~1 video per minute',
      },
      isConfigured: () => apiKey.length > 0,
      generate: (req, signal) => run(apiKey, req, signal),
    },
  ];
}

async function run(apiKey: string, req: MotionRequest, signal: AbortSignal) {
  const imageUrl = await req.getPublicImageUrl();
  // Flash accepts 4-12 seconds, and only the 720P tier.
  const seconds = Math.min(12, Math.max(4, Math.round(req.seconds)));

  const createRes = await fetch(`${BASE}/v1/videos`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt: req.prompt,
      seconds: String(seconds),
      mode: 'keyframe',
      size: '720P',
      aspect_ratio: req.aspect,
      first_frame: imageUrl,
      seed: req.seed,
    }),
    signal: withDeadline(signal, 60_000),
  });

  if (!createRes.ok) {
    const raw = (await createRes.text().catch(() => '')).slice(0, 300);
    throw new ProviderError(
      `Agnes rejected the job (HTTP ${createRes.status})${reasonFrom(raw) ? `: ${reasonFrom(raw)}` : ''}`,
      {
        status: createRes.status,
        retryable: createRes.status === 429 || createRes.status >= 500,
        raw,
      },
    );
  }

  const body = (await createRes.json()) as TaskBody;

  if (isFailed(body.status)) {
    throw new ProviderError(`Agnes task failed: ${errorText(body.error) || 'unknown reason'}`, {
      retryable: false,
    });
  }
  const immediate = isDone(body.status) ? videoUrl(body) : null;
  if (immediate) return persist(immediate, req, signal);

  const videoId = body.video_id;
  if (!videoId) throw new ProviderError('Agnes did not return a video id');

  // The query form with model_name is required for keyframe tasks.
  const pollUrl =
    `${BASE}/agnesapi?video_id=${encodeURIComponent(videoId)}&model_name=${encodeURIComponent(MODEL)}`;
  const deadline = Date.now() + 9 * 60_000;

  while (Date.now() < deadline) {
    await sleep(2500, signal);
    const res = await fetch(pollUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: withDeadline(signal, 45_000),
    });
    if (!res.ok) {
      if ([401, 403, 404].includes(res.status)) {
        throw new ProviderError(`Agnes refused the poll (HTTP ${res.status})`, {
          status: res.status,
          retryable: false,
        });
      }
      continue;
    }
    const task = (await res.json()) as TaskBody;
    if (isFailed(task.status)) {
      throw new ProviderError(`Agnes task failed: ${errorText(task.error) || 'unknown reason'}`, {
        retryable: false,
      });
    }
    if (isDone(task.status)) {
      const url = videoUrl(task);
      if (!url) throw new ProviderError('Agnes finished without a video URL');
      return persist(url, req, signal);
    }
  }

  throw new ProviderError('Agnes generation timed out', { retryable: true });
}

async function persist(url: string, req: MotionRequest, signal: AbortSignal) {
  const dest = path.join(config.segmentDir, `agnes-${req.seed}-${Date.now()}.mp4`);
  await downloadToFile(url, dest, withDeadline(signal, 300_000));
  return { videoPath: dest };
}

/** The task shape is unverified beyond the documented fields, so accept both. */
interface TaskBody {
  video_id?: string;
  status?: string;
  url?: string;
  video_url?: string;
  data?: { url?: string; video_url?: string }[];
  error?: { message?: string } | string | null;
}

/** Video APIs spell the finished state differently; never poll a terminal one. */
function isDone(status: string | undefined): boolean {
  return status === 'completed' || status === 'succeeded' || status === 'success';
}

function isFailed(status: string | undefined): boolean {
  return status === 'failed' || status === 'error' || status === 'cancelled' || status === 'expired';
}

function videoUrl(body: TaskBody): string | null {
  return body.url ?? body.video_url ?? body.data?.[0]?.url ?? body.data?.[0]?.video_url ?? null;
}

/** Agnes reports refusals as {error:{message}} or {error:"..."} or {message}. */
function reasonFrom(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: string } | string;
      message?: string;
    };
    return errorText(parsed.error) || parsed.message || '';
  } catch {
    return raw.slice(0, 160);
  }
}

function errorText(error: { message?: string } | string | null | undefined): string {
  if (!error) return '';
  return typeof error === 'string' ? error : (error.message ?? '');
}

