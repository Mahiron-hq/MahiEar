import type { Catalog } from './manifest';
import { shuffle } from './random';

export function buildOrder(cat: Catalog, ids: readonly string[]): string[] {
  const wanted = new Set(ids);
  const blocks = cat.manifest.blocks
    .map((b) => b.tracks.filter((id) => wanted.has(id)))
    .filter((b) => b.length > 0);
  return shuffle(blocks).flatMap((b) => shuffle(b));
}

function factorial(n: number): number {
  let f = 1;
  for (let i = 2; i <= n && f < 1e9; i++) f *= i;
  return f;
}

export function possibleOrders(cat: Catalog, ids: readonly string[]): number {
  const wanted = new Set(ids);
  const sizes = cat.manifest.blocks.map((b) => b.tracks.filter((id) => wanted.has(id)).length).filter((n) => n > 0);
  return sizes.reduce((acc, n) => Math.min(1e9, acc * factorial(n)), factorial(sizes.length));
}

export function freshOrder(cat: Catalog, ids: readonly string[], previous: readonly string[] | null): string[] {
  const order = buildOrder(cat, ids);
  if (!previous || possibleOrders(cat, ids) < 2) return order;
  const prev = previous.join(',');
  let next = order;
  for (let i = 0; i < 64 && next.join(',') === prev; i++) next = buildOrder(cat, ids);
  return next;
}

export function blockSignature(cat: Catalog, ids: readonly string[]): string {
  const groups = new Map<number, string[]>();
  for (const id of ids) {
    const b = cat.blockOf.get(id);
    if (b === undefined) return '';
    const g = groups.get(b) ?? [];
    g.push(id);
    groups.set(b, g);
  }
  return [...groups.values()]
    .map((g) => g.slice().sort().join('+'))
    .sort()
    .join('|');
}

export function isContiguousByBlock(cat: Catalog, order: readonly string[]): boolean {
  const seen = new Set<number>();
  let last = -1;
  for (const id of order) {
    const b = cat.blockOf.get(id);
    if (b === undefined) return false;
    if (b !== last) {
      if (seen.has(b)) return false;
      seen.add(b);
      last = b;
    }
  }
  return true;
}
