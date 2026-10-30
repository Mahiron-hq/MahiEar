import { computed, signal } from '@preact/signals';
import { PlayClock } from './audio/clock';
import { engine } from './audio/engine';
import { enqueue } from './lib/events';
import { audioUrl } from './lib/manifest';
import { warm } from './lib/offline';
import { shuffle as shuffled } from './lib/random';
import { load, save } from './lib/storage';
import { cat, navigate, screen } from './state';

export type Repeat = 'off' | 'all' | 'one';

const KEY = 'mahiear.playlist.v1';
const RESTART_THRESHOLD = 3;

export const current = signal<string | null>(null);
export const shuffleOn = signal(false);
export const repeat = signal<Repeat>('off');
export const active = computed(() => engine.owner.value === 'playlist' && engine.current.value === current.value);

let bag: string[] = [];
const clock = new PlayClock();
let counted = false;

export function initPlaylist(): void {
  const l = load(KEY, (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.shuffle !== 'boolean' || (r.repeat !== 'off' && r.repeat !== 'all' && r.repeat !== 'one')) return null;
    return { shuffle: r.shuffle, repeat: r.repeat as Repeat };
  });
  if (l.status === 'ok') {
    shuffleOn.value = l.value.shuffle;
    repeat.value = l.value.repeat;
  }
}

function persistPrefs(): void {
  save(KEY, { shuffle: shuffleOn.value, repeat: repeat.value });
}

function ids(): string[] {
  return cat.value?.manifest.tracks.map((t) => t.id) ?? [];
}

function sequence(): string[] {
  if (!shuffleOn.value) return ids();
  const all = ids();
  if (bag.length !== all.length || !all.every((id) => bag.includes(id))) rebuildBag(current.value);
  return bag;
}

function rebuildBag(first: string | null, avoidFirst?: string): void {
  const all = ids();
  if (first && all.includes(first)) {
    bag = [first, ...shuffled(all.filter((id) => id !== first))];
    return;
  }
  bag = shuffled(all);
  if (avoidFirst && bag.length > 1 && bag[0] === avoidFirst) [bag[0], bag[1]] = [bag[1]!, bag[0]!];
}

export function playTrack(id: string): void {
  const c = cat.value;
  const t = c?.byId.get(id);
  if (!t) return;
  if (engine.owner.value === 'playlist' && engine.current.value === id) {
    engine.toggle();
    return;
  }
  current.value = id;
  if (screen.value.name === 'playlist') navigate({ name: 'playlist', track: id }, true);
  clock.reset();
  counted = false;
  engine.load({
    id,
    url: audioUrl(id),
    gainDb: t.gain,
    owner: 'playlist',
    autoplay: true,
    loop: repeat.value === 'one',
    meta: { title: [t.work, t.part, t.section].filter(Boolean).join(' · '), artist: t.composer, album: 'MahiEar' },
    hooks: {
      onTick: tick,
      onEnded: () => advance(false),
      onSeeked: (p) => clock.seeked(p, performance.now()),
      onNext: () => advance(true),
      onPrev: () => previous(),
    },
  });
  const seq = sequence();
  const nextId = seq[seq.indexOf(id) + 1];
  if (nextId) setTimeout(() => void warm(nextId), 1500);
}

function tick(): void {
  const id = current.value;
  const t = id ? cat.value?.byId.get(id) : undefined;
  if (!t || engine.owner.value !== 'playlist') return;
  clock.sample(engine.position, engine.playing, performance.now(), engine.duration.value || t.duration);
  if (!counted && clock.elapsed >= 5) {
    counted = true;
    enqueue({ type: 'play', track: t.id });
  }
}

export function select(id: string): void {
  if (cat.value?.byId.has(id) && !(engine.owner.value === 'playlist' && engine.playing)) current.value = id;
}

export function toggle(): void {
  if (engine.owner.value === 'playlist' && current.value) engine.toggle();
  else if (current.value) playTrack(current.value);
  else {
    const first = sequence()[0];
    if (first) playTrack(first);
  }
}

export function advance(manual: boolean): void {
  const seq = sequence();
  const i = current.value ? seq.indexOf(current.value) : -1;
  if (i + 1 < seq.length) {
    playTrack(seq[i + 1]!);
    return;
  }
  if (repeat.value === 'all' || manual) {
    if (shuffleOn.value) rebuildBag(null, current.value ?? undefined);
    const first = sequence()[0];
    if (!first) return;
    playTrack(first);
    return;
  }
  engine.pause();
  engine.seek(0);
}

export function previous(): void {
  if (engine.owner.value === 'playlist' && engine.position > RESTART_THRESHOLD) {
    engine.seek(0);
    clock.seeked(0, performance.now());
    return;
  }
  const seq = sequence();
  const i = current.value ? seq.indexOf(current.value) : 0;
  const prev = seq[i - 1];
  if (prev) playTrack(prev);
  else engine.seek(0);
}

export function setShuffle(on: boolean): void {
  shuffleOn.value = on;
  if (on) rebuildBag(current.value);
  persistPrefs();
}

export function cycleRepeat(): void {
  repeat.value = repeat.value === 'off' ? 'all' : repeat.value === 'all' ? 'one' : 'off';
  if (engine.owner.value === 'playlist') engine.setLoop(repeat.value === 'one');
  persistPrefs();
}

export function resetPlaylist(): void {
  if (current.value && !cat.value?.byId.has(current.value)) current.value = null;
  bag = [];
}
