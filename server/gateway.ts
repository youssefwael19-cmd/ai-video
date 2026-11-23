import { buildProviderPool } from './providers/registry.js';
import { resetHfSpaceHealth } from './providers/hfspace.js';
import { ProviderError, type MotionRequest, type Provider, type ProviderOutput } from './providers/types.js';

export interface Attempt {
  providerId: string;
  label: string;
  service: string;
  ok: boolean;
  ms: number;
  error?: string;
  /** True when the provider was not called at all because it is cooling down. */
  skipped?: boolean;
  cooldownSeconds?: number;
}

interface ProviderState {
  attempts: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  totalMs: number;
  cooldownUntil: number;
  lastError?: string;
  lastUsedAt?: number;
}

const state = new Map<string, ProviderState>();

function getState(id: string): ProviderState {
  let s = state.get(id);
  if (!s) {
    s = { attempts: 0, successes: 0, failures: 0, consecutiveFailures: 0, totalMs: 0, cooldownUntil: 0 };
    state.set(id, s);
  }
  return s;
}

function cooldownFor(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  const seconds = Math.min(15 * 60, 45 * Math.pow(3, consecutiveFailures - 1));
  return Date.now() + seconds * 1000;
}

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
  requires: Provider['requires'];
}

export function snapshotProviders(): ProviderSnapshot[] {
  const now = Date.now();
  return buildProviderPool().map((p) => {
    const s = getState(p.id);
    const cooling = s.cooldownUntil > now;
    const configured = p.isConfigured();
    const status: ProviderSnapshot['status'] = !configured
      ? 'unconfigured'
      : cooling
        ? 'cooling'
        : s.consecutiveFailures > 0
          ? 'flaky'
          : s.attempts > 0
            ? 'ready'
            : 'unknown';
    return {
      id: p.id,
      label: p.label,
      service: p.service,
      model: p.model,
      maxSeconds: p.maxSeconds,
      configured,
      status,
      cooldownSeconds: cooling ? Math.ceil((s.cooldownUntil - now) / 1000) : 0,
      attempts: s.attempts,
      successes: s.successes,
      failures: s.failures,
      avgMs: s.successes > 0 ? Math.round(s.totalMs / s.successes) : null,
      lastError: s.lastError ?? null,
      requires: p.requires,
    };
  });
}

export function configuredProviderCount(): number {
  return buildProviderPool().filter((p) => p.isConfigured()).length;
}

/**
 * Try every configured provider that is not cooling down, in pool order. A
 * provider that recently failed is skipped outright — it is never called again
 * until its cooldown expires. When the whole pool is cooling, the request fails
 * fast with the time until the soonest provider recovers, so the caller can fall
 * back instead of hanging on providers that are known to be down.
 */
export async function generateBeat(
  req: MotionRequest,
  onAttempt: (attempt: Attempt) => void,
): Promise<{ output: ProviderOutput; provider: Provider; attempts: Attempt[] }> {
  const pool = buildProviderPool().filter((p) => p.isConfigured());
  const attempts: Attempt[] = [];

  if (pool.length === 0) {
    throw new ProviderError('No providers configured', { retryable: false });
  }

  const now = Date.now();
  const ready: Provider[] = [];
  let soonestReady = Number.POSITIVE_INFINITY;

  for (const provider of pool) {
    const s = getState(provider.id);
    if (s.cooldownUntil <= now) {
      ready.push(provider);
      continue;
    }

    const cooldownSeconds = Math.ceil((s.cooldownUntil - now) / 1000);
    soonestReady = Math.min(soonestReady, s.cooldownUntil);
    const skipped: Attempt = {
      providerId: provider.id,
      label: provider.label,
      service: provider.service,
      ok: false,
      ms: 0,
      skipped: true,
      cooldownSeconds,
      error: `cooling down for ${cooldownSeconds}s after: ${s.lastError ?? 'recent failure'}`,
    };
    attempts.push(skipped);
    onAttempt(skipped);
  }

  if (ready.length === 0) {
    const seconds = Math.max(1, Math.ceil((soonestReady - now) / 1000));
    throw new ProviderError(
      `All ${pool.length} configured providers are cooling down — next one ready in ${seconds}s`,
      { retryable: true, status: 429 },
    );
  }

  let lastError: unknown;

  for (const provider of ready) {
    const s = getState(provider.id);
    const attempt: Attempt = {
      providerId: provider.id,
      label: provider.label,
      service: provider.service,
      ok: false,
      ms: 0,
    };
    const started = Date.now();
    s.attempts += 1;
    s.lastUsedAt = started;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 9 * 60_000);
      let output: ProviderOutput;
      try {
        output = await provider.generate({ ...req }, controller.signal);
      } finally {
        clearTimeout(timer);
      }
      const ms = Date.now() - started;
      s.successes += 1;
      s.totalMs += ms;
      s.consecutiveFailures = 0;
      s.cooldownUntil = 0;
      s.lastError = undefined;

      attempt.ok = true;
      attempt.ms = ms;
      attempts.push(attempt);
      onAttempt(attempt);
      return { output, provider, attempts };
    } catch (err) {
      const ms = Date.now() - started;
      const message = err instanceof Error ? err.message : String(err);
      s.failures += 1;
      s.consecutiveFailures += 1;
      s.lastError = message;
      s.cooldownUntil = cooldownFor(s.consecutiveFailures);

      attempt.ms = ms;
      attempt.error = message;
      attempts.push(attempt);
      onAttempt(attempt);
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new ProviderError('Every provider declined the request');
}

/** Reset the health board (exposed through the API so a user can recover quickly). */
export function resetProviderHealth(): void {
  state.clear();
  resetHfSpaceHealth();
}
