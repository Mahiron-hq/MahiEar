import { signal } from '@preact/signals';
import type { Answer } from './runs';
import { load, save } from './storage';

export interface TrackStat {
  knew: number;
  didnt: number;
  last: Answer | null;
}

export interface Stats {
  v: 1;
  completedRuns: number;
  tracks: Record<string, TrackStat>;
}

const KEY = 'mahiear.stats.v1';

const empty = (): Stats => ({ v: 1, completedRuns: 0, tracks: {} });

export function parseStats(raw: unknown): Stats | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const count = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  if (r.v !== 1 || !count(r.completedRuns) || !r.tracks || typeof r.tracks !== 'object') return null;
  const tracks: Record<string, TrackStat> = {};
  for (const [id, t] of Object.entries(r.tracks as Record<string, unknown>)) {
    if (!t || typeof t !== 'object') return null;
    const s = t as Record<string, unknown>;
    if (!count(s.knew) || !count(s.didnt) || (s.last !== null && s.last !== 'knew' && s.last !== 'didnt')) return null;
    tracks[id] = { knew: s.knew as number, didnt: s.didnt as number, last: s.last as Answer | null };
  }
  return { v: 1, completedRuns: r.completedRuns as number, tracks };
}

export const stats = signal<Stats>(empty());

export function initStats(): 'ok' | 'reset' {
  const l = load(KEY, parseStats);
  if (l.status === 'ok') {
    stats.value = l.value;
    return 'ok';
  }
  stats.value = empty();
  return l.status === 'corrupt' ? 'reset' : 'ok';
}

function commit(next: Stats): void {
  stats.value = next;
  save(KEY, next);
}

export function recordAnswer(id: string, prev: Answer | undefined, next: Answer): void {
  if (prev === next) return;
  const cur = stats.value.tracks[id] ?? { knew: 0, didnt: 0, last: null };
  const t = { ...cur };
  if (prev === 'knew') t.knew = Math.max(0, t.knew - 1);
  if (prev === 'didnt') t.didnt = Math.max(0, t.didnt - 1);
  if (next === 'knew') t.knew++;
  else t.didnt++;
  t.last = next;
  commit({ ...stats.value, tracks: { ...stats.value.tracks, [id]: t } });
}

export function recordCompletedRun(): void {
  commit({ ...stats.value, completedRuns: stats.value.completedRuns + 1 });
}

export function resetStats(): void {
  commit(empty());
}

export function pruneStats(keep: Set<string>): void {
  const tracks = Object.fromEntries(Object.entries(stats.value.tracks).filter(([id]) => keep.has(id)));
  if (Object.keys(tracks).length !== Object.keys(stats.value.tracks).length) commit({ ...stats.value, tracks });
}

export function mostMissed(ids: readonly string[]): string[] {
  const t = stats.value.tracks;
  return ids
    .filter((id) => (t[id]?.didnt ?? 0) > 0)
    .sort((a, b) => (t[b]!.didnt - t[a]!.didnt) || (t[a]!.knew - t[b]!.knew));
}
