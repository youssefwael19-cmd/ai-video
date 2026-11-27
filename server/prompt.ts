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
    'moody cinematic lighting, shallow depth of field, crisp focus, premium commercial feel, smooth camera moves, product reveals with intention',
  studio:
    'clean seamless studio backdrop, large soft box lighting, crisp product photography, neutral shadows, product stays perfectly centered',
  bold: 'vivid saturated backdrop, punchy contrast, energetic commercial lighting, high fashion retail feel, dynamic camera moves',
  lifestyle:
    'warm natural window light, styled home set, soft shadows, editorial lifestyle photography, gentle product panning',
};

/** Smart beat planning: picks the best motion for the product type and brief. */
export interface BeatPlan {
  key: 'hero' | 'detail' | 'rotation';
  label: string;
  motion: string;
}

export const BEATS: BeatPlan[] = [
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

/** Select beats based on the brief and style - makes the video smarter about what to show. */
export function planBeats(brief: string, style: StylePreset): BeatPlan[] {
  const briefL = brief.trim().toLowerCase();
  // If brief mentions specific features, create detail-oriented beats
  if (/\|\b(material|texture|detail|surface|close-up|zoom)\b/.test(briefL)) {
    return [BEATS[1], BEATS[0]]; // detail glide first, then hero push-in
  }
  // If brief mentions rotation or 360 view
  if (/\|\b(rotate|turn|360|reveal all|all sides)\b/.test(briefL)) {
    return [BEATS[0], BEATS[2]]; // hero push-in, then hero rotation
  }
  // Style-specific ordering
  if (style === 'bold') {
    return [BEATS[0], BEATS[2], BEATS[1]]; // hero, rotation, detail for maximum impact
  }
  if (style === 'lifestyle') {
    return [BEATS[1], BEATS[0]]; // detail, hero for storytelling
  }
  // Default: hero, detail, rotation
  return [BEATS[0], BEATS[1], BEATS[2]];
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
