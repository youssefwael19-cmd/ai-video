import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { ProviderError } from './types.js';

/**
 * Some free providers (Novita, Magic Hour, Agnes, Atmee) require a publicly
 * reachable https URL instead of a multipart upload. We publish the photo to a
 * free, no-account host and cache the resulting URL per job.
 */
const cache = new Map<string, Promise<string>>();

/**
 * URL-based providers must fetch a real image. catbox/tmpfiles sometimes answer
 * with a redirect to an HTML page, which every provider rejects, so anything we
 * get from a third party is fetched once and checked before it is handed on.
 */
async function isUsableImageUrl(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
      headers: { accept: 'image/*' },
    });
    const type = res.headers.get('content-type') ?? '';
    await res.body?.cancel().catch(() => {});
    return res.ok && type.toLowerCase().startsWith('image/');
  } catch {
    return false;
  }
}

/** Internal/loopback hosts are not reachable by an external provider. */
function isPublicBase(base: string): boolean {
  try {
    const host = new URL(base).hostname;
    return !(
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '[::1]' ||
      host.endsWith('.local') ||
      host.endsWith('.internal')
    );
  } catch {
    return false;
  }
}

/**
 * `publicBase` is the app's own public origin (e.g. https://app.example.com),
 * derived from the incoming request so photos are served by us instead of a
 * third-party host that providers cannot reliably download from.
 */
export function getPublicImageUrl(localPath: string, publicBase?: string): Promise<string> {
  // An explicit override is a complete directory (legacy behaviour); a request
  // derived origin is the app root, where the photo lives under /media/uploads.
  const configured = config.publicImageUrlOverride.replace(/\/$/, '');
  const directory = configured
    ? configured
    : publicBase && isPublicBase(publicBase)
      ? `${publicBase.replace(/\/$/, '')}/media/uploads`
      : '';
  const cacheKey = `${directory}|${localPath}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const task = directory
    ? Promise.resolve(`${directory}/${path.basename(localPath)}`)
    : publish(localPath).catch((err) => {
        cache.delete(cacheKey);
        throw err;
      });
  cache.set(cacheKey, task);
  return task;
}

async function publish(localPath: string): Promise<string> {
  const bytes = await readFile(localPath);
  const errors: string[] = [];

  for (const host of [catbox, tmpfiles]) {
    try {
      const url = await host(bytes, path.basename(localPath));
      if (url && (await isUsableImageUrl(url))) return url;
      errors.push(`${url ? 'upload host returned a non-image response' : 'upload host returned no URL'}`);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  throw new ProviderError(`Could not publish the product photo to a public URL (${errors.join('; ')})`, {
    retryable: true,
  });
}

async function catbox(bytes: Buffer, name: string): Promise<string | null> {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('fileToUpload', new Blob([new Uint8Array(bytes)]), name);
  const res = await fetch('https://catbox.moe/user/api.php', {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(45_000),
  });
  const text = (await res.text()).trim();
  if (res.ok && /^https?:\/\//.test(text)) return text;
  throw new Error(`catbox ${res.status}: ${text.slice(0, 100)}`);
}

async function tmpfiles(bytes: Buffer, name: string): Promise<string | null> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)]), name);
  const res = await fetch('https://tmpfiles.org/api/v1/upload', {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(45_000),
  });
  const json = (await res.json()) as { data?: { url?: string } };
  const url = json.data?.url;
  if (res.ok && url) return url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
  throw new Error(`tmpfiles ${res.status}`);
}

/**
 * Bound one request by both a per-request timeout and the caller's cancellation
 * signal. The gateway aborts a beat after 9 minutes; without this the fetch
 * kept running to completion in the background after the beat was given up on.
 */
export function withDeadline(signal: AbortSignal, ms: number): AbortSignal {
  if (signal.aborted) return signal;
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('request deadline exceeded')), ms);
  controller.signal.addEventListener(
    'abort',
    () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    },
    { once: true },
  );
  return controller.signal;
}

/** Wait `ms`, but reject the moment the caller cancels the beat. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ProviderError('Cancelled', { retryable: false }));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderError('Cancelled', { retryable: false }));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Small helper for adapters that need to persist a remote mp4 locally. */
export async function downloadToFile(url: string, dest: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal: signal ?? AbortSignal.timeout(180_000) });
  if (!res.ok) {
    throw new ProviderError(`Downloading the generated clip failed (HTTP ${res.status})`, {
      status: res.status,
      retryable: res.status >= 500 || res.status === 429,
    });
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength < 2048) throw new ProviderError('Provider returned an empty video file');
  await writeFile(dest, buf);
  return dest;
}
