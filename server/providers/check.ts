import type { KeyField } from '../settings.js';

/**
 * Verify a provider key with a read-only call: no video is generated and no
 * credits are spent. Each provider exposes a different "who am I / how much is
 * left" endpoint, so every check below is provider-specific and classified into
 * the same small result shape the Settings tab renders.
 */

export type KeyTestStatus =
  | 'works'
  | 'not-needed'
  | 'missing'
  | 'invalid'
  | 'no-credits'
  | 'limited'
  | 'unreachable';

export interface KeyTestResult {
  field: KeyField;
  status: KeyTestStatus;
  /** True when the key is usable (working, optional, or merely out of credit). */
  ok: boolean;
  message: string;
  detail: string | null;
  ms: number;
}

type Outcome = Omit<KeyTestResult, 'field' | 'ms'>;

const TIMEOUT_MS = 15_000;

async function probe(url: string, headers: Record<string, string>) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = (await res.text().catch(() => '')).slice(0, 1000);
  return { status: res.status, body };
}

function json(body: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Pull a short human reason out of the many error shapes the providers use. */
function reasonOf(body: string): string {
  const parsed = json(body);
  const raw = parsed.message ?? parsed.detail ?? parsed.reason ?? parsed.error;
  if (typeof raw === 'string') return raw.slice(0, 160);
  if (raw && typeof raw === 'object') {
    const message = (raw as Record<string, unknown>).message;
    if (typeof message === 'string') return message.slice(0, 160);
  }
  return body.replace(/\s+/g, ' ').trim().slice(0, 160);
}

/** 401/403 on the documented account endpoint means the key itself is refused. */
function refused(service: string, status: number, body: string): Outcome {
  const reason = reasonOf(body);
  return {
    status: 'invalid',
    ok: false,
    message: `${service} rejected this key (HTTP ${status})${reason ? `: ${reason}` : ''}`,
    detail: null,
  };
}

function oddAnswer(service: string, status: number, body: string): Outcome {
  if (status === 429) {
    return {
      status: 'limited',
      ok: true,
      message: `${service} is rate-limiting this key right now (HTTP 429) — the key itself is accepted.`,
      detail: null,
    };
  }
  const reason = reasonOf(body);
  return {
    status: 'unreachable',
    ok: false,
    message: `${service} answered HTTP ${status} instead of accepting the key${reason ? `: ${reason}` : ''}`,
    detail: null,
  };
}

async function huggingFace(key: string): Promise<Outcome> {
  if (!key) {
    return {
      status: 'not-needed',
      ok: true,
      message: 'No key needed — the Spaces render anonymously on a shared daily GPU quota.',
      detail: 'A token moves runs onto your own, larger quota.',
    };
  }
  const { status, body } = await probe('https://huggingface.co/api/whoami-v2', {
    Authorization: `Bearer ${key}`,
  });
  if (status === 200) {
    const name = text(json(body).name);
    return { status: 'works', ok: true, message: `Token works${name ? ` — signed in as ${name}` : ''}`, detail: null };
  }
  if (status === 401 || status === 403) return refused('Hugging Face', status, body);
  return oddAnswer('Hugging Face', status, body);
}

async function novita(key: string): Promise<Outcome> {
  const { status, body } = await probe('https://api.novita.ai/v3/user', {
    Authorization: `Bearer ${key}`,
  });
  if (status === 200) {
    const raw = json(body).credit_balance;
    const credits = Number(raw);
    const balance = Number.isFinite(credits) ? ` — credit balance $${(credits / 10000).toFixed(2)}` : '';
    return { status: 'works', ok: true, message: `Key works${balance}`, detail: null };
  }
  if (status === 401 || status === 403) return refused('Novita AI', status, body);
  if (status === 402) {
    return {
      status: 'no-credits',
      ok: true,
      message: 'Key is valid, but the Novita account has no credit left.',
      detail: null,
    };
  }
  return oddAnswer('Novita AI', status, body);
}

async function magicHour(key: string): Promise<Outcome> {
  const { status, body } = await probe('https://api.magichour.ai/v1/account', {
    Authorization: `Bearer ${key}`,
    accept: 'application/json',
  });
  if (status === 200) {
    const parsed = json(body);
    const who = text(parsed.email) || text(parsed.name);
    return { status: 'works', ok: true, message: `Key works${who ? ` — ${who}` : ''}`, detail: null };
  }
  if (status === 401 || status === 403) return refused('Magic Hour', status, body);
  if (status === 402) {
    return {
      status: 'no-credits',
      ok: true,
      message: 'Key is valid, but the Magic Hour account has no credit left.',
      detail: null,
    };
  }
  return oddAnswer('Magic Hour', status, body);
}

async function replicate(key: string): Promise<Outcome> {
  const { status, body } = await probe('https://api.replicate.com/v1/account', {
    Authorization: `Bearer ${key}`,
  });
  if (status === 200) {
    const parsed = json(body);
    const who = text(parsed.username) || text(parsed.name);
    return { status: 'works', ok: true, message: `Key works${who ? ` — @${who.replace(/^@/, '')}` : ''}`, detail: null };
  }
  if (status === 401 || status === 403) return refused('Replicate', status, body);
  return oddAnswer('Replicate', status, body);
}

async function agnes(key: string): Promise<Outcome> {
  // The model list is public, so it cannot tell a good key from a bad one.
  // Reading a task that does not exist exercises authentication without
  // creating (or billing) a video.
  const url =
    'https://apihub.agnes-ai.com/agnesapi?video_id=' +
    `${encodeURIComponent('00000000-0000-0000-0000-000000000000')}&model_name=agnes-video-2.5-flash`;
  const { status, body } = await probe(url, { Authorization: `Bearer ${key}` });
  if (status === 401 || status === 403) return refused('Agnes AI', status, body);
  if (status === 200 || status === 400 || status === 404 || status === 422) {
    return {
      status: 'works',
      ok: true,
      message: 'Key accepted — the video API answered without an auth error.',
      detail: 'Read-only check; no video was generated.',
    };
  }
  return oddAnswer('Agnes AI', status, body);
}

async function atmee(key: string): Promise<Outcome> {
  const { status, body } = await probe('https://api.atmanity.us/v1/api_keys/current', {
    'X-Api-Key': key,
  });
  if (status === 200) {
    const parsed = json(body);
    const name = text(parsed.name);
    const scopes = Array.isArray(parsed.scopes)
      ? parsed.scopes.filter((scope): scope is string => typeof scope === 'string')
      : [];
    const suffix = name ? ` — ${name}` : '';
    const scopeNote = scopes.length ? ` (${scopes.length} scope${scopes.length === 1 ? '' : 's'})` : '';
    return { status: 'works', ok: true, message: `Key works${suffix}${scopeNote}`, detail: null };
  }
  if (status === 403 && text(json(body).error) === 'insufficient_scope') {
    return {
      status: 'limited',
      ok: true,
      message: 'Key is valid, but it is missing the scope the video endpoint needs.',
      detail: 'Create a key with the generation scope.',
    };
  }
  if (status === 401 || status === 403) return refused('Atmee', status, body);
  if (status === 402) {
    return {
      status: 'no-credits',
      ok: true,
      message: 'Key is valid, but the Atmee account has no credit left.',
      detail: null,
    };
  }
  return oddAnswer('Atmee', status, body);
}

const CHECKS: Record<KeyField, (key: string) => Promise<Outcome>> = {
  huggingFace,
  novita,
  magicHour,
  replicate,
  agnes,
  atmee,
};

/**
 * `key` is the value to check: whatever is typed in the Settings row, or the
 * saved/env key when the field is left empty. The value is never stored or
 * echoed back.
 */
export async function testKey(field: KeyField, key: string): Promise<KeyTestResult> {
  const started = Date.now();
  const trimmed = key.trim();

  if (!trimmed && field !== 'huggingFace') {
    return {
      field,
      status: 'missing',
      ok: false,
      message: 'No key to test — paste one, or save it first.',
      detail: null,
      ms: Date.now() - started,
    };
  }

  try {
    const outcome = await CHECKS[field](trimmed);
    return { field, ...outcome, ms: Date.now() - started };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      field,
      status: 'unreachable',
      ok: false,
      message: `Could not reach the provider: ${reason}`,
      detail: 'The key was not checked. Try again in a moment.',
      ms: Date.now() - started,
    };
  }
}
