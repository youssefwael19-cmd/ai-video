import type { StylePreset } from './providers/types.js';

/**
 * Product-video prompts for image-to-video models. Every model in the free pool
 * (Wan 2.2, LTX, Hailuo, Atmee) is conditioned on a single reference photo, so
 * the prompt has to do two jobs: describe one clear motion, and tell the model
 * to leave the product itself alone. Prompts that only describe a camera move
 * let the model invent geometry, which is what made labels drift and logos
 * melt on the softer models.
 */
export type BeatKind = 'hero' | 'detail' | 'rotation' | 'reveal';

export interface BeatPlan {
  kind: BeatKind;
  label: string;
  /** The one motion this shot performs, phrased for an i2v model. */
  motion: string;
  /** Light character for this shot, so the three beats do not share one look. */
  light: string;
}

export const BEAUTY = {
  negative:
    'warped product shape, melted text, distorted logo, invented label, added lettering, changed glass colour, extra objects, hands, watermark, subtitles, flickering, low quality, blurry, camera shake, morphing product, duplicate product, cuts, scene change',
};

/**
 * Look presets. These are deliberately concrete: colour, light direction and
 * surface behaviour reach the model far more reliably than adjectives like
 * "premium".
 */
const STYLE_LOOK: Record<StylePreset, string> = {
  cinematic:
    'moody low-key lighting with a soft key from the upper left, gentle falloff into shadow, shallow depth of field, warm highlights and cool shadows, filmic contrast',
  studio:
    'clean seamless studio backdrop in soft grey, large soft-box light from the front, crisp specular highlight along the product edge, even neutral shadows, catalogue photography',
  bold: 'vivid saturated colour backdrop, hard punchy side light with a strong rim highlight, glossy reflections, high contrast, energetic retail advertising',
  lifestyle:
    'warm natural window light from the side, soft realistic shadows, styled surface with a few props far out of focus, editorial lifestyle photography, gentle falloff',
};

const BEATS: BeatPlan[] = [
  {
    kind: 'hero',
    label: 'Hero push-in',
    motion:
      'the camera dollies slowly forward toward the product, medium framing, the product stays perfectly still and centred',
    light: 'a soft key light from the upper left, warm highlights and a gentle falloff into shadow',
  },
  {
    kind: 'detail',
    label: 'Surface macro',
    // Framing does the work here instead of an orbit. A fly-around makes these
    // models rebuild a side of the product they have never seen, which bent the
    // silhouette and painted a label that was not on the photo; a tight crop of
    // the front face plus a drift keeps every pixel of the real product.
    motion:
      'a tight close-up of the product surface, filling most of the frame, the camera drifting slowly sideways past the front face while a bright highlight sweeps across the finish',
    light: 'a narrow raking light with strong specular glints on the surface and deep contrast',
  },
  {
    kind: 'rotation',
    label: 'Angle rise',
    // The camera moves on the vertical axis only: a tilt never asks the model
    // for a side it has not seen, but it reads as a completely different shot
    // next to the push-in.
    motion:
      'the camera rises slowly from a low angle, tilting upward from the base of the product toward its top, the front face staying in view the whole time',
    light: 'a hard rim of light along one edge, the rest of the product falling into shadow',
  },
  {
    kind: 'reveal',
    label: 'Slow reveal',
    motion:
      'the camera eases back slowly to a slightly wider framing that shows the surface the product stands on, ending on a clean balanced frame',
    light: 'soft even light with a faint warm glow behind the product',
  },
];

const byKind = (kind: BeatKind): BeatPlan => BEATS.find((beat) => beat.kind === kind) ?? BEATS[0];

/** Shot order per look, used to pick which three beats a brief gets. */
const PRIORITY: Record<StylePreset, BeatKind[]> = {
  cinematic: ['hero', 'detail', 'reveal', 'rotation'],
  studio: ['hero', 'rotation', 'detail', 'reveal'],
  bold: ['hero', 'rotation', 'reveal', 'detail'],
  lifestyle: ['detail', 'hero', 'reveal', 'rotation'],
};

/**
 * Choose the three shots for a brief. The brief only *adds* a shot type — the
 * list is then topped up from the style's own priority order, so a brief that
 * mentions nothing in particular still gets three distinct beats and the render
 * is always the advertised 15 seconds. (An earlier version returned two beats
 * for some briefs, which quietly produced a 10 second video.)
 */
export function planBeats(brief: string, style: StylePreset): BeatPlan[] {
  const text = brief.toLowerCase();
  const picked = new Set<BeatKind>(['hero']);

  if (/detail|texture|close[- ]?up|macro|material|fabric|stitch|emboss|engrav/.test(text)) {
    picked.add('detail');
  }
  if (/rotat|spin|360|turn|all sides|every angle|angles/.test(text)) {
    picked.add('rotation');
  }
  if (/reveal|wide|room|scene|setting|environment|lifestyle|table|shelf|kitchen|bathroom|gift/.test(text)) {
    picked.add('reveal');
  }

  for (const kind of PRIORITY[style]) {
    if (picked.size >= 3) break;
    picked.add(kind);
  }

  return PRIORITY[style].filter((kind) => picked.has(kind)).slice(0, 3).map(byKind);
}

/**
 * Build the prompt for one beat. Kept short on purpose: Wan and LTX both weight
 * the front of the prompt most, and a wall of text makes them wander.
 */
export function buildBeatPrompt(beat: BeatPlan, brief: string, style: StylePreset): string {
  const subject = brief.trim() ? `The subject is ${brief.trim()}.` : '';
  return [
    `${beat.motion}.`,
    subject,
    `${STYLE_LOOK[style]}, ${beat.light}.`,
    // Do not name the label, its wording or any text here. Asking these models
    // to "keep the label identical" is read as "render a label", and every free
    // model answered by painting fresh lettering onto the product. Plain
    // "do not move" language holds the shape far better. Framing is deliberately
    // left out of this guard: each beat frames the product differently, and
    // calling for "the same framing" lashed all three beats to one shot.
    'The product keeps exactly the same silhouette, colour, proportions and details as the reference photo. It does not move, turn, open or change shape at any point.',
    'Keep the background and the shadows as they are in the reference photo.',
    'One continuous shot, slow smooth camera movement, photorealistic, crisp sharp focus, high detail.',
  ]
    .filter(Boolean)
    .join(' ');
}
