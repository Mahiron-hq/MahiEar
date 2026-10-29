import { engine } from '../audio/engine';
import { cat, catalogState, screen, settings, updateSettings } from '../state';
import { reportError } from './log';
import { catalog, parseManifest, type Manifest } from './manifest';
import { syncOffline } from './offline';
import { load, save } from './storage';

const KEY = 'mahiear.manifest.v1';

let pending: Manifest | null = null;
let onApply: (prev: Manifest | null, next: Manifest) => void = () => undefined;
let retry = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

export function initCatalog(applied: (prev: Manifest | null, next: Manifest) => void): void {
  onApply = applied;
  const cached = load(KEY, parseManifest);
  if (cached.status === 'ok') apply(cached.value, false);
  void refresh();
  window.addEventListener('online', () => void refresh());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh();
  });
  setInterval(() => void refresh(), 10 * 60_000);
}

export async function refresh(): Promise<void> {
  clearTimeout(timer);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch('/api/manifest', { cache: 'no-cache', signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(`manifest status ${res.status}`);
    const m = parseManifest(await res.json());
    if (!m) throw new Error('manifest is malformed');
    retry = 0;
    const cur = cat.value?.manifest;
    if (!cur) apply(m, true);
    else if (cur.version !== m.version) {
      pending = m;
      applyPendingIfSafe();
    }
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'AbortError') && navigator.onLine !== false)
      reportError(e, 'manifest.fetch');
    if (!cat.value) {
      catalogState.value = 'error';
      retry++;
      timer = setTimeout(() => void refresh(), Math.min(60_000, 2000 * 2 ** retry));
    }
  }
}

export function applyPendingIfSafe(): void {
  if (!pending) return;
  const s = screen.value.name;
  const busy = s === 'prep' || s === 'finish' || s === 'playlist' || engine.playing;
  if (busy) return;
  const next = pending;
  pending = null;
  apply(next, true);
}

function apply(m: Manifest, persist: boolean): void {
  const prev = cat.value?.manifest ?? null;
  try {
    cat.value = catalog(m);
    catalogState.value = 'ready';
    if (persist) save(KEY, m);
    updateSettings({});
    onApply(prev, m);
    void syncOffline(cat.value, settings.value.offline);
  } catch (e) {
    reportError(e, 'manifest.apply');
  }
}
