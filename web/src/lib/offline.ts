import { signal } from '@preact/signals';
import { engine } from '../audio/engine';
import { reportError } from './log';
import { audioUrl, type Catalog } from './manifest';

export const AUDIO_CACHE = 'mahiear-audio-v1';
export const TEMP_CACHE = 'mahiear-audio-temp-v1';
const TEMP_LIMIT = 4;

export type OfflineState = 'off' | 'unsupported' | 'checking' | 'downloading' | 'done' | 'quota' | 'waiting';

export const offline = signal<{ state: OfflineState; done: number; total: number }>({ state: 'checking', done: 0, total: 0 });

let generation = 0;
let persistAsked = false;
let current: { cat: Catalog; enabled: boolean } | null = null;
let wired = false;

const supported = () => typeof caches !== 'undefined';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function wire(): void {
  if (wired) return;
  wired = true;
  window.addEventListener('online', () => restart());
  setInterval(() => restart(), 15 * 60_000);
}

function restart(): void {
  if (current && offline.value.state !== 'downloading') void syncOffline(current.cat, current.enabled);
}

export async function syncOffline(cat: Catalog, enabled: boolean): Promise<void> {
  wire();
  current = { cat, enabled };
  const gen = ++generation;
  const total = cat.manifest.tracks.length;
  if (!supported()) {
    offline.value = { state: 'unsupported', done: 0, total };
    return;
  }
  try {
    if (!enabled) {
      await caches.delete(AUDIO_CACHE);
      offline.value = { state: 'off', done: 0, total };
      return;
    }
    if (!persistAsked && navigator.storage?.persist) {
      persistAsked = true;
      void navigator.storage.persist().catch(() => false);
    }
    const cache = await caches.open(AUDIO_CACHE);
    const wanted = new Set(cat.manifest.tracks.map((t) => new URL(audioUrl(t.id), location.href).href));
    const keys = await cache.keys();
    for (const k of keys) if (!wanted.has(k.url)) await cache.delete(k);
    const have = new Set(keys.map((k) => k.url).filter((u) => wanted.has(u)));
    let done = have.size;
    offline.value = { state: done === total ? 'done' : 'downloading', done, total };

    let failures = 0;
    for (const t of cat.manifest.tracks) {
      const url = new URL(audioUrl(t.id), location.href).href;
      if (have.has(url)) continue;
      for (;;) {
        if (gen !== generation) return;
        while (engine.status.value === 'loading' && engine.current.value !== t.id) {
          await sleep(500);
          if (gen !== generation) return;
        }
        if (navigator.onLine === false) {
          offline.value = { state: 'waiting', done, total };
          return;
        }
        try {
          const temp = await caches.open(TEMP_CACHE);
          const warm = await temp.match(url);
          const res = warm ?? (await fetch(url, { priority: 'low', cache: 'no-cache' } as RequestInit));
          if (!res.ok || res.status !== 200) throw new Error(`status ${res.status}`);
          await cache.put(url, res);
          done++;
          failures = 0;
          offline.value = { state: done === total ? 'done' : 'downloading', done, total };
          break;
        } catch (e) {
          if (isQuota(e)) {
            offline.value = { state: 'quota', done, total };
            return;
          }
          failures++;
          if (failures > 6) {
            offline.value = { state: 'waiting', done, total };
            setTimeout(() => restart(), 60_000);
            return;
          }
          await sleep(Math.min(30_000, 1000 * 2 ** failures));
        }
      }
    }
    if (gen === generation) offline.value = { state: done === total ? 'done' : 'waiting', done, total };
  } catch (e) {
    if (isQuota(e)) offline.value = { state: 'quota', done: offline.value.done, total };
    else {
      reportError(e, 'offline.sync');
      offline.value = { state: 'waiting', done: offline.value.done, total };
    }
  }
}

function isQuota(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'QuotaExceededError';
}

export async function warm(id: string): Promise<void> {
  if (!supported() || navigator.onLine === false) return;
  const url = new URL(audioUrl(id), location.href).href;
  try {
    if (await caches.match(url)) return;
    const res = await fetch(url, { priority: 'low' } as RequestInit);
    if (!res.ok || res.status !== 200) return;
    const temp = await caches.open(TEMP_CACHE);
    await temp.put(url, res);
    const keys = await temp.keys();
    for (const k of keys.slice(0, Math.max(0, keys.length - TEMP_LIMIT))) await temp.delete(k);
  } catch {
    return;
  }
}
