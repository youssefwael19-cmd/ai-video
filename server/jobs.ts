import { randomUUID } from 'node:crypto';
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
import { composeSegments, renderLocalSegment, renderPath, TOTAL_SECONDS } from './compose.js';
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
  imagePath: string;
}

const jobs = new Map<string, StoredJob>();
const active = new Set<string>();

export function createJob(input: {
  imagePath: string;
  imageMime: string;
  brief: string;
  style: StylePreset;
  aspect: Aspect;
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
  void runJob(job, beats, input.imageMime);
  return toView(job);
}

/** Finished jobs are only kept for the history list, so drop the oldest first. */
function evictOldJobs() {
  const MAX_JOBS = 100;
  if (jobs.size < MAX_JOBS) return;
  const finished = [...jobs.values()]
    .filter((job) => job.status === 'done' || job.status === 'error')
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const job of finished) {
    if (jobs.size < MAX_JOBS) break;
    jobs.delete(job.id);
  }
}

export function getJob(id: string): JobView | null {
  const job = jobs.get(id);
  return job ? toView(job) : null;
}

function toView(job: StoredJob): JobView {
  const { imagePath: _imagePath, ...view } = job;
  return view;
}

function log(job: StoredJob, text: string, kind: JobView['log'][number]['kind'] = 'info') {
  job.log.push({ at: new Date().toISOString(), text, kind });
  if (job.log.length > 120) job.log.shift();
}

async function runJob(job: StoredJob, beats: BeatPlan[], imageMime: string) {
  if (active.has(job.id)) return;
  active.add(job.id);
  const started = Date.now();

  try {
    job.status = 'running';
    log(job, `Beat plan ready — ${beats.length} × 5s clips stitched to ${TOTAL_SECONDS}s`, 'info');
    log(job, `Publishing product photo for URL-based providers…`);
    getPublicImageUrl(job.imagePath).then(
      (url) => log(job, `Photo reachable at ${url}`, 'ok'),
      () => log(job, 'Could not publish photo publicly — upload-only providers will still work', 'warn'),
    );

    const clips: (string | null)[] = new Array(beats.length).fill(null);

    for (let index = 0; index < beats.length; index += 1) {
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
        getPublicImageUrl: () => getPublicImageUrl(job.imagePath),
      };

      try {
        const { output, provider } = await generateBeat(request, (attempt: Attempt) => {
          if (attempt.skipped) {
            log(job, `${beat.label} → ${attempt.label} skipped: ${attempt.error ?? 'cooling down'}`, 'info');
            return;
          }
          segment.attempts += 1;
          log(
            job,
            attempt.ok
              ? `${beat.label} → ${attempt.label} succeeded in ${(attempt.ms / 1000).toFixed(1)}s`
              : `${beat.label} → ${attempt.label} declined: ${attempt.error ?? 'unknown error'} — trying next provider`,
            attempt.ok ? 'ok' : 'warn',
          );
        });
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
          index,
          outputPath: dest,
        });
        clips[index] = dest;
        job.segments[index].status = 'fallback';
        log(
          job,
          `${beats[index].label} → no AI clip, so the local motion pass fills this beat`,
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
    await composeSegments({ segments: clips as string[], aspect: job.aspect, outputPath: output });

    job.progress = 100;
    job.status = 'done';
    job.videoUrl = `/media/renders/${job.id}.mp4`;
    job.downloadUrl = `/media/renders/${job.id}.mp4?download=1`;
    job.finishedAt = Date.now();
    log(job, `Done in ${((Date.now() - started) / 1000).toFixed(1)}s — ${TOTAL_SECONDS}s video ready`, 'ok');
  } catch (err) {
    job.status = 'error';
    job.error = err instanceof Error ? err.message : String(err);
    log(job, `Render failed: ${job.error}`, 'error');
  } finally {
    active.delete(job.id);
  }
}

export function listJobs(): JobView[] {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 20).map(toView);
}
