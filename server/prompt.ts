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
      'the camera drifts forward very slowly toward the product on a smooth dolly, the product stays perfectly still and centred',
  },
  {
    kind: 'detail',
    label: 'Texture detail',
    // A macro fly-around makes these models rebuild the product from the wrong
    // side, which bends the silhouette and melts the label. Moving the light
    // instead reveals the same material detail without inventing any geometry.
    motion:
      'a soft specular highlight travels slowly across the surface of the product while the camera eases in slightly, revealing the finish and texture, the product itself does not change shape',
  },
  {
    kind: 'rotation',
    label: 'Cap highlight',
    // Even a few degrees of turn asks the model for a side it has never seen:
    // the black bottle came back amber, carrying a white label that was not on
    // the photo. Raking light across the cap reads as another view without
    // handing the model anything to invent.
    motion:
      'a highlight rakes slowly across the cap and the front face of the product, revealing the material finish, while the product keeps exactly the same front view',
  },
  {
    kind: 'reveal',
    label: 'Slow reveal',
    motion:
      'the camera eases back very slowly to show a little more of the product and the surface it stands on, ending on a clean balanced frame',
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
    `${STYLE_LOOK[style]}.`,
    // Do not name the label, its wording or any text here. Asking these models
    // to "keep the label identical" is read as "render a label", and every free
    // model answered by painting fresh lettering onto the product. Plain
    // "do not move" language holds the shape far better.
    'The product keeps exactly the same framing, silhouette, colour and proportions as the reference photo. It does not move, turn, open or change shape at any point.',
    'Keep the background and the shadows as they are in the reference photo.',
    'The camera movement is slow and small, one continuous shot, photorealistic, crisp sharp focus, high detail.',
  ]
    .filter(Boolean)
    .join(' ');
}
