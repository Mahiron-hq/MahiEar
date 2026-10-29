import type { Catalog } from './manifest';
import { blockSignature, freshOrder } from './order';
import { uuid } from './random';
import { load, remove, save } from './storage';

export type RunKind = 'full' | 'selective';
export type Answer = 'knew' | 'didnt';

export interface Run {
  v: 1;
  id: string;
  kind: RunKind;
  label: string;
  set: string;
  sig: string;
  order: string[];
  pos: number;
  revealed: boolean[];
  answers: Record<string, Answer>;
  skipped: string[];
  finished: boolean;
  counted: boolean;
}

const KEYS: Record<RunKind, string> = { full: 'mahiear.run.full.v1', selective: 'mahiear.run.selective.v1' };
const LAST_ORDER: Record<RunKind, string> = { full: 'mahiear.lastOrder.full.v1', selective: 'mahiear.lastOrder.selective.v1' };

export function parseRun(raw: unknown): Run | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || (r.kind !== 'full' && r.kind !== 'selective')) return null;
  if (typeof r.id !== 'string' || typeof r.set !== 'string' || typeof r.sig !== 'string') return null;
  if (typeof r.label !== 'string') return null;
  const order = r.order;
  if (!Array.isArray(order) || order.length === 0 || !order.every((x) => typeof x === 'string')) return null;
  if (new Set(order).size !== order.length) return null;
  if (typeof r.pos !== 'number' || !Number.isInteger(r.pos) || r.pos < 0 || r.pos >= order.length) return null;
  const revealed = r.revealed;
  if (!Array.isArray(revealed) || revealed.length !== order.length || !revealed.every((x) => typeof x === 'boolean'))
    return null;
  const answers = r.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null;
  const ids = new Set(order as string[]);
  for (const [k, v] of Object.entries(answers)) {
    if (!ids.has(k) || (v !== 'knew' && v !== 'didnt')) return null;
  }
  const skipped = r.skipped;
  if (!Array.isArray(skipped) || !skipped.every((x) => typeof x === 'string' && ids.has(x))) return null;
  if (typeof r.finished !== 'boolean' || typeof r.counted !== 'boolean') return null;
  return {
    v: 1,
    id: r.id,
    kind: r.kind,
    label: r.label,
    set: r.set,
    sig: r.sig,
    order: order as string[],
    pos: r.pos,
    revealed: revealed as boolean[],
    answers: answers as Record<string, Answer>,
    skipped: skipped as string[],
    finished: r.finished,
    counted: r.counted,
  };
}

export function loadRun(kind: RunKind) {
  return load(KEYS[kind], parseRun);
}

export function saveRun(run: Run): void {
  save(KEYS[run.kind], run);
}

export function dropRun(kind: RunKind): void {
  remove(KEYS[kind]);
}

function lastOrder(kind: RunKind): string[] | null {
  const l = load(LAST_ORDER[kind], (raw) => (Array.isArray(raw) && raw.every((x) => typeof x === 'string') ? raw : null));
  return l.status === 'ok' ? (l.value as string[]) : null;
}

export function createRun(cat: Catalog, kind: RunKind, ids: readonly string[], label: string): Run {
  const order = freshOrder(cat, ids, lastOrder(kind));
  save(LAST_ORDER[kind], order);
  return {
    v: 1,
    id: uuid(),
    kind,
    label,
    set: cat.manifest.version,
    sig: blockSignature(cat, order),
    order,
    pos: 0,
    revealed: order.map(() => false),
    answers: {},
    skipped: [],
    finished: false,
    counted: false,
  };
}

export function stillValid(run: Run, cat: Catalog): boolean {
  if (run.set === cat.manifest.version) return true;
  if (!run.order.every((id) => cat.byId.has(id))) return false;
  if (run.kind === 'full' && run.order.length !== cat.manifest.tracks.length) return false;
  return blockSignature(cat, run.order) === run.sig;
}

export function rebase(run: Run, cat: Catalog): Run {
  return { ...run, set: cat.manifest.version };
}

export interface Summary {
  knew: string[];
  didnt: string[];
  unanswered: string[];
  skipped: string[];
}

export function summarize(run: Run): Summary {
  const skipped = new Set(run.skipped);
  const s: Summary = { knew: [], didnt: [], unanswered: [], skipped: run.skipped.slice() };
  for (const id of run.order) {
    const a = run.answers[id];
    if (a === 'knew') s.knew.push(id);
    else if (a === 'didnt') s.didnt.push(id);
    else if (!skipped.has(id)) s.unanswered.push(id);
  }
  return s;
}
