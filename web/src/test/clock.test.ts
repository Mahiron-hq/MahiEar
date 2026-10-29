import { describe, expect, it } from 'vitest';
import { PlayClock } from '../audio/clock';

describe('play clock', () => {
  it('counts only real playback', () => {
    const c = new PlayClock();
    c.sample(0, true, 0, 10);
    c.sample(1, true, 1000, 10);
    c.sample(1, false, 5000, 10);
    c.sample(1, true, 6000, 10);
    c.sample(1.25, true, 6250, 10);
    expect(c.elapsed).toBeCloseTo(1.25);
  });

  it('ignores seeks', () => {
    const c = new PlayClock();
    c.sample(0, true, 0, 30);
    c.sample(0.5, true, 500, 30);
    c.seeked(20, 600);
    c.sample(20.25, true, 850, 30);
    expect(c.elapsed).toBeCloseTo(0.75);
  });

  it('keeps counting across a loop', () => {
    const c = new PlayClock();
    c.sample(9.8, true, 0, 10);
    c.sample(0.2, true, 400, 10);
    expect(c.elapsed).toBeCloseTo(0.4);
  });

  it('does not run faster than wall time', () => {
    const c = new PlayClock();
    c.sample(0, true, 0, 60);
    c.sample(30, true, 250, 60);
    expect(c.elapsed).toBe(0);
  });
});
