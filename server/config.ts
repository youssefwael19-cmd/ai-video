import 'dotenv/config';
import path from 'node:path';

const root = process.cwd();

/**
 * DATA_DIR points at a mounted volume on hosts whose own disk is wiped on every
 * restart, so finished renders and uploaded photos survive a redeploy.
 */
const dataDir = path.resolve(process.env.DATA_DIR?.trim() || path.join(root, 'data'));

export const config = {
  port: Number(process.env.PORT ?? 3000),
  root,
  dataDir,
  uploadDir: path.join(dataDir, 'uploads'),
  segmentDir: path.join(dataDir, 'segments'),
  renderDir: path.join(dataDir, 'renders'),

  /** Empty strings mean the provider is simply not configured. */
  keys: {
    huggingFace: (process.env.HUGGING_FACE_TOKEN ?? '').trim(),
    novita: (process.env.NOVITA_API_KEY ?? '').trim(),
    magicHour: (process.env.MAGIC_HOUR_API_KEY ?? '').trim(),
    replicate: (process.env.REPLICATE_API_TOKEN ?? '').trim(),
    agnes: (process.env.AGNES_API_KEY ?? '').trim(),
    atmee: (process.env.ATMEE_API_KEY ?? '').trim(),
  },

  enableLocalFallback: (process.env.ENABLE_LOCAL_FALLBACK ?? 'true') !== 'false',
  publicImageUrlOverride: (process.env.PUBLIC_IMAGE_URL_OVERRIDE ?? '').trim(),
};
