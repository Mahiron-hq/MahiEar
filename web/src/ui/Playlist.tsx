import { useMemo, useState } from 'preact/hooks';
import {
  ChevronDown,
  Pause,
  Play,
  Repeat,
  Repeat1,
  RotateCcw,
  Search,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from 'lucide-preact';
import { engine } from '../audio/engine';
import { clock, searchKey } from '../lib/format';
import type { Track } from '../lib/manifest';
import * as pl from '../playlist';
import { cat, navigate, settings, updateSettings } from '../state';
import { ICON, IconButton, Seekbar, TopBar } from './common';
import { Footer } from './Footer';
import { KeysButton } from './Keys';

interface Group {
  composer: string;
  works: { work: string; tracks: Track[] }[];
}

function rest(t: Track): string {
  return [t.part, t.section].filter(Boolean).join(' · ');
}

export function Playlist() {
  const c = cat.value;
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const index = useMemo(
    () => new Map((c?.manifest.tracks ?? []).map((t) => [t.id, searchKey([t.composer, t.work, t.part, t.section].join(' '))])),
    [c],
  );

  const groups = useMemo<Group[]>(() => {
    const q = searchKey(query);
    const words = q ? q.split(' ') : [];
    const out: Group[] = [];
    for (const b of c?.manifest.blocks ?? []) {
      const tracks = b.tracks
        .map((id) => c!.byId.get(id)!)
        .filter((t) => words.every((w) => index.get(t.id)!.includes(w)));
      if (tracks.length === 0) continue;
      let g = out.find((x) => x.composer === b.composer);
      if (!g) out.push((g = { composer: b.composer, works: [] }));
      g.works.push({ work: b.work, tracks });
    }
    return out;
  }, [c, query, index]);

  const cur = pl.current.value;
  const mine = engine.owner.value === 'playlist';
  const status = mine ? engine.status.value : 'paused';
  const playing = mine && (status === 'playing' || status === 'loading');
  const curTrack = cur ? c?.byId.get(cur) : undefined;
  const searching = query.trim().length > 0;
  const vol = settings.value.volume;

  const toggleGroup = (k: string) => {
    const n = new Set(collapsed);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    setCollapsed(n);
  };

  return (
    <div class="screen playlist">
      <TopBar title="Плейлист" onBack={() => navigate({ name: 'home' })} right={<KeysButton mode="playlist" />} />
      <div class="pl-layout">
        <div class="pl-list">
          <label class="search">
            <Search {...ICON} size={18} />
            <input
              type="search"
              placeholder="Поиск по названию"
              aria-label="Поиск по названию"
              value={query}
              onInput={(e) => setQuery(e.currentTarget.value)}
              enterKeyHint="search"
              autocomplete="off"
              spellcheck={false}
            />
            {query && (
              <IconButton label="Очистить поиск" class="search-clear" onClick={() => setQuery('')}>
                <X {...ICON} size={18} />
              </IconButton>
            )}
          </label>

          {groups.length === 0 && <p class="empty">Ничего не найдено</p>}
          {groups.map((g) => (
            <section class="pl-composer" key={g.composer}>
              <h2 class="pl-composer-name">{g.composer}</h2>
              {g.works.map((w) => {
                const key = `${g.composer}/${w.work}`;
                const open = searching || !collapsed.has(key);
                return (
                  <div class="pl-work" key={key}>
                    <button type="button" class="pl-work-head" aria-expanded={open} onClick={() => toggleGroup(key)}>
                      <span class="pl-work-name">{w.work}</span>
                      <span class="pl-work-count tabular">{w.tracks.length}</span>
                      <ChevronDown {...ICON} size={18} class={`chev ${open ? 'is-open' : ''}`} />
                    </button>
                    <div class={`collapse ${open ? 'is-open' : ''}`} inert={!open || undefined}>
                      <ul class="pl-tracks">
                        {w.tracks.map((t) => {
                          const isCur = t.id === cur;
                          return (
                            <li key={t.id}>
                              <button
                                type="button"
                                class={`pl-track ${isCur ? 'is-current' : ''}`}
                                aria-current={isCur ? 'true' : undefined}
                                onClick={() => pl.playTrack(t.id)}
                              >
                                <span class="pl-track-icon" aria-hidden="true">
                                  {isCur && playing ? <Pause {...ICON} size={16} /> : <Play {...ICON} size={16} />}
                                </span>
                                <span class="pl-track-name">{rest(t) || w.work}</span>
                                <span class="pl-track-time tabular">{clock(t.duration)}</span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  </div>
                );
              })}
            </section>
          ))}
          <Footer />
        </div>

        <div class="player" role="region" aria-label="Плеер">
          <div class="player-now">
            {curTrack ? (
              <>
                <p class="player-composer">{curTrack.composer}</p>
                <p class="player-work">{curTrack.work}</p>
                {rest(curTrack) && <p class="player-rest">{rest(curTrack)}</p>}
              </>
            ) : (
              <p class="player-work muted">Выберите отрывок</p>
            )}
            {mine && status === 'failed' && (
              <p class="player-problem" role="alert">
                Не удалось загрузить.{' '}
                <button type="button" class="link" onClick={() => engine.retry()}>
                  <RotateCcw {...ICON} size={14} /> Повторить
                </button>
              </p>
            )}
            {mine && status === 'offline' && <p class="player-problem">Нет сети, звук продолжится сам</p>}
          </div>
          <Seekbar fallbackDuration={curTrack?.duration ?? 0} />
          <div class="player-controls">
            <IconButton
              label="Перемешать"
              class={`toggle ${pl.shuffleOn.value ? 'is-on' : ''}`}
              aria-pressed={pl.shuffleOn.value}
              onClick={() => pl.setShuffle(!pl.shuffleOn.value)}
            >
              <Shuffle {...ICON} />
            </IconButton>
            <IconButton label="Предыдущий" onClick={pl.previous}>
              <SkipBack {...ICON} />
            </IconButton>
            <IconButton class="play-btn" label={playing ? 'Пауза' : 'Воспроизвести'} onClick={pl.toggle}>
              {playing ? <Pause {...ICON} size={28} /> : <Play {...ICON} size={28} />}
            </IconButton>
            <IconButton label="Следующий" onClick={() => pl.advance(true)}>
              <SkipForward {...ICON} />
            </IconButton>
            <IconButton
              label={pl.repeat.value === 'off' ? 'Повтор выключен' : pl.repeat.value === 'all' ? 'Повтор списка' : 'Повтор трека'}
              class={`toggle ${pl.repeat.value !== 'off' ? 'is-on' : ''}`}
              onClick={pl.cycleRepeat}
            >
              {pl.repeat.value === 'one' ? <Repeat1 {...ICON} /> : <Repeat {...ICON} />}
            </IconButton>
          </div>
          <div class="volume">
            <IconButton label={vol === 0 ? 'Включить звук' : 'Выключить звук'} onClick={() => updateSettings({ volume: vol === 0 ? 1 : 0 })}>
              {vol === 0 ? <VolumeX {...ICON} size={18} /> : vol < 0.5 ? <Volume1 {...ICON} size={18} /> : <Volume2 {...ICON} size={18} />}
            </IconButton>
            <input
              type="range"
              class="volume-range"
              min={0}
              max={100}
              step={1}
              value={Math.round(vol * 100)}
              aria-label="Громкость"
              aria-valuetext={`${Math.round(vol * 100)} %`}
              onInput={(e) => updateSettings({ volume: Number(e.currentTarget.value) / 100 })}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
