import { describe, expect, it } from 'vitest';
import { catalog, type Manifest, type Track } from '../lib/manifest';
import { blockSignature, buildOrder, freshOrder, isContiguousByBlock, possibleOrders } from '../lib/order';

const id = (n: number) => n.toString(16).padStart(24, '0');

function manifest(sizes: number[]): Manifest {
  let n = 0;
  const tracks: Track[] = [];
  const blocks = [];
  for (const [b, size] of sizes.entries()) {
    const ids = [];
    for (let i = 0; i < size; i++) {
      const tid = id(++n);
      ids.push(tid);
      tracks.push({ id: tid, composer: 'C', work: `W${b}`, duration: 10 + n, gain: 0 });
    }
    blocks.push({ composer: 'C', work: `W${b}`, tracks: ids });
  }
  return { version: 'v', tracks, blocks };
}

const cat = catalog(manifest([12, 1, 3, 1, 8, 7, 5, 1]));
const all = cat.manifest.tracks.map((t) => t.id);

describe('run order', () => {
  it('plays every excerpt once and keeps blocks together', () => {
    let prev: string[] | null = null;
    for (let i = 0; i < 200; i++) {
      const o = freshOrder(cat, all, prev);
      expect(o).toHaveLength(all.length);
      expect(new Set(o).size).toBe(all.length);
      expect(isContiguousByBlock(cat, o)).toBe(true);
      if (prev) expect(o.join()).not.toBe(prev.join());
      prev = o;
    }
  });

  it('shuffles blocks and excerpts roughly uniformly', () => {
    const small = catalog(manifest([3, 2]));
    const ids = small.manifest.tracks.map((t) => t.id);
    expect(possibleOrders(small, ids)).toBe(2 * 6 * 2);
    const counts = new Map<string, number>();
    const runs = 24_000;
    for (let i = 0; i < runs; i++) {
      const k = buildOrder(small, ids).join();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    expect(counts.size).toBe(24);
    for (const c of counts.values()) expect(Math.abs(c - runs / 24)).toBeLessThan((runs / 24) * 0.15);
  });

  it('selective runs keep only chosen excerpts', () => {
    const chosen = all.slice(0, 13);
    const o = buildOrder(cat, chosen);
    expect(isContiguousByBlock(cat, o)).toBe(true);
    expect(o.sort()).toEqual(chosen.slice().sort());
  });

  it('accepts the only possible order', () => {
    const one = catalog(manifest([1]));
    const ids = one.manifest.tracks.map((t) => t.id);
    expect(freshOrder(one, ids, ids)).toEqual(ids);
  });

  it('signature changes when grouping changes', () => {
    const other = catalog(manifest([13, 3, 1, 8, 7, 5, 1]));
    expect(blockSignature(cat, all)).not.toBe(blockSignature(other, all));
  });
});
