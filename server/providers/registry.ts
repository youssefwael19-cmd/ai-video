import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { createAgnesProviders } from './agnes.js';
import { createAtmeeProviders } from './atmee.js';
import { createHuggingFaceProviders } from './hfspace.js';
import { createMagicHourProviders } from './magichour.js';
import { createNovitaProviders } from './novita.js';
import { createReplicateProviders } from './replicate.js';
import type { Provider } from './types.js';

let counter = 0;

/**
 * Every free provider the app knows about, in quality-first order. Configured
 * providers are always tried before unconfigured ones (which are skipped).
 */
export function buildProviderPool(): Provider[] {
  return [
    // Hugging Face Spaces needs no key at all, so the pool always has at least
    // one working provider; a HUGGING_FACE_TOKEN is optional.
    ...createHuggingFaceProviders(config.keys.huggingFace, { next: nextSegmentName }),
    ...createNovitaProviders(config.keys.novita),
    ...createMagicHourProviders(config.keys.magicHour),
    // Each of the three below draws on its own separate free allowance, so a
    // spent quota on one cannot refuse the beats that a healthy one can render.
    ...createReplicateProviders(config.keys.replicate),
    ...createAgnesProviders(config.keys.agnes),
    ...createAtmeeProviders(config.keys.atmee),
  ];
}

export function nextSegmentName(): string {
  counter += 1;
  return `segment-${Date.now()}-${counter}-${randomUUID().slice(0, 6)}.mp4`;
}
