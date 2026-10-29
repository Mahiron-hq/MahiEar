export type AutoAdvance = 'off' | 'end' | 'after';

export interface Settings {
  revealDelay: number;
  autoAdvance: AutoAdvance;
  advanceAfter: number;
  normalize: boolean;
  background: boolean;
  offline: boolean;
  volume: number;
}

export const DELAY_MIN = 0;
export const DELAY_MAX = 15;
export const ADVANCE_FLOOR = 12;
export const ADVANCE_GAP = 3;

export const DEFAULTS: Settings = {
  revealDelay: 8,
  autoAdvance: 'off',
  advanceAfter: ADVANCE_FLOOR,
  normalize: true,
  background: true,
  offline: true,
  volume: 1,
};

export function advanceBounds(revealDelay: number, maxDuration: number): { min: number; max: number; available: boolean } {
  const min = Math.max(ADVANCE_FLOOR, revealDelay + ADVANCE_GAP);
  const max = Math.floor(maxDuration);
  return { min, max, available: max >= min };
}

export function clampInt(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(v)));
}

export function parseSettings(raw: unknown): Settings | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, min: number, max: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;
  const delay = num(r.revealDelay, DELAY_MIN, DELAY_MAX);
  const after = num(r.advanceAfter, ADVANCE_FLOOR, 3600);
  const mode = r.autoAdvance === 'off' || r.autoAdvance === 'end' || r.autoAdvance === 'after' ? r.autoAdvance : null;
  const vol = typeof r.volume === 'number' && r.volume >= 0 && r.volume <= 1 ? r.volume : null;
  const bools = [r.normalize, r.background, r.offline];
  if (delay === null || after === null || mode === null || vol === null || bools.some((b) => typeof b !== 'boolean'))
    return null;
  return {
    revealDelay: delay,
    autoAdvance: mode,
    advanceAfter: after,
    normalize: r.normalize as boolean,
    background: r.background as boolean,
    offline: r.offline as boolean,
    volume: vol,
  };
}

export interface Reconciled {
  settings: Settings;
  raisedTo: number | null;
}

export function reconcile(s: Settings, maxDuration: number): Reconciled {
  const b = advanceBounds(s.revealDelay, maxDuration);
  let next = s;
  let raisedTo: number | null = null;
  if (s.advanceAfter < b.min) {
    next = { ...next, advanceAfter: b.min };
    if (s.autoAdvance === 'after' && b.available) raisedTo = b.min;
  } else if (b.available && s.advanceAfter > b.max) {
    next = { ...next, advanceAfter: b.max };
  }
  if (next.autoAdvance === 'after' && !b.available && maxDuration > 0) next = { ...next, autoAdvance: 'off' };
  return { settings: next, raisedTo };
}
