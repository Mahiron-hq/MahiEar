import { signal } from '@preact/signals';
import { Keyboard } from 'lucide-preact';
import { engine } from '../audio/engine';
import * as prep from '../prep';
import * as pl from '../playlist';
import { screen, settings, updateSettings } from '../state';
import { Button, Dialog, ICON, IconButton } from './common';

const helpOpen = signal<'prep' | 'playlist' | null>(null);

export function KeysButton({ mode }: { mode: 'prep' | 'playlist' }) {
  return (
    <IconButton label="Горячие клавиши" class="keys-btn" onClick={() => (helpOpen.value = mode)}>
      <Keyboard {...ICON} />
    </IconButton>
  );
}

const PREP_KEYS: [string, string][] = [
  ['Пробел', 'воспроизведение и пауза'],
  ['Enter', 'показать название, затем перейти вперёд'],
  ['←', 'назад'],
  ['→', 'вперёд, если доступно'],
];

const PLAYLIST_KEYS: [string, string][] = [
  ['Пробел', 'воспроизведение и пауза'],
  ['← →', 'перемотка на 5 секунд'],
  ['Shift + ← →', 'предыдущий и следующий трек'],
  ['↑ ↓', 'громкость'],
];

export function KeysHelp() {
  const mode = helpOpen.value;
  return (
    <Dialog
      open={mode !== null}
      title="Горячие клавиши"
      onClose={() => (helpOpen.value = null)}
      actions={
        <Button variant="primary" onClick={() => (helpOpen.value = null)}>
          Понятно
        </Button>
      }
    >
      <dl class="keys">
        {(mode === 'playlist' ? PLAYLIST_KEYS : PREP_KEYS).map(([k, v]) => (
          <div class="keys-row" key={k}>
            <dt>
              <kbd>{k}</kbd>
            </dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}

function typing(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  if (t instanceof HTMLInputElement) return !['checkbox', 'radio', 'button', 'range'].includes(t.type);
  return false;
}

function keyboardFocused(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement) || t === document.body) return false;
  const interactive = t.closest('button, a, input, [role="slider"], summary');
  if (!interactive) return false;
  try {
    return interactive.matches(':focus-visible');
  } catch {
    return true;
  }
}

function onSlider(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && !!t.closest('[role="slider"], input[type="range"], input[type="radio"]');
}

export function onKeyDown(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || typing(e.target)) return;
  if (document.querySelector('dialog[open]')) return;
  const s = screen.value.name;
  if (s !== 'prep' && s !== 'playlist') return;
  const native = keyboardFocused(e.target);

  if (e.key === ' ' || e.code === 'Space') {
    if (native) return;
    e.preventDefault();
    if (s === 'prep') engine.toggle();
    else pl.toggle();
    return;
  }

  if (s === 'prep') {
    if (e.key === 'Enter') {
      if (native) return;
      e.preventDefault();
      if (prep.revealed.value) prep.next();
      else prep.reveal();
    } else if (e.key === 'ArrowLeft' && !onSlider(e.target)) {
      e.preventDefault();
      prep.back();
    } else if (e.key === 'ArrowRight' && !onSlider(e.target)) {
      e.preventDefault();
      prep.next();
    }
    return;
  }

  if (onSlider(e.target)) return;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    const dir = e.key === 'ArrowLeft' ? -1 : 1;
    if (e.shiftKey) {
      if (dir < 0) pl.previous();
      else pl.advance(true);
    } else if (engine.owner.value === 'playlist') engine.seek(engine.position + dir * 5);
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    const v = Math.round((settings.value.volume + (e.key === 'ArrowUp' ? 0.1 : -0.1)) * 10) / 10;
    updateSettings({ volume: Math.min(1, Math.max(0, v)) });
  }
}
