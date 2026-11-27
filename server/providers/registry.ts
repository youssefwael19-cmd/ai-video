import { config } from '../config.js';
import { createAgnesProviders } from './agnes.js';
import { createAtmeeProviders } from './atmee.js';
import { createHuggingFaceProviders } from './hfspace.js';
import { createMagicHourProviders } from './magichour.js';
import { createNovitaProviders } from './novita.js';
import { createReplicateProviders } from './replicate.js';
import type { Provider } from './types.js';

/**
 * Free providers ordered by quality-to-cost ratio. The pool is never empty
 * because Hugging Face Spaces needs no key. Prioritize Atmee for best results
 * when credits are available, then Novita/Magic Hour as fallbacks.
 */
export function buildProviderPool(): Provider[] {
  return [
    ...createAtmeeProviders(config.keys.atmee),
    ...createNovitaProviders(config.keys.novita),
    ...createMagicHourProviders(config.keys.magicHour),
    // Each of the three below draws on its own separate free allowance, so a
    // spent quota on one cannot refuse the beats that a healthy one can render.
    ...createReplicateProviders(config.keys.replicate),
    ...createAgnesProviders(config.keys.agnes),
    ...createHuggingFaceProviders(config.keys.huggingFace),
  ];
}
