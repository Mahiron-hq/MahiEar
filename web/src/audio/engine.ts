import { signal } from '@preact/signals';
import { reportError } from '../lib/log';

export type Status = 'idle' | 'loading' | 'playing' | 'paused' | 'blocked' | 'failed' | 'offline';
export type Owner = 'prep' | 'playlist';

export interface MediaMeta {
  title: string;
  artist: string;
  album: string;
}

export interface Hooks {
  onEnded(): void;
  onTick(): void;
  onSeeked(position: number): void;
  onNext?(): void;
  onPrev?(): void;
  onFailed?(): void;
}

export interface LoadOptions {
  id: string;
  url: string;
  gainDb: number;
  owner: Owner;
  hooks: Hooks;
  autoplay: boolean;
  loop: boolean;
  meta: MediaMeta;
}

const RETRY_DELAYS = [800, 2000, 4500];
const STALL_MS = 15_000;

type AudioSessionNavigator = Navigator & { audioSession?: { type: string } };

class AudioEngine {
  readonly status = signal<Status>('idle');
  readonly duration = signal(0);
  readonly current = signal<string | null>(null);
  readonly owner = signal<Owner | null>(null);

  private el: HTMLAudioElement | null = null;
  private ctx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private graph: 'none' | 'webaudio' | 'volume' = 'none';
  private token = 0;
  private hooks: Hooks | null = null;
  private opts: LoadOptions | null = null;
  private wantPlay = false;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private stallTimer: ReturnType<typeof setTimeout> | undefined;
  private resumeAt = 0;
  private lastPos = 0;
  private endedToken = -1;
  private normalize = true;
  private volume = 1;
  private silentCheck: ReturnType<typeof setTimeout> | undefined;
  private seekPending = false;

  private audio(): HTMLAudioElement {
    if (this.el) return this.el;
    const el = document.createElement('audio');
    el.preload = 'auto';
    el.setAttribute('playsinline', '');
    el.setAttribute('aria-hidden', 'true');
    el.style.display = 'none';
    document.body.append(el);
    const on = (name: string, fn: () => void) => el.addEventListener(name, fn);
    on('playing', () => this.onPlaying());
    on('pause', () => this.onPause());
    on('waiting', () => this.onWaiting());
    on('stalled', () => this.onWaiting());
    on('timeupdate', () => this.onTime());
    on('seeked', () => {
      if (this.seekPending) {
        this.seekPending = false;
        this.hooks?.onSeeked(el.currentTime);
      }
      this.syncPosition();
    });
    on('ended', () => this.onEnded());
    on('error', () => this.onError());
    on('durationchange', () => this.onDuration());
    on('loadedmetadata', () => this.onDuration());
    window.addEventListener('online', () => {
      if (this.status.value === 'offline') this.reload();
    });
    window.addEventListener('offline', () => {
      if (this.status.value === 'loading' && this.wantPlay) this.goOffline();
    });
    this.installMediaSession();
    this.el = el;
    return el;
  }

  get position(): number {
    return this.el?.currentTime ?? 0;
  }

  get playing(): boolean {
    return this.status.value === 'playing';
  }

  get looping(): boolean {
    return this.el?.loop ?? false;
  }

  load(o: LoadOptions): void {
    const el = this.audio();
    this.token++;
    clearTimeout(this.retryTimer);
    clearTimeout(this.stallTimer);
    this.opts = o;
    this.hooks = o.hooks;
    this.owner.value = o.owner;
    this.current.value = o.id;
    this.attempts = 0;
    this.lastPos = 0;
    this.resumeAt = 0;
    this.wantPlay = o.autoplay;
    this.duration.value = 0;
    el.loop = o.loop;
    this.applyGain(true);
    el.src = o.url;
    el.load();
    this.setMeta(o.meta);
    this.status.value = o.autoplay ? 'loading' : 'paused';
    if (o.autoplay) this.startPlayback();
    this.watchLoading();
  }

  private watchLoading(): void {
    clearTimeout(this.stallTimer);
    const token = this.token;
    this.stallTimer = setTimeout(() => {
      if (token !== this.token || this.status.value !== 'loading' || !this.wantPlay) return;
      if (navigator.onLine === false) this.goOffline();
      else this.onError();
    }, navigator.onLine === false ? 2500 : STALL_MS);
  }

  stop(owner?: Owner): void {
    if (owner && this.owner.value !== owner) return;
    this.token++;
    clearTimeout(this.retryTimer);
    clearTimeout(this.stallTimer);
    this.wantPlay = false;
    this.el?.pause();
    this.status.value = 'idle';
    this.current.value = null;
    this.owner.value = null;
    this.hooks = null;
    this.opts = null;
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
  }

  play(): void {
    if (!this.opts) return;
    this.wantPlay = true;
    if (this.status.value === 'failed') {
      this.retry();
      return;
    }
    if (this.status.value === 'offline') {
      this.reload();
      return;
    }
    if (this.status.value !== 'playing') this.status.value = 'loading';
    this.startPlayback();
  }

  pause(): void {
    this.wantPlay = false;
    clearTimeout(this.stallTimer);
    this.el?.pause();
    if (this.opts && this.status.value !== 'failed' && this.status.value !== 'offline') this.status.value = 'paused';
  }

  toggle(): void {
    if (this.wantPlay && this.status.value !== 'blocked') this.pause();
    else this.play();
  }

  seek(t: number): void {
    const el = this.el;
    if (!el || !this.opts) return;
    const d = this.duration.value || el.duration || 0;
    const target = Math.max(0, d > 0 ? Math.min(t, d - 0.05) : t);
    this.seekPending = true;
    el.currentTime = target;
    this.lastPos = target;
    this.hooks?.onSeeked(target);
  }

  setLoop(on: boolean): void {
    if (this.el) this.el.loop = on;
  }

  retry(): void {
    this.attempts = 0;
    this.wantPlay = true;
    this.reload();
  }

  setNormalize(on: boolean): void {
    this.normalize = on;
    this.applyGain(false);
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    this.applyGain(false);
  }

  setMeta(meta: MediaMeta): void {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        ...meta,
        artwork: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      });
    } catch (e) {
      reportError(e, 'mediaSession.metadata');
    }
  }

  private startPlayback(): void {
    const el = this.audio();
    this.ensureGraph();
    const token = this.token;
    if (this.ctx && this.ctx.state !== 'running') void this.ctx.resume().catch(() => undefined);
    let p: Promise<void> | undefined;
    try {
      p = el.play();
    } catch (e) {
      this.playRejected(e, token);
      return;
    }
    p?.catch((e: unknown) => this.playRejected(e, token));
  }

  private playRejected(e: unknown, token: number): void {
    if (token !== this.token) return;
    const name = e instanceof DOMException ? e.name : '';
    if (name === 'AbortError') return;
    if (name === 'NotAllowedError') {
      this.wantPlay = false;
      this.status.value = 'blocked';
      return;
    }
    if (name === 'NotSupportedError') return;
    reportError(e, 'audio.play');
  }

  private ensureGraph(): void {
    if (this.graph !== 'none' || !this.el) return;
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      this.graph = 'volume';
      this.applyGain(true);
      return;
    }
    try {
      const nav = navigator as AudioSessionNavigator;
      // iOS mutes web audio on a locked screen without this
      if (nav.audioSession) nav.audioSession.type = 'playback';
      const ctx = new Ctor({ latencyHint: 'playback' });
      const source = ctx.createMediaElementSource(this.el);
      const gain = ctx.createGain();
      source.connect(gain).connect(ctx.destination);
      this.ctx = ctx;
      this.gainNode = gain;
      this.graph = 'webaudio';
      ctx.addEventListener('statechange', () => {
        if (ctx.state !== 'running' && this.wantPlay && this.status.value === 'playing') void ctx.resume().catch(() => undefined);
      });
    } catch (e) {
      reportError(e, 'audio.graph');
      this.graph = 'volume';
    }
    this.applyGain(true);
  }

  private applyGain(immediate: boolean): void {
    const db = this.normalize && this.opts ? this.opts.gainDb : 0;
    const target = 10 ** (db / 20) * this.volume;
    if (this.graph === 'webaudio' && this.gainNode && this.ctx) {
      const g = this.gainNode.gain;
      const now = this.ctx.currentTime;
      g.cancelScheduledValues(now);
      if (immediate || this.ctx.state !== 'running') g.setValueAtTime(target, now);
      else {
        g.setValueAtTime(g.value, now);
        g.setTargetAtTime(target, now, 0.02);
      }
      if (this.el) this.el.volume = 1;
    } else if (this.el) {
      this.el.volume = Math.min(1, target);
    }
  }

  private reload(): void {
    const el = this.el;
    const o = this.opts;
    if (!el || !o) return;
    clearTimeout(this.retryTimer);
    clearTimeout(this.stallTimer);
    this.token++;
    const token = this.token;
    this.resumeAt = this.lastPos;
    this.status.value = 'loading';
    el.src = o.url;
    el.load();
    if (this.wantPlay) {
      this.startPlayback();
      this.watchLoading();
    } else
      el.addEventListener(
        'loadedmetadata',
        () => {
          if (token === this.token && this.status.value === 'loading') this.status.value = 'paused';
        },
        { once: true },
      );
  }

  private onDuration(): void {
    const el = this.el;
    if (!el) return;
    if (Number.isFinite(el.duration) && el.duration > 0) this.duration.value = el.duration;
    if (this.resumeAt > 0 && el.readyState >= 1) {
      const t = this.resumeAt;
      this.resumeAt = 0;
      this.seekPending = true;
      el.currentTime = t;
    }
    this.syncPosition();
  }

  private onPlaying(): void {
    clearTimeout(this.stallTimer);
    if (!this.wantPlay) {
      this.el?.pause();
      return;
    }
    this.status.value = 'playing';
    this.attempts = 0;
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    this.syncPosition();
    this.checkSilent();
  }

  private checkSilent(): void {
    clearTimeout(this.silentCheck);
    const ctx = this.ctx;
    if (!ctx) return;
    this.silentCheck = setTimeout(() => {
      if (ctx.state !== 'running' && this.status.value === 'playing') {
        this.el?.pause();
        this.wantPlay = false;
        this.status.value = 'blocked';
      }
    }, 1200);
  }

  private onPause(): void {
    const el = this.el;
    if (!el) return;
    if (el.ended && !el.loop) {
      this.onEnded();
      return;
    }
    if (this.status.value === 'loading' && this.wantPlay) return;
    if (this.status.value === 'failed' || this.status.value === 'offline' || this.status.value === 'idle') return;
    this.wantPlay = false;
    this.status.value = 'paused';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    this.syncPosition();
  }

  private onWaiting(): void {
    if (!this.wantPlay || !this.opts) return;
    if (this.status.value === 'playing') this.status.value = 'loading';
    if (navigator.onLine === false && this.status.value === 'loading') {
      this.goOffline();
      return;
    }
    clearTimeout(this.stallTimer);
    const token = this.token;
    this.stallTimer = setTimeout(() => {
      if (token === this.token && this.status.value === 'loading') this.onError();
    }, STALL_MS);
  }

  private goOffline(): void {
    clearTimeout(this.stallTimer);
    this.lastPos = this.el?.currentTime ?? this.lastPos;
    this.status.value = 'offline';
  }

  private onTime(): void {
    const el = this.el;
    if (!el) return;
    if (this.resumeAt === 0) this.lastPos = el.currentTime;
    if (this.status.value === 'loading' && !el.paused && el.readyState >= 3) this.status.value = 'playing';
    this.hooks?.onTick();
  }

  private onEnded(): void {
    if (this.endedToken === this.token) return;
    this.endedToken = this.token;
    this.hooks?.onEnded();
  }

  private onError(): void {
    const el = this.el;
    if (!el || !this.opts || !el.getAttribute('src')) return;
    clearTimeout(this.stallTimer);
    if (navigator.onLine === false) {
      this.goOffline();
      return;
    }
    if (this.status.value === 'failed') return;
    this.attempts++;
    if (this.attempts <= RETRY_DELAYS.length) {
      const token = this.token;
      this.status.value = 'loading';
      this.retryTimer = setTimeout(() => {
        if (token === this.token) this.reload();
      }, RETRY_DELAYS[this.attempts - 1]);
      return;
    }
    this.status.value = 'failed';
    const code = el.error?.code ?? 0;
    reportError(new Error(`audio failed, code ${code}`), 'audio.load');
    this.hooks?.onFailed?.();
  }

  private syncPosition(): void {
    const el = this.el;
    if (!el || !('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    const d = this.duration.value;
    if (!(d > 0)) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: d,
        position: Math.min(d, Math.max(0, el.currentTime)),
        playbackRate: 1,
      });
    } catch {
      return;
    }
  }

  private installMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (action: MediaSessionAction, fn: MediaSessionActionHandler) => {
      try {
        ms.setActionHandler(action, fn);
      } catch {
        return;
      }
    };
    set('play', () => this.play());
    set('pause', () => this.pause());
    set('stop', () => this.pause());
    set('nexttrack', () => this.hooks?.onNext?.());
    set('previoustrack', () => this.hooks?.onPrev?.());
    set('seekto', (d) => {
      if (typeof d.seekTime === 'number') this.seek(d.seekTime);
    });
    set('seekbackward', (d) => this.seek(this.position - (d.seekOffset ?? 10)));
    set('seekforward', (d) => this.seek(this.position + (d.seekOffset ?? 10)));
  }
}

export const engine = new AudioEngine();
