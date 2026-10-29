import { uuid } from './random';
import { load, save } from './storage';

export type ServerEvent = { type: 'play'; id: string; track: string } | { type: 'complete'; id: string };

const KEY = 'mahiear.queue.v1';
const MAX_QUEUE = 2000;
const BATCH = 100;

function parseQueue(raw: unknown): ServerEvent[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ServerEvent[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') return null;
    const r = e as Record<string, unknown>;
    if (typeof r.id !== 'string') return null;
    if (r.type === 'play' && typeof r.track === 'string') out.push({ type: 'play', id: r.id, track: r.track });
    else if (r.type === 'complete') out.push({ type: 'complete', id: r.id });
    else return null;
  }
  return out;
}

let queue: ServerEvent[] = [];
let sending = false;
let retryAt = 0;
let failures = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let active = true;

export function initQueue(): void {
  const l = load(KEY, parseQueue);
  queue = l.status === 'ok' ? l.value : [];
  window.addEventListener('online', () => {
    retryAt = 0;
    void flush();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flush(true);
  });
  setInterval(() => void flush(), 60_000);
  schedule(2000);
}

export function setQueueActive(on: boolean): void {
  active = on;
  if (on) {
    const l = load(KEY, parseQueue);
    queue = l.status === 'ok' ? l.value : queue;
    schedule(1000);
  }
}

export function enqueue(e: { type: 'play'; track: string } | { type: 'complete' }): void {
  const ev: ServerEvent = e.type === 'play' ? { type: 'play', id: uuid(), track: e.track } : { type: 'complete', id: uuid() };
  queue = [...queue, ev].slice(-MAX_QUEUE);
  save(KEY, queue);
  schedule(3000);
}

function schedule(ms: number): void {
  clearTimeout(timer);
  timer = setTimeout(() => void flush(), ms);
}

export async function flush(leaving = false): Promise<void> {
  if (!active || sending || queue.length === 0 || Date.now() < retryAt) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  sending = true;
  const batch = queue.slice(0, BATCH);
  try {
    const res = await fetch('/api/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: batch }),
      keepalive: leaving,
    });
    if (res.ok) {
      const body = (await res.json()) as { ack?: unknown };
      const acked = new Set(Array.isArray(body.ack) ? body.ack.filter((x): x is string => typeof x === 'string') : []);
      drop(batch, acked);
      failures = 0;
    } else if (res.status === 400 || res.status === 413) {
      drop(batch, new Set(batch.map((e) => e.id)));
    } else {
      backoff();
    }
  } catch {
    backoff();
  } finally {
    sending = false;
  }
  if (queue.length > 0 && Date.now() >= retryAt) schedule(500);
}

function drop(batch: ServerEvent[], ids: Set<string>): void {
  const sent = new Set(batch.filter((e) => ids.has(e.id)).map((e) => e.id));
  queue = queue.filter((e) => !sent.has(e.id));
  save(KEY, queue);
}

function backoff(): void {
  failures++;
  const delay = Math.min(300_000, 15_000 * 2 ** Math.min(failures - 1, 5));
  retryAt = Date.now() + delay;
  schedule(delay + 100);
}
