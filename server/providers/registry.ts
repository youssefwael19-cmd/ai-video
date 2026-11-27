import { config } from '../config.js';
import { createAgnesProviders } from './agnes.js';
import { createAtmeeProviders } from './atmee.js';
import { createHuggingFaceProviders } from './hfspace.js';
import { createMagicHourProviders } from './magichour.js';
import { createNovitaProviders } from './novita.js';
import { createReplicateProviders } from './replicate.js';
import type { Provider } from './types.js';

/**
 * Every provider the app can use is a free tier — there is no paid path, and
 * Hugging Face Spaces needs no key at all, so the pool is never empty.
 *
 * The order is by delivered quality, because the first provider that answers
 * wins the beat for the whole video:
 *
 *   1. Atmee       720p clips, free-plan credits, highest resolution we can get
 *   2. HF Spaces   keyless; Wan 2.2 14B resolves real product detail
 *   3. Agnes       720P, free trial model (queue is often full)
 *   4. Novita      720P Wan 2.2, free signup credit
 *   5. Replicate   Hailuo quality, a handful of free test runs
 *   6. Magic Hour  480p only on the free tier, so it is the last resort — an
 *                  upscaled 480p beat is exactly what made the video look soft
 *                  before everything else was moved ahead of it
 */
export function buildProviderPool(): Provider[] {
  return [
    ...createAtmeeProviders(config.keys.atmee),
    ...createHuggingFaceProviders(config.keys.huggingFace),
    ...createAgnesProviders(config.keys.agnes),
    ...createNovitaProviders(config.keys.novita),
    ...createReplicateProviders(config.keys.replicate),
    ...createMagicHourProviders(config.keys.magicHour),
  ];
}
