import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

/**
 * Keys pasted in the app's Settings tab live in settings.json inside DATA_DIR,
 * next to the renders, so they survive a restart or redeploy and do not need a
 * shell on the host. A value saved here overrides the matching env var; saving
 * an empty value is how a key is removed (and it stays removed across restarts).
 */

export type KeyField = keyof typeof config.keys;

export interface KeySlot {
  field: KeyField;
  env: string;
  label: string;
  service: string;
  signupUrl: string;
  note: string;
}

export interface KeySlotView extends KeySlot {
  configured: boolean;
  /** Last 4 characters only — the stored value itself is never sent back. */
  preview: string | null;
  source: 'saved' | 'env' | 'none';
}

export const KEY_SLOTS: KeySlot[] = [
  {
    field: 'huggingFace',
    env: 'HUGGING_FACE_TOKEN',
    label: 'Hugging Face token',
    service: 'Hugging Face Spaces',
    signupUrl: 'https://huggingface.co/settings/tokens',
    note: 'Optional — the four Spaces already render anonymously on a shared daily GPU quota. A token moves the runs onto your own quota.',
  },
  {
    field: 'novita',
    env: 'NOVITA_API_KEY',
    label: 'Novita AI key',
    service: 'Novita AI',
    signupUrl: 'https://novita.ai/settings/key-management',
    note: 'Free account credit on signup · Wan 2.2 image-to-video.',
  },
  {
    field: 'magicHour',
    env: 'MAGIC_HOUR_API_KEY',
    label: 'Magic Hour key',
    service: 'Magic Hour',
    signupUrl: 'https://magichour.ai/developer',
    note: 'Free tier credits · image-to-video.',
  },
  {
    field: 'replicate',
    env: 'REPLICATE_API_TOKEN',
    label: 'Replicate token',
    service: 'Replicate',
    signupUrl: 'https://replicate.com/collections/try-for-free',
    note: 'Free test runs on the try-for-free collection, no card.',
  },
  {
    field: 'agnes',
    env: 'AGNES_API_KEY',
    label: 'Agnes AI key',
    service: 'Agnes AI',
    signupUrl: 'https://platform.agnes-ai.com/',
    note: 'Free trial model at $0/second, roughly one video per minute.',
  },
  {
    field: 'atmee',
    env: 'ATMEE_API_KEY',
    label: 'Atmee key',
    service: 'Atmee',
    signupUrl: 'https://www.atmee.ai/pricing',
    note: 'Clip generation on the Free plan, no card.',
  },
];

/** Keys that came from the environment when the process started. */
const envKeys: Partial<Record<KeyField, string>> = { ...config.keys };
/** Fields that have an explicit entry in settings.json. */
const saved = new Set<string>();

const storePath = () => path.join(config.dataDir, 'settings.json');

export function isKeyField(field: string): field is KeyField {
  return Object.prototype.hasOwnProperty.call(config.keys, field);
}

async function readStore(): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(storePath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function writeStore(store: Record<string, unknown>): Promise<void> {
  // 0600: the file holds live API keys.
  await writeFile(storePath(), JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/** Apply saved keys on boot, after the env defaults in config.ts. */
export async function loadStoredKeys(): Promise<void> {
  const stored = await readStore();
  for (const [field, value] of Object.entries(stored)) {
    if (!isKeyField(field) || typeof value !== 'string') continue;
    config.keys[field] = value.trim();
    saved.add(field);
  }
}

export async function saveKey(field: string, value: string): Promise<KeySlotView[]> {
  if (!isKeyField(field)) throw new Error(`Unknown key field: ${field}`);
  const trimmed = value.trim().slice(0, 500);

  const stored = await readStore();
  stored[field] = trimmed;
  await writeStore(stored);

  config.keys[field] = trimmed;
  saved.add(field);

  return snapshotSettings();
}

function previewOf(value: string): string | null {
  if (!value) return null;
  return value.length <= 4 ? '••••' : `••••${value.slice(-4)}`;
}

export function snapshotSettings(): KeySlotView[] {
  return KEY_SLOTS.map((slot) => {
    const value = config.keys[slot.field];
    const source: KeySlotView['source'] = saved.has(slot.field)
      ? 'saved'
      : envKeys[slot.field]
        ? 'env'
        : 'none';
    return {
      ...slot,
      configured: value.length > 0,
      preview: previewOf(value),
      source,
    };
  });
}
