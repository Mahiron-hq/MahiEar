export class PlayClock {
  elapsed = 0;
  private last: number | null = null;
  private wall = 0;

  reset(): void {
    this.elapsed = 0;
    this.last = null;
  }

  sample(position: number, playing: boolean, now: number, duration: number): void {
    if (playing && this.last !== null) {
      const wallDelta = (now - this.wall) / 1000;
      let d = position - this.last;
      if (d < -0.5 && duration > 0) d = Math.max(0, duration - this.last) + position;
      if (d > 0 && d <= wallDelta + 0.75) this.elapsed += d;
    }
    this.last = position;
    this.wall = now;
  }

  seeked(position: number, now: number): void {
    this.last = position;
    this.wall = now;
  }

  pause(position: number, now: number): void {
    this.last = position;
    this.wall = now;
  }
}
