import { config } from '../config.js';
import { createAgnesProviders } from './agnes.js';
import { createAtmeeProviders } from './atmee.js';
import { createHuggingFaceProviders } from './hfspace.js';
import { createMagicHourProviders } from './magichour.js';
import { createNovitaProviders } from './novita.js';
import { createReplicateProviders } from './replicate.js';
import type { Provider } from './types.js';

/**
 * Every free provider the app knows about, in quality-first order. Unconfigured
 * providers are skipped, but Hugging Face Spaces needs no key at all, so this
 * pool is never empty.
 */
export function buildProviderPool(): Provider[] {
  return [
    ...createHuggingFaceProviders(config.keys.huggingFace),
    ...createNovitaProviders(config.keys.novita),
    ...createMagicHourProviders(config.keys.magicHour),
    // Each of the three below draws on its own separate free allowance, so a
    // spent quota on one cannot refuse the beats that a healthy one can render.
    ...createReplicateProviders(config.keys.replicate),
    ...createAgnesProviders(config.keys.agnes),
    ...createAtmeeProviders(config.keys.atmee),
  ];
}
