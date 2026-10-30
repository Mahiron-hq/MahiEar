import { engine } from '../audio/engine';
import { setWritable } from './storage';

export async function wipeEverything(): Promise<void> {
  engine.stop();
  setWritable(false);
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith('mahiear.')) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
    sessionStorage.removeItem('mahiear.takeover');
  } catch {
    return reloadHome();
  }
  try {
    if (typeof caches !== 'undefined') {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith('mahiear-')).map((n) => caches.delete(n)));
    }
    const regs = (await navigator.serviceWorker?.getRegistrations()) ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
  } finally {
    reloadHome();
  }
}

function reloadHome(): void {
  location.replace('/');
}
