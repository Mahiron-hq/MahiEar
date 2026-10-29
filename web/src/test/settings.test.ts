import { describe, expect, it } from 'vitest';
import { advanceBounds, DEFAULTS, parseSettings, reconcile } from '../lib/settings';

describe('settings', () => {
  it('computes N bounds from delay and longest excerpt', () => {
    expect(advanceBounds(8, 58.86)).toEqual({ min: 12, max: 58, available: true });
    expect(advanceBounds(15, 58.86)).toEqual({ min: 18, max: 58, available: true });
    expect(advanceBounds(15, 16).available).toBe(false);
  });

  it('raises N when the delay grows', () => {
    const r = reconcile({ ...DEFAULTS, autoAdvance: 'after', advanceAfter: 12, revealDelay: 14 }, 58);
    expect(r.settings.advanceAfter).toBe(17);
    expect(r.raisedTo).toBe(17);
  });

  it('switches off the N mode when it cannot work', () => {
    const r = reconcile({ ...DEFAULTS, autoAdvance: 'after', advanceAfter: 12 }, 10);
    expect(r.settings.autoAdvance).toBe('off');
  });

  it('caps N at the longest excerpt', () => {
    expect(reconcile({ ...DEFAULTS, advanceAfter: 90 }, 40).settings.advanceAfter).toBe(40);
  });

  it('rejects invalid stored values', () => {
    expect(parseSettings(DEFAULTS)).toEqual(DEFAULTS);
    expect(parseSettings({ ...DEFAULTS, revealDelay: 16 })).toBeNull();
    expect(parseSettings({ ...DEFAULTS, revealDelay: 2.5 })).toBeNull();
    expect(parseSettings({ ...DEFAULTS, autoAdvance: 'sometimes' })).toBeNull();
    expect(parseSettings('garbage')).toBeNull();
  });
});
