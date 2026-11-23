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

export function getPublicImageUrl(localPath: string): Promise<string> {
  const cached = cache.get(localPath);
  if (cached) return cached;

  const task = config.publicImageUrlOverride
    ? Promise.resolve(`${config.publicImageUrlOverride.replace(/\/$/, '')}/${path.basename(localPath)}`)
    : publish(localPath).catch((err) => {
        cache.delete(localPath);
        throw err;
      });
  cache.set(localPath, task);
  return task;
}

async function publish(localPath: string): Promise<string> {
  const bytes = await readFile(localPath);
  const errors: string[] = [];

  for (const host of [catbox, tmpfiles]) {
    try {
      const url = await host(bytes, path.basename(localPath));
      if (url) return url;
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
