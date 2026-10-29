import { describe, expect, it } from 'vitest';
import { catalog, parseManifest } from '../lib/manifest';
import { createRun, parseRun, stillValid, summarize } from '../lib/runs';
import { parseStats } from '../lib/stats';

const id = (n: number) => n.toString(16).padStart(24, '0');
const raw = {
  version: 'a1',
  tracks: [
    { id: id(1), composer: 'Вебер', work: 'Вольный стрелок', part: 'Увертюра', duration: 30, gain: 1.5 },
    { id: id(2), composer: 'Вебер', work: 'Вольный стрелок', duration: 20, gain: -2 },
    { id: id(3), composer: 'Шуберт', work: 'Липа', duration: 40, gain: 0 },
  ],
  blocks: [
    { composer: 'Вебер', work: 'Вольный стрелок', tracks: [id(1), id(2)] },
    { composer: 'Шуберт', work: 'Липа', tracks: [id(3)] },
  ],
};

const base = () => catalog(parseManifest(raw)!);

describe('stored data', () => {
  it('validates manifests', () => {
    expect(parseManifest(raw)).not.toBeNull();
    expect(parseManifest({ ...raw, tracks: [{ ...raw.tracks[0], id: '../x' }] })).toBeNull();
    expect(parseManifest({ ...raw, blocks: raw.blocks.slice(0, 1) })).toBeNull();
    expect(parseManifest(null)).toBeNull();
  });

  it('round-trips runs and rejects damaged ones', () => {
    const cat = base();
    const run = createRun(cat, 'full', cat.manifest.tracks.map((t) => t.id), 'Полный прогон');
    expect(parseRun(JSON.parse(JSON.stringify(run)))).toEqual(run);
    expect(parseRun({ ...run, pos: 3 })).toBeNull();
    expect(parseRun({ ...run, order: [id(1), id(1), id(2)] })).toBeNull();
    expect(parseRun({ ...run, answers: { [id(9)]: 'knew' } })).toBeNull();
    expect(parseRun({ ...run, revealed: [true] })).toBeNull();
  });

  it('detects runs broken by a new set', () => {
    const cat = base();
    const run = createRun(cat, 'full', cat.manifest.tracks.map((t) => t.id), 'x');
    const regained = catalog(parseManifest({ ...raw, version: 'a2', tracks: raw.tracks.map((t) => ({ ...t, gain: 0 })) })!);
    expect(stillValid(run, regained)).toBe(true);
    const shrunk = catalog(
      parseManifest({
        ...raw,
        version: 'a3',
        tracks: raw.tracks.slice(1),
        blocks: [{ ...raw.blocks[0]!, tracks: [id(2)] }, raw.blocks[1]!],
      })!,
    );
    expect(stillValid(run, shrunk)).toBe(false);
  });

  it('summarizes answers', () => {
    const cat = base();
    const run = createRun(cat, 'full', [id(1), id(2), id(3)], 'x');
    const s = summarize({ ...run, answers: { [id(1)]: 'knew', [id(2)]: 'didnt' }, skipped: [id(3)] });
    expect(s).toEqual({ knew: [id(1)], didnt: [id(2)], unanswered: [], skipped: [id(3)] });
  });

  it('validates stats', () => {
    expect(parseStats({ v: 1, completedRuns: 2, tracks: { a: { knew: 1, didnt: 0, last: 'knew' } } })).not.toBeNull();
    expect(parseStats({ v: 1, completedRuns: -1, tracks: {} })).toBeNull();
    expect(parseStats({ v: 1, completedRuns: 0, tracks: { a: { knew: 1, didnt: 0, last: 'maybe' } } })).toBeNull();
  });
});
