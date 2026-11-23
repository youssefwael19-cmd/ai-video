import 'dotenv/config';
import path from 'node:path';

const root = process.cwd();

export const config = {
  port: Number(process.env.PORT ?? 3000),
  root,
  dataDir: path.join(root, 'data'),
  uploadDir: path.join(root, 'data', 'uploads'),
  segmentDir: path.join(root, 'data', 'segments'),
  renderDir: path.join(root, 'data', 'renders'),

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

/** A provider is "available" when its key is present. */
export function hasKey(name: keyof typeof config.keys): boolean {
  return config.keys[name].length > 0;
}
