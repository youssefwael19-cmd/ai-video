export type Aspect = '9:16' | '1:1' | '16:9';
export type StylePreset = 'cinematic' | 'studio' | 'bold' | 'lifestyle';

export interface ProviderSnapshot {
  id: string;
  label: string;
  service: string;
  model: string;
  maxSeconds: number;
  configured: boolean;
  status: 'ready' | 'unconfigured' | 'cooling' | 'flaky' | 'unknown';
  cooldownSeconds: number;
  attempts: number;
  successes: number;
  failures: number;
  avgMs: number | null;
  lastError: string | null;
  requires: { env: string; signupUrl: string; note: string };
}

export interface AppState {
  providers: ProviderSnapshot[];
  configured: number;
  localFallback: boolean;
  totalSeconds: number;
  beats: number;
}

export interface KeySlotView {
  field: string;
  env: string;
  label: string;
  service: string;
  signupUrl: string;
  note: string;
  configured: boolean;
  preview: string | null;
  source: 'saved' | 'env' | 'none';
}

export interface SettingsView {
  passwordRequired: boolean;
  slots: KeySlotView[];
}

export type KeyTestStatus =
  | 'works'
  | 'not-needed'
  | 'missing'
  | 'invalid'
  | 'no-credits'
  | 'limited'
  | 'unreachable';

export interface KeyTestResult {
  field: string;
  status: KeyTestStatus;
  ok: boolean;
  message: string;
  detail: string | null;
  ms: number;
  testedValue: 'typed' | 'saved';
}

export interface SegmentView {
  index: number;
  label: string;
  prompt: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'fallback';
  providerId?: string;
  providerLabel?: string;
  model?: string;
  /** Size the clip actually came back at, e.g. ``720x1280``. */
  resolution?: string;
  attempts: number;
  error?: string;
}

export interface JobView {
  id: string;
  status: 'queued' | 'running' | 'composing' | 'done' | 'error';
  progress: number;
  aspect: Aspect;
  style: StylePreset;
  brief: string;
  imageUrl: string;
  videoUrl?: string;
  downloadUrl?: string;
  durationSeconds: number;
  usedFallback: boolean;
  segments: SegmentView[];
  log: { at: string; text: string; kind: 'info' | 'ok' | 'warn' | 'error' }[];
  error?: string;
  createdAt: number;
  finishedAt?: number;
}
