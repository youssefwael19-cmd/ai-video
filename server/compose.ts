import { spawn } from 'node:child_process';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { config } from './config.js';
import type { BeatKind } from './prompt.js';
import type { Aspect } from './providers/types.js';

const ffmpegBin = ffmpegStatic ?? 'ffmpeg';

export const BEAT_SECONDS = 5;
export const TOTAL_SECONDS = 15;

/**
 * Atmee renders at 25 fps and LTX at 24, so 25 keeps every generated frame.
 * Retiming those to 30 only ever duplicated frames, which read as judder on the
 * slow camera moves these beats use.
 */
const FPS = 25;

/**
 * 720p keeps the free plan's 256 MiB container alive: libx264 at 1080p peaks
 * around 300 MiB on its own, which got the process killed mid-compose.
 */
export function sizeFor(aspect: Aspect): { width: number; height: number } {
  switch (aspect) {
    case '9:16':
      return { width: 720, height: 1280 };
    case '16:9':
      return { width: 1280, height: 720 };
    default:
      return { width: 720, height: 720 };
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

/**
 * Every ffmpeg call is bounded. A single frame of x264 takes milliseconds, so
 * a call still running after five minutes is wedged; killing it turns that into
 * a failed job instead of a render that stays "running" forever.
 */
const FFMPEG_TIMEOUT_MS = 5 * 60_000;

function run(args: string[], timeoutMs = FFMPEG_TIMEOUT_MS): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        return reject(new Error(`ffmpeg gave no result after ${timeoutMs / 60_000} minutes`));
      }
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`ffmpeg exited with ${code}: ${stderr.slice(-600)}`));
    });
  });
}

export interface MediaInfo {
  seconds: number;
  width: number;
  height: number;
}

/** ffmpeg is used for probing too, so no extra binary is needed. */
export async function probeMedia(file: string): Promise<MediaInfo> {
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

  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const size = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(stderr);
  return {
    seconds: duration
      ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
      : 0,
    width: size ? Number(size[1]) : 0,
    height: size ? Number(size[2]) : 0,
  };
}

export async function probeDuration(file: string): Promise<number> {
  return (await probeMedia(file)).seconds;
}

export interface ComposeInput {
  segments: string[];
  aspect: Aspect;
  outputPath: string;
  /**
   * Shot kind per segment, or `null` for a locally animated beat (which already
   * performs its own camera move). Used to give each AI beat a distinct
   * finishing move at compose time.
   */
  kinds?: (BeatKind | null)[];
}

/**
 * Stitch the generated beats into exactly 15 seconds: every beat fills a 5s
 * slot. A clip shorter than that holds its last frame for the rest of the slot
 * instead of being stretched into slow motion; only the ends of the finished
 * video fade.
 */
export async function composeSegments({
  segments,
  aspect,
  outputPath,
  kinds,
}: ComposeInput): Promise<number> {
  const { width, height } = sizeFor(aspect);
  const empty: MediaInfo = { seconds: 0, width: 0, height: 0 };
  const infos = await Promise.all(segments.map((file) => probeMedia(file).catch(() => empty)));
  const workDir = path.dirname(outputPath);
  const normalised: string[] = [];

  // One beat at a time keeps the encoder's frame buffers to a single clip. A
  // single filtergraph holding three inputs needed ~350 MiB and was OOM-killed.
  for (let index = 0; index < segments.length; index += 1) {
    const info = infos[index];
    // Lanczos holds more edge contrast than the default scaler, and a mild
    // unsharp pass only on beats that really are being enlarged puts back some
    // of the detail the model's low-resolution render averaged away.
    const enlarging = info.width > 0 && (info.width < width || info.height < height);
    // A provider clip and a locally animated still start out looking nothing
    // alike: the clips are flat and slightly soft, the still is crisp and
    // untouched. This one grade runs on every beat so the finished video reads
    // as a single piece of footage rather than a patchwork.
    const grade = ',eq=contrast=1.04:saturation=1.06';
    const sharpen = enlarging ? ',unsharp=5:5:0.7:5:5:0' : '';
    // Fade only at the ends of the finished video: a fade on every beat dipped
    // the whole thing to black three times in fifteen seconds.
    const fadeIn = index === 0 ? ',fade=t=in:st=0:d=0.4' : '';
    const fadeOut =
      index === segments.length - 1 ? `,fade=t=out:st=${BEAT_SECONDS - 0.4}:d=0.4` : '';
    // The framing move runs after the clip is normalised to 25 fps, so `on`
    // counts the beats' own frames instead of the provider's 24 fps ones.
    const clipFrames = Math.max(1, Math.min(BEAT_SECONDS * FPS, Math.round(info.seconds * FPS) || BEAT_SECONDS * FPS));
    const kind = kinds?.[index] ?? null;
    const framing = kind
      ? `,${zoomPan(FINISHING[kind] ?? FINISHING.hero, clipFrames, `${width}x${height}`)}`
      : '';
    const beatPath = path.join(workDir, `${path.basename(outputPath, '.mp4')}-beat${index}.mp4`);
    // A short clip holds its last frame for the rest of its slot: tpad clones it
    // so nothing is slowed down to fill the slot. Neither `fps` nor `setpts` may
    // run before tpad — either one silently stops it padding, which is how a 3s
    // beat once shortened the video to 13s. So the padding comes first, then the
    // beat is normalised to 25fps and cut to exactly 125 frames: providers ship
    // 24fps clips, clips with a start offset and clips a few frames short, and
    // trimming by duration let those land on 4.96s and leave the video at 14.92s.
    const filter =
      `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height}` +
      `${grade}${sharpen},tpad=stop_mode=clone:stop_duration=${BEAT_SECONDS},` +
      `fps=${FPS},trim=end_frame=${BEAT_SECONDS * FPS},setpts=N/(${FPS}*TB),setsar=1${framing}${fadeIn}${fadeOut}[v]`;

    await run([
      '-y',
      '-i',
      segments[index],
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
      '18',
      '-pix_fmt',
      'yuv420p',
      '-r',
      String(FPS),
      '-threads',
      '1',
      '-t',
      String(BEAT_SECONDS),
      beatPath,
    ]);
    normalised.push(beatPath);
  }

  const listPath = path.join(workDir, `${path.basename(outputPath, '.mp4')}-concat.txt`);
  await writeFile(listPath, normalised.map((file) => `file '${file}'`).join('\n'));
  try {
    // The beats now share codec, size and frame rate, so the join is a copy.
    await run([
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      outputPath,
    ]);
  } finally {
    await Promise.all(normalised.map((file) => rm(file, { force: true }).catch(() => {})));
    await rm(listPath, { force: true }).catch(() => {});
  }

  return TOTAL_SECONDS;
}

/**
 * Framing for each kind of shot when there is no AI clip to use. The point of
 * these numbers is that the four beats do not look like the same photograph
 * pushed around four times: one pushes in from the full frame, one is a macro
 * crop that drifts across the surface, one pulls back from close in. A beat
 * starting at 1.75 is showing roughly a third of the frame, which reads as a
 * real detail shot next to a full-frame beat.
 */
const MOVES: Record<BeatKind, { from: number; to: number; pan: 'center' | 'across' }> = {
  hero: { from: 1, to: 1.1, pan: 'center' },
  detail: { from: 1.75, to: 1.5, pan: 'across' },
  rotation: { from: 1.14, to: 1, pan: 'across' },
  reveal: { from: 1.32, to: 1, pan: 'center' },
};

/**
 * Finishing move for an AI beat. Every free model answers "camera slowly pushes
 * in" with nearly the same shot, so three beats cut together read as one shot
 * entered three times. A small crop move per beat — a push, a lateral drift, a
 * vertical drift, a pull-back — separates the cuts even when the provider hands
 * back something close to the reference framing.
 */
const FINISHING: Record<BeatKind, { from: number; to: number; pan: 'center' | 'across' | 'rise' }> = {
  hero: { from: 1, to: 1.05, pan: 'center' },
  detail: { from: 1.14, to: 1.2, pan: 'across' },
  rotation: { from: 1.1, to: 1.1, pan: 'rise' },
  reveal: { from: 1.06, to: 1, pan: 'center' },
};

interface Move {
  from: number;
  to: number;
  pan: 'center' | 'across' | 'rise';
}

/**
 * Ease-out so the move settles instead of stopping dead. `on` is the output
 * frame number; zoompan reads z/x/y per frame, and the quotes keep the commas
 * inside min()/pow() from being read as filter separators. `d=1` makes zoompan
 * emit one frame per input frame, and `on` keeps counting across those frames,
 * which is what lets the same expression animate a still and a real clip.
 */
function zoomPan(move: Move, frames: number, size: string): string {
  const last = Math.max(1, frames - 1);
  const ease = `(1-pow(1-min(on/${last},1),2))`;
  const zoom = `${move.from}+(${move.to}-${move.from})*${ease}`;
  const x =
    move.pan === 'center' ? 'iw/2-(iw/zoom/2)' : `(iw-iw/zoom)*(0.12+0.76*${ease})`;
  const y =
    move.pan === 'rise'
      ? `(ih-ih/zoom)*(0.85-0.7*${ease})`
      : 'ih/2-(ih/zoom/2)';
  return `zoompan=z='${zoom}':x='${x}':y='${y}':d=1:s=${size}:fps=${FPS}`;
}

/**
 * One 5s Ken Burns beat over the product photo. Used to fill a single beat that
 * every AI provider declined, so the AI beats that did come back are kept
 * instead of being thrown away for a whole-video fallback.
 */
export async function renderLocalSegment({
  imagePath,
  aspect,
  kind,
  outputPath,
}: {
  imagePath: string;
  aspect: Aspect;
  kind: BeatKind;
  outputPath: string;
}): Promise<number> {
  const { width, height } = sizeFor(aspect);
  // Animating on a 2x canvas and sampling down keeps the move sub-pixel smooth;
  // zooming the delivered size directly visibly steps from frame to frame.
  const w2 = width * 2;
  const h2 = height * 2;
  const frames = BEAT_SECONDS * FPS;
  const move = zoomPan(MOVES[kind] ?? MOVES.hero, frames, `${width}x${height}`);

  // d=1: the looped still already supplies one input frame per output frame, so
  // letting zoompan emit `frames` frames per input would finish the move early
  // and then hold it for the rest of the beat. The beat is composited later, so
  // the end-of-video fades are left to composeSegments.
  const filter =
    `[0:v]scale=${w2}:${h2}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w2}:${h2},` +
    `${move},trim=end_frame=${frames},setpts=N/(${FPS}*TB)[v]`;

  await run([
    '-y',
    '-loop',
    '1',
    '-framerate',
    String(FPS),
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
    '18',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(FPS),
    '-threads',
    '1',
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
