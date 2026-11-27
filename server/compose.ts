import { spawn } from 'node:child_process';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { config } from './config.js';
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
}

/**
 * Stitch the generated beats into exactly 15 seconds: every beat fills a 5s
 * slot. A clip shorter than that holds its last frame for the rest of the slot
 * instead of being stretched into slow motion; only the ends of the finished
 * video fade.
 */
export async function composeSegments({ segments, aspect, outputPath }: ComposeInput): Promise<number> {
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
    const sharpen = enlarging ? ',unsharp=5:5:0.7:5:5:0' : '';
    // Fade only at the ends of the finished video: a fade on every beat dipped
    // the whole thing to black three times in fifteen seconds.
    const fadeIn = index === 0 ? ',fade=t=in:st=0:d=0.4' : '';
    const fadeOut =
      index === segments.length - 1 ? `,fade=t=out:st=${BEAT_SECONDS - 0.4}:d=0.4` : '';
    const beatPath = path.join(workDir, `${path.basename(outputPath, '.mp4')}-beat${index}.mp4`);
    // A short clip holds its last frame for the rest of its slot: tpad clones it
    // and the trim keeps exactly 5s, so nothing is slowed down to fill the slot.
    // Neither `fps` nor `setpts` may run before tpad — either one silently stops
    // it padding, which is how a 3s beat once shortened the video to 13s. The
    // 25fps conversion is done by the encoder's `-r` instead.
    const filter =
      `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height}` +
      `${sharpen},tpad=stop_mode=clone:stop_duration=${BEAT_SECONDS},` +
      `trim=duration=${BEAT_SECONDS},setpts=PTS-STARTPTS,setsar=1${fadeIn}${fadeOut}[v]`;

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
  const frames = BEAT_SECONDS * FPS;
  const moves = localMotion(frames);
  const move = moves[index % moves.length];

  // d=1: the looped still already supplies one input frame per output frame, so
  // letting zoompan emit `frames` frames per input would finish the move early
  // and then hold it for the rest of the beat. The beat is composited later, so
  // the end-of-video fades are left to composeSegments.
  const filter =
    `[0:v]scale=${w2}:${h2}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w2}:${h2},` +
    `${move}:d=1:s=${width}x${height}:fps=${FPS},` +
    `trim=duration=${BEAT_SECONDS},setpts=PTS-STARTPTS[v]`;

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

/** Smart local fallback: picks motion based on aspect and beat index for variety. */
const smartLocalMotion = (aspect: Aspect, index: number): string[] => {
  // Add variety per beat index - different starting positions and speeds
  if (aspect === '9:16') {
    if (index === 0) {
      return [
        `zoompan=z='1.02+0.0016*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
        `zoompan=z='1.15+0.0012*on':x='iw/4-(iw/zoom/4)':y='ih/4-(ih/zoom/4)'`,
        `zoompan=z='1.28-0.0018*on':x='3iw/4-(3iw/zoom/2)':y='3ih/4-(3ih/zoom/2)'`,
      ];
    } else if (index === 1) {
      return [
        `zoompan=z='1.02+0.0016*on':x='3iw/4-(3iw/zoom/2)':y='3ih/4-(3ih/zoom/2)'`,
        `zoompan=z='1.15+0.0012*on':x='iw/4-(iw/zoom/4)':y='ih/4-(ih/zoom/4)'`,
        `zoompan=z='1.28-0.0018*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
      ];
    }
  }
  // Default fallback - same as before for other aspects
  return localMotion(BEAT_SECONDS * FPS);
};


export function renderPath
(jobId: string): string {
  return path.join(config.renderDir, `${jobId}.mp4`);
}
