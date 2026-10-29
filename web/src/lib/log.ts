let sent = 0;
const seen = new Set<string>();

export function reportError(e: unknown, context: string): void {
  const err = e instanceof Error ? e : new Error(String(e));
  console.error(`[${context}]`, err);
  const key = `${context}:${err.message}`;
  if (seen.has(key) || sent >= 20) return;
  seen.add(key);
  sent++;
  try {
    void fetch('/api/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: err.message.slice(0, 500),
        stack: (err.stack ?? '').slice(0, 2000),
        context: context.slice(0, 100),
      }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    return;
  }
}

export function installGlobalHandlers(): void {
  window.addEventListener('error', (ev) => reportError(ev.error ?? ev.message, 'window.error'));
  window.addEventListener('unhandledrejection', (ev) => reportError(ev.reason, 'unhandledrejection'));
}
