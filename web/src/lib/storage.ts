import { signal } from '@preact/signals';

export type StorageProblem = 'unavailable' | 'full';

export const storageProblem = signal<StorageProblem | null>(null);

const memory = new Map<string, string>();
const backend: Storage | null = probe();
let writable = true;

function probe(): Storage | null {
  try {
    const s = window.localStorage;
    const k = '__mahiear_probe';
    s.setItem(k, '1');
    s.removeItem(k);
    return s;
  } catch {
    return null;
  }
}

if (!backend) storageProblem.value = 'unavailable';

export function setWritable(on: boolean): void {
  writable = on;
}

export type Loaded<T> = { status: 'ok'; value: T } | { status: 'missing' } | { status: 'corrupt' };

export function load<T>(key: string, parse: (raw: unknown) => T | null): Loaded<T> {
  let text: string | null;
  try {
    text = backend ? backend.getItem(key) : (memory.get(key) ?? null);
  } catch {
    text = memory.get(key) ?? null;
  }
  if (text === null) return { status: 'missing' };
  try {
    const value = parse(JSON.parse(text));
    return value === null ? { status: 'corrupt' } : { status: 'ok', value };
  } catch {
    return { status: 'corrupt' };
  }
}

export function save(key: string, value: unknown): void {
  if (!writable) return;
  const text = JSON.stringify(value);
  memory.set(key, text);
  if (!backend) return;
  try {
    backend.setItem(key, text);
  } catch (e) {
    if (!storageProblem.value) storageProblem.value = isQuota(e) ? 'full' : 'unavailable';
  }
}

export function remove(key: string): void {
  if (!writable) return;
  memory.delete(key);
  try {
    backend?.removeItem(key);
  } catch {
    return;
  }
}

function isQuota(e: unknown): boolean {
  return e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014);
}
