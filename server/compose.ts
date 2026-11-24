import { spawn } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { config } from './config.js';
import type { Aspect } from './providers/types.js';

const ffmpegBin = ffmpegStatic ?? 'ffmpeg';

export const BEAT_SECONDS = 5;
export const TOTAL_SECONDS = 15;

export function sizeFor(aspect: Aspect): { width: number; height: number } {
  switch (aspect) {
    case '9:16':
      return { width: 1080, height: 1920 };
    case '16:9':
      return { width: 1920, height: 1080 };
    default:
      return { width: 1080, height: 1080 };
  }
}

export async function ensureDirs(): Promise<void> {
  await Promise.all(
    [config.uploadDir, config.segmentDir, config.renderDir].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  );
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Working files are written for every render, so on an install that stays up
 * (or a host that mounts a fixed volume) the directory would grow forever.
 * Uploads and intermediate beats are thrown away after a day; finished videos
 * are kept for a week so a link shared yesterday still plays.
 */
export async function pruneDataDir(): Promise<number> {
  const now = Date.now();
  const targets = [
    { dir: config.uploadDir, maxAgeMs: DAY },
    { dir: config.segmentDir, maxAgeMs: DAY },
    { dir: config.renderDir, maxAgeMs: 7 * DAY },
  ];

  let removed = 0;
  for (const { dir, maxAgeMs } of targets) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const info = await stat(file);
        if (info.isFile() && now - info.mtimeMs > maxAgeMs) {
          await rm(file, { force: true });
          removed += 1;
        }
      } catch {
        /* already gone, or not ours to remove */
      }
    }
  }
  return removed;
}

function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`ffmpeg exited with ${code}: ${stderr.slice(-600)}`));
    });
  });
}

/** ffmpeg is used for probing too, so no extra binary is needed. */
export async function probeDuration(file: string): Promise<number> {
  const child = spawn(ffmpegBin, ['-i', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  const collect = (d: Buffer) => (stderr += d.toString());
  const done = new Promise<void>((resolve) => {
    child.stderr.on('data', collect);
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
  child.stdout?.on('data', () => undefined);
  await done;
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!match) return 0;
  const [, h, m, s] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

export interface ComposeInput {
  segments: string[];
  aspect: Aspect;
  outputPath: string;
}

/**
 * Stitch the generated beats into exactly 15 seconds: every beat fills a 5s
 * slot (retimed if the model returned a different length) and short fades hide
 * the cut between beats.
 */
export async function composeSegments({ segments, aspect, outputPath }: ComposeInput): Promise<number> {
  const { width, height } = sizeFor(aspect);
  const durations = await Promise.all(segments.map((file) => probeDuration(file).catch(() => 0)));

  const filterParts: string[] = [];
  segments.forEach((_, index) => {
    const measured = durations[index];
    const factor = measured > 0 && measured < BEAT_SECONDS - 0.15 ? Math.min(1.3, BEAT_SECONDS / measured) : 1;
    const slow = factor > 1.01 ? `,setpts=${factor.toFixed(4)}*PTS` : '';
    filterParts.push(
      `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},` +
        `fps=30,setpts=PTS-STARTPTS${slow},` +
        `tpad=stop_mode=clone:stop_duration=${BEAT_SECONDS},trim=duration=${BEAT_SECONDS},setpts=PTS-STARTPTS,` +
        `fade=t=in:st=0:d=0.25,fade=t=out:st=${BEAT_SECONDS - 0.25}:d=0.25,setsar=1[v${index}]`,
    );
  });
  const concatInputs = segments.map((_, i) => `[v${i}]`).join('');
  filterParts.push(`${concatInputs}concat=n=${segments.length}:v=1:a=0[out]`);

  const args = [
    '-y',
    ...segments.flatMap((file) => ['-i', file]),
    '-filter_complex',
    filterParts.join(';'),
    '-map',
    '[out]',
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-r',
    '30',
    '-t',
    String(TOTAL_SECONDS),
    '-movflags',
    '+faststart',
    outputPath,
  ];

  await run(args);
  return TOTAL_SECONDS;
}

/** Per-beat motion moves shared by the fallback renderers. */
const localMotion = (frames: number): string[] => [
  `zoompan=z='1.02+0.0016*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
  `zoompan=z='1.22':x='(iw-iw/zoom)*(on/${frames})':y='(ih-ih/zoom)*0.4'`,
  `zoompan=z='1.34-0.0018*on':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(1-on/${frames})'`,
];

/**
 * One 5s Ken Burns beat over the product photo. Used to fill a single beat that
 * every AI provider declined, so the AI beats that did come back are kept
 * instead of being thrown away for a whole-video fallback.
 */
export async function renderLocalSegment({
  imagePath,
  aspect,
  index,
  outputPath,
}: {
  imagePath: string;
  aspect: Aspect;
  index: number;
  outputPath: string;
}): Promise<number> {
  const { width, height } = sizeFor(aspect);
  const w2 = width * 2;
  const h2 = height * 2;
  const frames = BEAT_SECONDS * 30;
  const moves = localMotion(frames);
  const move = moves[index % moves.length];

  // d=1: the looped still already supplies one input frame per output frame, so
  // letting zoompan emit `frames` frames per input would finish the move early
  // and then hold it for the rest of the beat.
  const filter =
    `[0:v]scale=${w2}:${h2}:force_original_aspect_ratio=increase,crop=${w2}:${h2},` +
    `${move}:d=1:s=${width}x${height}:fps=30,` +
    `trim=duration=${BEAT_SECONDS},setpts=PTS-STARTPTS,fade=t=in:st=0:d=0.25,` +
    `fade=t=out:st=${BEAT_SECONDS - 0.25}:d=0.25[v]`;

  await run([
    '-y',
    '-loop',
    '1',
    '-framerate',
    '30',
    '-i',
    imagePath,
    '-filter_complex',
    filter,
    '-map',
    '[v]',
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '21',
    '-pix_fmt',
    'yuv420p',
    '-r',
    '30',
    '-t',
    String(BEAT_SECONDS),
    '-movflags',
    '+faststart',
    outputPath,
  ]);

  return BEAT_SECONDS;
}



export function renderPath(jobId: string): string {
  return path.join(config.renderDir, `${jobId}.mp4`);
}
