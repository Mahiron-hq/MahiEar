import { batch, computed, signal } from '@preact/signals';
import { PlayClock } from './audio/clock';
import { engine, type MediaMeta } from './audio/engine';
import { enqueue } from './lib/events';
import { audioUrl, type Catalog, type Track } from './lib/manifest';
import { warm } from './lib/offline';
import { createRun, dropRun, loadRun, saveRun, type Answer, type Run, type RunKind } from './lib/runs';
import { recordAnswer, recordCompletedRun } from './lib/stats';
import { cat, navigate, settings } from './state';

const PLAY_COUNT_AFTER = 5;

export const run = signal<Run | null>(null);
export const elapsed = signal(0);

export const position = computed(() => run.value?.pos ?? 0);
export const revealed = computed(() => {
  const r = run.value;
  return !!r && r.revealed[r.pos] === true;
});
export const currentTrack = computed<Track | null>(() => {
  const r = run.value;
  const c = cat.value;
  return r && c ? (c.byId.get(r.order[r.pos]!) ?? null) : null;
});

const clock = new PlayClock();
let playCounted = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let uiTimer: ReturnType<typeof setInterval> | undefined;

function persist(r: Run): void {
  run.value = r;
  saveRun(r);
}

function catalogOrThrow(): Catalog {
  const c = cat.value;
  if (!c) throw new Error('catalog is not loaded');
  return c;
}

export function unfinished(kind: RunKind): Run | null {
  const l = loadRun(kind);
  return l.status === 'ok' && !l.value.finished ? l.value : null;
}

export function startRun(kind: RunKind, ids: readonly string[], label: string, autoplay = true, replace = false): void {
  const c = catalogOrThrow();
  const r = createRun(c, kind, ids, label);
  persist(r);
  navigate({ name: 'prep', kind }, replace);
  enter(0, autoplay);
}

export function resumeRun(kind: RunKind, autoplay: boolean, replace = false): boolean {
  const l = loadRun(kind);
  if (l.status !== 'ok') return false;
  run.value = l.value;
  if (l.value.finished) {
    navigate({ name: 'finish', kind }, true);
    return true;
  }
  navigate({ name: 'prep', kind }, replace);
  enter(l.value.pos, autoplay);
  return true;
}

function shouldLoop(r: Run, track: Track): boolean {
  if (r.revealed[r.pos] !== true) return true;
  const s = settings.value;
  if (s.autoAdvance === 'end') return false;
  if (s.autoAdvance === 'after') return track.duration >= s.advanceAfter;
  return true;
}

function meta(r: Run, track: Track): MediaMeta {
  if (r.revealed[r.pos] !== true) {
    return { title: `Подготовка · ${r.pos + 1} из ${r.order.length}`, artist: 'MahiEar', album: '' };
  }
  const rest = [track.work, track.part, track.section].filter(Boolean).join(' · ');
  return { title: rest, artist: track.composer, album: 'MahiEar' };
}

function setTitle(r: Run): void {
  document.title = `Подготовка · ${r.pos + 1} из ${r.order.length} · MahiEar`;
}

function enter(i: number, autoplay: boolean): void {
  const r0 = run.value;
  const c = cat.value;
  if (!r0 || !c) return;
  const r = { ...r0, pos: i };
  const track = c.byId.get(r.order[i]!);
  if (!track) return;
  clearTimeout(timer);
  clock.reset();
  playCounted = false;
  batch(() => {
    persist(r);
    elapsed.value = 0;
  });
  setTitle(r);
  engine.load({
    id: track.id,
    url: audioUrl(track.id),
    gainDb: track.gain,
    owner: 'prep',
    autoplay,
    loop: shouldLoop(r, track),
    meta: meta(r, track),
    hooks: {
      onTick: tick,
      onEnded: ended,
      onSeeked: (p) => clock.seeked(p, performance.now()),
      onNext: () => next(),
      onPrev: () => back(),
    },
  });
  if (settings.value.revealDelay === 0) reveal();
  const nextId = r.order[i + 1];
  if (nextId) setTimeout(() => void warm(nextId), 1500);
  startUiTimer();
}

function startUiTimer(): void {
  clearInterval(uiTimer);
  uiTimer = setInterval(() => {
    if (engine.owner.value !== 'prep') {
      clearInterval(uiTimer);
      return;
    }
    if (document.visibilityState === 'visible' && engine.playing) tick();
  }, 150);
}

function tick(): void {
  const r = run.value;
  const track = currentTrack.value;
  if (!r || !track || engine.owner.value !== 'prep') return;
  clock.sample(engine.position, engine.playing, performance.now(), engine.duration.value || track.duration);
  elapsed.value = clock.elapsed;
  const s = settings.value;
  if (!playCounted && clock.elapsed >= PLAY_COUNT_AFTER) {
    playCounted = true;
    enqueue({ type: 'play', track: track.id });
  }
  if (r.revealed[r.pos] !== true && clock.elapsed >= s.revealDelay) reveal();
  if (s.autoAdvance === 'after' && revealed.value && engine.playing && clock.elapsed >= s.advanceAfter) {
    next();
    return;
  }
  schedule();
}

function schedule(): void {
  clearTimeout(timer);
  if (!engine.playing) return;
  const s = settings.value;
  const targets = [revealed.value ? Infinity : s.revealDelay, s.autoAdvance === 'after' ? s.advanceAfter : Infinity, PLAY_COUNT_AFTER];
  const left = Math.min(...targets.map((t) => t - clock.elapsed).filter((d) => d > 0));
  if (Number.isFinite(left)) timer = setTimeout(tick, left * 1000 + 40);
}

function ended(): void {
  const r = run.value;
  if (!r) return;
  tick();
  const s = settings.value;
  if (revealed.value && (s.autoAdvance === 'end' || s.autoAdvance === 'after')) {
    next();
    return;
  }
  engine.seek(0);
  engine.play();
}

export function reveal(): void {
  const r = run.value;
  const track = currentTrack.value;
  if (!r || !track || r.revealed[r.pos]) return;
  const revealedList = r.revealed.slice();
  revealedList[r.pos] = true;
  const nr = { ...r, revealed: revealedList };
  persist(nr);
  engine.setMeta(meta(nr, track));
  engine.setLoop(shouldLoop(nr, track));
  schedule();
}

export function next(): void {
  const r = run.value;
  if (!r || r.revealed[r.pos] !== true) return;
  if (r.pos >= r.order.length - 1) finish();
  else enter(r.pos + 1, true);
}

export function back(): void {
  const r = run.value;
  if (!r || r.pos === 0) return;
  const revealedList = r.revealed.slice();
  revealedList[r.pos - 1] = true;
  run.value = { ...r, revealed: revealedList };
  enter(r.pos - 1, true);
}

export function answer(a: Answer): void {
  const r = run.value;
  if (!r || r.revealed[r.pos] !== true) return;
  const id = r.order[r.pos]!;
  const prev = r.answers[id];
  if (prev === a) return;
  persist({ ...r, answers: { ...r.answers, [id]: a } });
  recordAnswer(id, prev, a);
}

export function skip(): void {
  const r = run.value;
  if (!r) return;
  const id = r.order[r.pos]!;
  const revealedList = r.revealed.slice();
  revealedList[r.pos] = true;
  persist({ ...r, revealed: revealedList, skipped: r.skipped.includes(id) ? r.skipped : [...r.skipped, id] });
  next();
}

export function retryCurrent(): void {
  const r = run.value;
  if (!r) return;
  if (r.skipped.includes(r.order[r.pos]!)) persist({ ...r, skipped: r.skipped.filter((x) => x !== r.order[r.pos]) });
  engine.retry();
}

function finish(): void {
  const r = run.value;
  if (!r) return;
  clearTimeout(timer);
  clearInterval(uiTimer);
  let done = { ...r, finished: true };
  if (r.kind === 'full' && r.order.length === (cat.value?.manifest.tracks.length ?? -1) && !r.counted) {
    done = { ...done, counted: true };
    recordCompletedRun();
    enqueue({ type: 'complete' });
  }
  persist(done);
  engine.stop('prep');
  navigate({ name: 'finish', kind: r.kind }, true);
}

export function leave(goHome = true): void {
  clearTimeout(timer);
  clearInterval(uiTimer);
  if (engine.owner.value === 'prep') engine.pause();
  if (goHome) navigate({ name: 'home' });
}

export function closeFinished(kind: RunKind): void {
  const l = loadRun(kind);
  if (l.status === 'ok' && l.value.finished) dropRun(kind);
  if (run.value?.kind === kind) run.value = null;
}

export function onSettingsChanged(): void {
  const r = run.value;
  const track = currentTrack.value;
  if (!r || !track || engine.owner.value !== 'prep') return;
  engine.setLoop(shouldLoop(r, track));
  tick();
}

export function onBackground(): void {
  if (engine.owner.value === 'prep') tick();
}
