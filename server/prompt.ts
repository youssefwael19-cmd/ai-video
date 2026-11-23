import type { StylePreset } from './providers/types.js';

export interface BeatPlan {
  key: 'hero' | 'detail' | 'rotation';
  label: string;
  motion: string;
}

export const BEAUTY = {
  negative:
    'warped product shape, melted text, distorted logo, extra objects, hands, watermark, subtitles, flickering, low quality, blurry',
};

const STYLE_LOOK: Record<StylePreset, string> = {
  cinematic:
    'moody cinematic lighting, shallow depth of field, gentle film grain, premium commercial feel',
  studio:
    'clean seamless studio backdrop, large soft box lighting, crisp product photography, neutral shadows',
  bold: 'vivid saturated backdrop, punchy contrast, energetic commercial lighting, high fashion retail feel',
  lifestyle:
    'warm natural window light, styled home set, soft shadows, editorial lifestyle photography',
};

const BEATS: BeatPlan[] = [
  {
    key: 'hero',
    label: 'Hero push-in',
    motion:
      'the camera pushes in slowly toward the product, subtle parallax, product perfectly still and centered',
  },
  {
    key: 'detail',
    label: 'Detail glide',
    motion:
      'a smooth macro glide across the surface of the product revealing material texture and edges, shallow focus',
  },
  {
    key: 'rotation',
    label: 'Hero rotation',
    motion:
      'the product rotates slowly on a studio pedestal, light sweeping across it, background softly blurred',
  },
];

export function planBeats(_brief: string, _style: StylePreset): BeatPlan[] {
  return BEATS;
}

export function buildBeatPrompt(beat: BeatPlan, brief: string, style: StylePreset): string {
  const description = brief.trim() ? `The product is: ${brief.trim()}.` : '';
  return [
    `${beat.motion}.`,
    description,
    STYLE_LOOK[style] + '.',
    'Keep the product identical to the reference photo — same shape, colour, label and proportions.',
    'Smooth steady motion, no cuts, no scene changes.',
  ]
    .filter(Boolean)
    .join(' ');
}
