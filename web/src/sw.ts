export {};

declare const self: ServiceWorkerGlobalScope;
declare const __VERSION__: string;
declare const __ASSETS__: string[];

const VERSION = __VERSION__;
const ASSETS = __ASSETS__;
const SHELL = `mahiear-shell-${VERSION}`;
const AUDIO_CACHES = ['mahiear-audio-v1', 'mahiear-audio-temp-v1'];
const AUDIO = /^\/a\/[0-9a-f]{24}\.mp3$/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then(async (cache) => {
      await cache.addAll(ASSETS.map((a) => new Request(a, { cache: 'reload' })));
    }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('mahiear-shell-') && k !== SHELL).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') void self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (AUDIO.test(url.pathname)) {
    event.respondWith(audio(req, url));
    return;
  }
  if (req.mode === 'navigate') {
    event.respondWith(shell('/index.html', req));
    return;
  }
  event.respondWith(shell(url.pathname, req));
});

async function shell(path: string, req: Request): Promise<Response> {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(path);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.status === 200 && path.startsWith('/assets/')) void cache.put(path, res.clone());
  return res;
}

async function cachedAudio(url: string): Promise<Response | undefined> {
  for (const name of AUDIO_CACHES) {
    const c = await caches.open(name);
    const hit = await c.match(url);
    if (hit) return hit;
  }
  return undefined;
}

async function audio(req: Request, url: URL): Promise<Response> {
  const hit = await cachedAudio(url.href);
  if (!hit) return fetch(req);
  const range = req.headers.get('range');
  if (!range) return hit;
  const blob = await hit.blob();
  const r = parseRange(range, blob.size);
  if (!r) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${blob.size}` } });
  }
  return new Response(blob.slice(r.start, r.end + 1), {
    status: 206,
    headers: {
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(r.end - r.start + 1),
      'Content-Range': `bytes ${r.start}-${r.end}/${blob.size}`,
      'Accept-Ranges': 'bytes',
    },
  });
}

function parseRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || size === 0) return null;
  const [, a = '', b = ''] = m;
  let start: number;
  let end: number;
  if (a === '') {
    if (b === '') return null;
    start = Math.max(0, size - Number(b));
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  return start <= end && start < size ? { start, end } : null;
}
