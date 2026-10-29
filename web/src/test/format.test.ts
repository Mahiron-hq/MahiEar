import { describe, expect, it } from 'vitest';
import { clock, excerpts, searchKey, times } from '../lib/format';

describe('format', () => {
  it('formats mm:ss', () => {
    expect(clock(0)).toBe('00:00');
    expect(clock(58.9)).toBe('00:58');
    expect(clock(125)).toBe('02:05');
    expect(clock(NaN)).toBe('00:00');
  });

  it('declines Russian nouns', () => {
    expect(excerpts(1)).toBe('1 отрывок');
    expect(excerpts(3)).toBe('3 отрывка');
    expect(excerpts(38)).toBe('38 отрывков');
    expect(excerpts(11)).toBe('11 отрывков');
    expect(times(22)).toBe('22 раза');
  });

  it('normalizes search text', () => {
    expect(searchKey('Ребёнка')).toBe(searchKey('ребенка'));
    expect(searchKey('Der Müller')).toContain('muller');
    expect(searchKey('Jägervergnügen')).toBe('jagervergnugen');
    expect(searchKey('Straße')).toBe('strasse');
  });
});
