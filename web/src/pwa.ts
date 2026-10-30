import { effect } from '@preact/signals';
import { engine } from './audio/engine';
import { reportError } from './lib/log';
import { screen } from './state';

let registration: ServiceWorkerRegistration | null = null;
let reloading = false;

function safe(): boolean {
  if (engine.playing || engine.status.value === 'loading') return false;
  return screen.value.name !== 'prep' || performance.now() < 15_000;
}

function applyIfSafe(): void {
  const waiting = registration?.waiting;
  if (waiting && safe() && navigator.serviceWorker.controller) waiting.postMessage('skip-waiting');
}

export function initServiceWorker(): void {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  const register = () =>
    navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then((reg) => {
        if (!reg) return;
        registration = reg;
        reg.addEventListener('updatefound', () => {
          reg.installing?.addEventListener('statechange', () => applyIfSafe());
        });
        applyIfSafe();
        setInterval(() => void reg.update().catch(() => undefined), 30 * 60_000);
      })
      .catch((e: unknown) => reportError(e, 'sw.register'));
  if (document.readyState === 'complete') void register();
  else window.addEventListener('load', () => void register(), { once: true });
  effect(() => {
    void screen.value;
    void engine.status.value;
    applyIfSafe();
  });
}
