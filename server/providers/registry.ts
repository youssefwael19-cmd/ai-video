import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { createHuggingFaceProviders } from './hfspace.js';
import { createMagicHourProviders } from './magichour.js';
import { createNovitaProviders } from './novita.js';
import type { Provider } from './types.js';

let counter = 0;

/**
 * Every free provider the app knows about, in quality-first order. Configured
 * providers are always tried before unconfigured ones (which are skipped).
 */
export function buildProviderPool(): Provider[] {
  return [
    ...createHuggingFaceProviders(config.keys.huggingFace, { next: nextSegmentName }),
    ...createNovitaProviders(config.keys.novita),
    ...createMagicHourProviders(config.keys.magicHour),
  ];
}

export function nextSegmentName(): string {
  counter += 1;
  return `segment-${Date.now()}-${counter}-${randomUUID().slice(0, 6)}.mp4`;
}
