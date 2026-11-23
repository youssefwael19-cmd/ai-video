export type Aspect = '9:16' | '1:1' | '16:9';

export type StylePreset = 'cinematic' | 'studio' | 'bold' | 'lifestyle';

export interface MotionRequest {
  /** Local file path of the uploaded product photo. */
  imagePath: string;
  imageMime: string;
  /** Motion instruction for this beat, already merged with the user brief. */
  prompt: string;
  negativePrompt: string;
  /** Seconds requested for this beat. */
  seconds: number;
  aspect: Aspect;
  seed: number;
  /** Lazily resolved public URL of the image (providers that need a URL). */
  getPublicImageUrl: () => Promise<string>;
}

export interface ProviderOutput {
  /** Local path of the downloaded mp4. */
  videoPath: string;
  /** Provider-reported duration in seconds, when known. */
  durationSeconds?: number;
}

export interface Provider {
  id: string;
  label: string;
  /** Which free service backs this provider. */
  service: 'Hugging Face Spaces' | 'Novita AI' | 'Magic Hour' | 'Replicate' | 'Agnes AI' | 'Atmee';
  model: string;
  /** True when the provider is ready to call (true for providers needing no key). */
  isConfigured: () => boolean;
  /** What the provider needs, shown in the UI when it is not configured. */
  requires: { env: string; signupUrl: string; note: string };
  /** Longest single generation the provider can return. */
  maxSeconds: number;
  generate: (req: MotionRequest, signal: AbortSignal) => Promise<ProviderOutput>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    /** Network/5xx/429 issues are worth retrying on another provider. */
    readonly detail: { status?: number; retryable: boolean; raw?: string } = { retryable: true },
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
