let keyboard = false;

export function trackInputMode(): void {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' || e.key === 'Enter' || e.key === ' ' || e.key.startsWith('Arrow')) keyboard = true;
  }, true);
  window.addEventListener('pointerdown', () => (keyboard = false), true);
}

export function keyboardMode(): boolean {
  return keyboard;
}

export function focusScreen(): void {
  if (!keyboard) return;
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const h = document.querySelector<HTMLElement>('main h1');
    if (!h) return;
    h.tabIndex = -1;
    h.focus();
  });
}
