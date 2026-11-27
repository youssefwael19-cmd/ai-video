import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateBeat, type Attempt } from './gateway.js';
import { getPublicImageUrl } from './providers/net.js';
import type { Aspect, MotionRequest, StylePreset } from './providers/types.js';
import {
  BEAUTY,
  type BeatPlan,
  buildBeatPrompt,
  planBeats,
} from './prompt.js';
import {
  composeSegments,
  probeMedia,
  renderLocalSegment,
  renderPath,
  TOTAL_SECONDS,
} from './compose.js';
import { config } from './config.js';

export type JobStatus = 'queued' | 'running' | 'composing' | 'done' | 'error';

export interface SegmentView {
  index: number;
  label: string;
  prompt: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'fallback';
  providerId?: string;
  providerLabel?: string;
  model?: string;
  /** Size the clip actually came back at, e.g. ``720x1280``. */
  resolution?: string;
  attempts: number;
  durationSeconds?: number;
  error?: string;
}

export interface JobView {
  id: string;
  status: JobStatus;
  progress: number;
  aspect: Aspect;
  style: StylePreset;
  brief: string;
  imageUrl: string;
  videoUrl?: string;
  downloadUrl?: string;
  durationSeconds: number;
  usedFallback: boolean;
  segments: SegmentView[];
  log: { at: string; text: string; kind: 'info' | 'ok' | 'warn' | 'error' }[];
  error?: string;
  createdAt: number;
  finishedAt?: number;
}

interface StoredJob extends JobView {
  /** Last time this pod wrote the job, used to spot a render orphaned by a restart. */
  updatedAt?: number;
  /**
   * Last time the pod running the render checked in. A live render re-stamps it
   * every few seconds, so silence here means the process behind the job is gone.
   */
  heartbeatAt?: number;
  imagePath: string;
  /** The app's own public origin, used to serve the photo to URL-only providers. */
  publicBase?: string;
}

const UNFINISHED: JobStatus[] = ['queued', 'running', 'composing'];

/** How often a render re-stamps its job file while it is still working. */
const HEARTBEAT_MS = 10_000;
/**
 * Silence longer than this means nothing is driving the job any more: the pod
 * was killed mid-render (a rollout, an OOM kill, a restart). Nothing legitimately
 * goes this long without a write — a beat in flight still logs and heartbeats.
 */
const STALE_MS = 60_000;
/** No 15s video is worth waiting longer than this; past it the job is declared lost. */
const JOB_CEILING_MS = 20 * 60_000;
/**
 * One beat may walk the whole provider pool, and each attempt or Space render
 * can take minutes. Past this the beat is handed to the local motion pass so a
 * single wedged provider cannot hold a whole render open.
 */
const BEAT_CEILING_MS = 6 * 60_000;

const jobs = new Map<string, StoredJob>();
const active = new Set<string>();

/**
 * The deployment can run more than one replica, and a rollout replaces pods, so
 * an in-memory map alone loses a job the moment a poll lands on another pod.
 * Every change is mirrored to DATA_DIR/jobs, which all replicas share.
 */
async function persist(job: StoredJob): Promise<void> {
  const now = Date.now();
  job.updatedAt = now;
  job.heartbeatAt = now;
  const file = path.join(config.jobsDir, `${job.id}.json`);
  // Replicas can share a PID, so a pid-based temp name collides when two pods
  // write the same job and the second rename finds the file already moved.
  const tmp = `${file}.${randomUUID()}.tmp`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await mkdir(config.jobsDir, { recursive: true });
      await writeFile(tmp, JSON.stringify(job), { mode: 0o600 });
      await rename(tmp, file);
      return;
    } catch (err) {
      await unlink(tmp).catch(() => {});
      if (attempt === 2) {
        console.warn(`Could not persist job ${job.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}

function isJobId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

async function readPersisted(id: string): Promise<StoredJob | null> {
  if (!isJobId(id)) return null;
  try {
    const raw = await readFile(path.join(config.jobsDir, `${id}.json`), 'utf8');
    return JSON.parse(raw) as StoredJob;
  } catch {
    return null;
  }
}

/** Keep the newest `MAX_JOBS` job files so the volume cannot grow forever. */
export async function pruneJobs(): Promise<void> {
  try {
    const names = (await readdir(config.jobsDir)).filter((name) => name.endsWith('.json'));
    if (names.length <= MAX_JOBS) return;
    const stamped = await Promise.all(
      names.map(async (name) => {
        const info = await stat(path.join(config.jobsDir, name)).catch(() => null);
        return { name, mtime: info?.mtimeMs ?? 0 };
      }),
    );
    stamped.sort((a, b) => b.mtime - a.mtime);
    for (const { name } of stamped.slice(MAX_JOBS)) {
      await unlink(path.join(config.jobsDir, name)).catch(() => {});
    }
  } catch {
    /* no jobs directory yet */
  }
}

export function createJob(input: {
  imagePath: string;
  imageMime: string;
  brief: string;
  style: StylePreset;
  aspect: Aspect;
  publicBase?: string;
}): JobView {
  const id = randomUUID();
  const beats = planBeats(input.brief, input.style);
  const job: StoredJob = {
    id,
    status: 'queued',
    progress: 0,
    aspect: input.aspect,
    style: input.style,
    brief: input.brief,
    imagePath: input.imagePath,
    publicBase: input.publicBase,
    imageUrl: `/media/uploads/${path.basename(input.imagePath)}`,
    durationSeconds: TOTAL_SECONDS,
    usedFallback: false,
    segments: beats.map((beat, index) => ({
      index,
      label: beat.label,
      prompt: buildBeatPrompt(beat, input.brief, input.style),
      status: 'pending',
      attempts: 0,
    })),
    log: [],
    createdAt: Date.now(),
  };
  evictOldJobs();
  jobs.set(id, job);
  void persist(job);
  // Last line of defence: if the render ever throws outside its own try/catch
  // the job must still leave "queued" instead of hanging there.
  void runJob(job, beats, input.imageMime).catch((err) => failJob(job, err));
  return toView(job);
}

/** Finished jobs are only kept for the history list, so drop the oldest first. */
const MAX_JOBS = 100;

function evictOldJobs() {
  if (jobs.size < MAX_JOBS) return;
  const finished = [...jobs.values()]
    .filter((job) => job.status === 'done' || job.status === 'error')
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const job of finished) {
    if (jobs.size < MAX_JOBS) break;
    jobs.delete(job.id);
  }
}

/**
 * A pod that is killed mid-render leaves its job marked running. The job file
 * stops being stamped at that moment, so a job that has been silent for a while
 * is closed out here — on whichever replica the next poll lands on — instead of
 * sitting at "running" forever with no process behind it.
 */
function reconcile(job: StoredJob): StoredJob {
  if (!UNFINISHED.includes(job.status)) return job;
  const now = Date.now();
  const lastSeen = Math.max(job.heartbeatAt ?? 0, job.updatedAt ?? 0, job.createdAt);
  const silentFor = now - lastSeen;
  const overran = now - job.createdAt > JOB_CEILING_MS;
  if (silentFor <= STALE_MS && !overran) return job;

  const reason = silentFor > STALE_MS
    ? 'the render stopped reporting in, so the app was restarted or the render was killed'
    : `the render was still running after ${Math.round(JOB_CEILING_MS / 60_000)} minutes`;
  const error = `Render interrupted — ${reason}. Start it again.`;
  const interrupted: StoredJob = {
    ...job,
    status: 'error',
    error,
    progress: 100,
    finishedAt: now,
    log: [
      ...job.log,
      { at: new Date(now).toISOString(), text: error, kind: 'error' as const },
    ].slice(-120),
  };
  // Write it back so every replica and every later poll sees the same verdict
  // instead of re-deciding whether the job is dead.
  void persist(interrupted);
  return interrupted;
}

export async function getJob(id: string): Promise<JobView | null> {
  // A job this pod is running is authoritative; otherwise read the shared copy
  // another replica wrote.
  const local = jobs.get(id);
  if (local) return toView(active.has(id) ? local : reconcile(local));
  const stored = await readPersisted(id);
  return stored ? toView(reconcile(stored)) : null;
}

function toView(job: StoredJob): JobView {
  const { imagePath: _imagePath, ...view } = job;
  return view;
}

function log(job: StoredJob, text: string, kind: JobView['log'][number]['kind'] = 'info') {
  job.log.push({ at: new Date().toISOString(), text, kind });
  if (job.log.length > 120) job.log.shift();
  void persist(job);
}

/** Close a job out as failed. Safe to call twice: the second call is a no-op. */
async function failJob(job: StoredJob, err: unknown): Promise<void> {
  if (job.status === 'done' || job.status === 'error') return;
  job.status = 'error';
  job.progress = 100;
  job.error = err instanceof Error ? err.message : String(err);
  job.finishedAt = Date.now();
  log(job, `Render failed: ${job.error}`, 'error');
  await persist(job);
}

/** Reject once `ms` passes, so one wedged provider cannot hold a beat open. */
function deadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, expiry]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function runJob(job: StoredJob, beats: BeatPlan[], imageMime: string) {
  if (active.has(job.id)) return;
  active.add(job.id);
  const started = Date.now();
  // The heartbeat is what lets any replica tell an in-flight render from one
  // whose process died; without it a killed pod's job would look alive forever.
  const heartbeat = setInterval(() => {
    if (job.status === 'done' || job.status === 'error') return;
    void persist(job);
  }, HEARTBEAT_MS);

  try {
    job.status = 'running';
    log(job, `Beat plan ready — ${beats.length} × 5s clips stitched to ${TOTAL_SECONDS}s`, 'info');
    log(job, `Publishing product photo for URL-based providers…`);
    getPublicImageUrl(job.imagePath, job.publicBase).then(
      (url) => log(job, `Photo reachable at ${url}`, 'ok'),
      () => log(job, 'Could not publish photo publicly — upload-only providers will still work', 'warn'),
    );

    await persist(job);
    const clips: (string | null)[] = new Array(beats.length).fill(null);

    for (let index = 0; index < beats.length; index += 1) {
      // Each beat is bounded, but three near-ceiling beats would still outlast
      // the whole job; give up here rather than leaving a render that can never
      // finish in the queue.
      if (Date.now() - started > JOB_CEILING_MS) {
        throw new Error(`The render passed ${Math.round(JOB_CEILING_MS / 60_000)} minutes without finishing`);
      }
      const beat = beats[index];
      const segment = job.segments[index];
      segment.status = 'running';
      job.progress = Math.round((index / beats.length) * 82);

      const request: MotionRequest = {
        imagePath: job.imagePath,
        imageMime,
        prompt: segment.prompt,
        negativePrompt: BEAUTY.negative,
        seconds: 5,
        aspect: job.aspect,
        seed: index === 0 ? 12345 : 12345 + index,
        getPublicImageUrl: () => getPublicImageUrl(job.imagePath, job.publicBase),
      };

      let successMs = 0;
      try {
        const clip = deadline(
          generateBeat(request, (attempt: Attempt) => {
            if (attempt.skipped) {
              log(job, `${beat.label} → ${attempt.label} skipped: ${attempt.error ?? 'cooling down'}`, 'info');
              return;
            }
            segment.attempts += 1;
            if (attempt.ok) {
              // Logged once the clip is probed: the size it really came back at
              // is what shows a provider serving a cheaper tier than requested.
              successMs = attempt.ms;
              return;
            }
            log(
              job,
              `${beat.label} → ${attempt.label} declined: ${attempt.error ?? 'unknown error'} — trying next provider`,
              'warn',
            );
          }),
          BEAT_CEILING_MS,
          'No provider finished this beat in time',
        );
        const { output, provider } = await clip;
        // Reported by every provider, including Atmee stepping down to 480p
        // when credits are short, so a quality drop is visible in the job.
        const info = await probeMedia(output.videoPath).catch(() => null);
        segment.resolution = info && info.width > 0 ? `${info.width}x${info.height}` : undefined;
        log(
          job,
          `${beat.label} → ${provider.label} succeeded in ${(successMs / 1000).toFixed(1)}s${
            segment.resolution ? ` at ${segment.resolution}` : ''
          }`,
          'ok',
        );
        segment.status = 'done';
        segment.providerId = provider.id;
        segment.providerLabel = provider.label;
        segment.model = provider.model;
        segment.durationSeconds = output.durationSeconds;
        clips[index] = output.videoPath;
      } catch (err) {
        segment.status = 'failed';
        segment.error = err instanceof Error ? err.message : String(err);
        log(job, `${beat.label} → every provider declined this beat`, 'error');
      }
    }

    job.status = 'composing';
    job.progress = 88;
    const output = renderPath(job.id);

    // Fill only the beats the pool could not generate, so AI clips that did
    // come back are kept instead of being discarded for a whole-video fallback.
    const missing = clips
      .map((clip, index) => (clip ? null : index))
      .filter((index): index is number => index !== null);

    if (missing.length > 0) {
      if (!config.enableLocalFallback) {
        throw new Error('Not enough generated clips to build the video, and the local fallback is disabled');
      }
      job.usedFallback = true;
      for (const index of missing) {
        const dest = path.join(config.segmentDir, `local-${job.id}-${index}.mp4`);
        await renderLocalSegment({
          imagePath: job.imagePath,
          aspect: job.aspect,
          kind: beats[index].kind,
          outputPath: dest,
        });
        clips[index] = dest;
        const info = await probeMedia(dest).catch(() => null);
        job.segments[index].resolution = info && info.width > 0 ? `${info.width}x${info.height}` : undefined;
        job.segments[index].status = 'fallback';
        log(
          job,
          `${beats[index].label} → no AI clip, so the local motion pass fills this beat${
            job.segments[index].resolution ? ` at ${job.segments[index].resolution}` : ''
          }`,
          'warn',
        );
      }
    }

    log(
      job,
      missing.length > 0
        ? `Compositing ${beats.length - missing.length} AI beats + ${missing.length} local motion beat(s) into a 15s timeline…`
        : 'Compositing beats into a 15s timeline…',
    );
    // Beats the local pass filled already move the photograph themselves, so
    // the finishing move is only layered onto the AI ones.
    const kinds = beats.map((beat, index) => (missing.includes(index) ? null : beat.kind));
    await composeSegments({ segments: clips as string[], aspect: job.aspect, outputPath: output, kinds });

    job.progress = 100;
    job.status = 'done';
    job.videoUrl = `/media/renders/${job.id}.mp4`;
    job.downloadUrl = `/media/renders/${job.id}.mp4?download=1`;
    job.finishedAt = Date.now();
    log(job, `Done in ${((Date.now() - started) / 1000).toFixed(1)}s — ${TOTAL_SECONDS}s video ready`, 'ok');
    await persist(job);
  } catch (err) {
    await failJob(job, err);
  } finally {
    clearInterval(heartbeat);
    active.delete(job.id);
  }
}

export async function listJobs(): Promise<JobView[]> {
  const merged = new Map<string, StoredJob>(jobs);
  try {
    const names = (await readdir(config.jobsDir)).filter((name) => name.endsWith('.json'));
    for (const name of names) {
      const id = name.slice(0, -5);
      if (merged.has(id)) continue;
      const job = await readPersisted(id);
      if (job) merged.set(id, reconcile(job));
    }
  } catch {
    /* no jobs directory yet */
  }
  return [...merged.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 20)
    .map(toView);
}
