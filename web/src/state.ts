import { signal } from '@preact/signals';
import { engine } from './audio/engine';
import type { Catalog } from './lib/manifest';
import type { RunKind } from './lib/runs';
import { DEFAULTS, parseSettings, reconcile, type Settings } from './lib/settings';
import { load, save } from './lib/storage';

export type Screen =
  | { name: 'home' }
  | { name: 'prep'; kind: RunKind }
  | { name: 'finish'; kind: RunKind }
  | { name: 'selective' }
  | { name: 'playlist' }
  | { name: 'settings' }
  | { name: 'stats' };

export const screen = signal<Screen>({ name: 'home' });
export const cat = signal<Catalog | null>(null);
export const catalogState = signal<'loading' | 'ready' | 'error'>('loading');
export const settings = signal<Settings>(DEFAULTS);

export interface Toast {
  id: number;
  text: string;
}
export const toasts = signal<Toast[]>([]);

export interface Notice {
  title: string;
  text: string;
}
export const notices = signal<Notice[]>([]);

let toastSeq = 0;

export function toast(text: string, ms = 3500): void {
  const id = ++toastSeq;
  toasts.value = [...toasts.value.filter((t) => t.text !== text), { id, text }].slice(-3);
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, ms);
}

export function notice(title: string, text: string): void {
  if (notices.value.some((n) => n.title === title && n.text === text)) return;
  notices.value = [...notices.value, { title, text }];
}

export function dismissNotice(): void {
  notices.value = notices.value.slice(1);
}

const SCREEN_KEY = 'mahiear.screen.v1';

export function navigate(next: Screen, replace = false): void {
  const prev = screen.value;
  screen.value = next;
  save(SCREEN_KEY, next);
  try {
    if (replace || next.name === 'home') history.replaceState({ s: next.name }, '');
    else if (prev.name === 'home') history.pushState({ s: next.name }, '');
    else history.replaceState({ s: next.name }, '');
  } catch {
    return;
  }
}

export function savedScreen(): Screen | null {
  const l = load(SCREEN_KEY, (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if ((r.name === 'prep' || r.name === 'finish') && (r.kind === 'full' || r.kind === 'selective'))
      return { name: r.name, kind: r.kind } as Screen;
    if (r.name === 'playlist' || r.name === 'settings' || r.name === 'stats' || r.name === 'selective' || r.name === 'home')
      return { name: r.name } as Screen;
    return null;
  });
  return l.status === 'ok' ? l.value : null;
}

const SETTINGS_KEY = 'mahiear.settings.v1';

export function initSettings(): 'ok' | 'reset' {
  const l = load(SETTINGS_KEY, parseSettings);
  settings.value = l.status === 'ok' ? l.value : DEFAULTS;
  engine.setNormalize(settings.value.normalize);
  engine.setVolume(settings.value.volume);
  return l.status === 'corrupt' ? 'reset' : 'ok';
}

export function maxDuration(): number {
  return cat.value?.maxDuration ?? 0;
}

export function updateSettings(patch: Partial<Settings>): void {
  const merged = { ...settings.value, ...patch };
  const { settings: next, raisedTo } = reconcile(merged, maxDuration());
  settings.value = next;
  save(SETTINGS_KEY, next);
  engine.setNormalize(next.normalize);
  engine.setVolume(next.volume);
  if (raisedTo !== null) toast(`Время автоперехода поднято до ${raisedTo} с`);
}

export function resetSettings(): void {
  updateSettings({ ...DEFAULTS, volume: settings.value.volume });
}
