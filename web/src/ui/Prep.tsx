import { ArrowLeft, ArrowRight, Check, Pause, Play, RotateCcw, X } from 'lucide-preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { engine } from '../audio/engine';
import { keyboardMode } from './focus';
import { answer, back, currentTrack, elapsed, leave, next, retryCurrent, reveal, revealed, run, skip } from '../prep';
import { catalogState, settings } from '../state';
import { Button, ICON, IconButton, Seekbar, TopBar } from './common';
import { KeysButton } from './Keys';

export function Prep() {
  const r = run.value;
  const track = currentTrack.value;
  const shown = revealed.value;
  const stageRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!keyboardMode() || (document.activeElement && document.activeElement !== document.body)) return;
    const root = stageRef.current?.closest('.prep');
    const target =
      root?.querySelector<HTMLElement>(shown ? '.nav-forward' : '.reveal-btn') ?? root?.querySelector<HTMLElement>('.play-btn');
    target?.focus();
  }, [shown, r?.pos]);
  if (!r || !track) {
    return (
      <div class="screen">
        <TopBar onBack={leave} />
        {catalogState.value !== 'loading' && <p class="empty">Прогон не найден.</p>}
      </div>
    );
  }
  const status = engine.owner.value === 'prep' ? engine.status.value : 'paused';
  const isPlaying = status === 'playing' || status === 'loading';
  const delay = settings.value.revealDelay;
  const left = Math.max(0, delay - elapsed.value);
  const ans = r.answers[track.id];
  const first = r.pos === 0;

  return (
    <div class="screen prep">
      <TopBar
        onBack={leave}
        right={
          <>
            <span class="counter tabular" aria-label={`Отрывок ${r.pos + 1} из ${r.order.length}`}>
              {r.pos + 1} из {r.order.length}
            </span>
            <KeysButton mode="prep" />
          </>
        }
      />
      <h1 class="sr-only">Подготовка</h1>
      {r.kind === 'selective' && <p class="prep-kind">{r.label}</p>}

      <section class="stage" aria-live="polite" ref={stageRef}>
        {status === 'failed' ? (
          <div class="stage-problem" role="alert">
            <p class="problem-title">Отрывок не загрузился</p>
            <p class="problem-text">Проверьте соединение. Можно повторить загрузку или пропустить отрывок.</p>
            <div class="problem-actions">
              <Button variant="primary" onClick={retryCurrent}>
                <RotateCcw {...ICON} /> Повторить
              </Button>
              <Button onClick={skip}>Пропустить</Button>
            </div>
          </div>
        ) : shown ? (
          <div class="title reveal-in" key={`${r.pos}-shown`}>
            <p class="title-composer">{track.composer}</p>
            <h2 class="title-work">{track.work}</h2>
            {track.part && <p class="title-part">{track.part}</p>}
            {track.section && <p class="title-section">{track.section}</p>}
          </div>
        ) : (
          <div class="hidden-title" key={`${r.pos}-hidden`}>
            <p class="hidden-label">
              {status === 'offline'
                ? 'Нет сети. Звук продолжится, когда связь вернётся'
                : status === 'blocked'
                  ? 'Нажмите «Воспроизвести», чтобы начать'
                  : 'Узнаёте?'}
            </p>
            <div
              class="countdown"
              role="progressbar"
              aria-label="Время до показа названия"
              aria-valuemin={0}
              aria-valuemax={delay}
              aria-valuenow={Math.ceil(left)}
              aria-valuetext={`${Math.ceil(left)} с`}
            >
              <div class="countdown-fill" style={{ transform: `scaleX(${delay > 0 ? left / delay : 0})` }} />
            </div>
            <Button variant="ghost" class="reveal-btn" onClick={reveal}>
              Показать название
            </Button>
          </div>
        )}
        {status === 'offline' && shown && <p class="stage-note">Нет сети. Звук продолжится, когда связь вернётся</p>}
      </section>

      <div class={`selfcheck ${shown ? '' : 'is-reserved'}`} aria-hidden={!shown}>
        <span class="selfcheck-label">Узнали?</span>
        <div class="selfcheck-buttons" role="group" aria-label="Самопроверка">
          <button
            type="button"
            class={`chip ${ans === 'knew' ? 'is-on' : ''}`}
            aria-pressed={ans === 'knew'}
            tabIndex={shown ? 0 : -1}
            onClick={() => answer('knew')}
          >
            <Check {...ICON} size={18} /> Знал
          </button>
          <button
            type="button"
            class={`chip ${ans === 'didnt' ? 'is-on is-miss' : ''}`}
            aria-pressed={ans === 'didnt'}
            tabIndex={shown ? 0 : -1}
            onClick={() => answer('didnt')}
          >
            <X {...ICON} size={18} /> Не знал
          </button>
        </div>
      </div>

      <div class="dock">
        <Seekbar fallbackDuration={track.duration} />
        <div class="transport">
          <div class="transport-side">
            {!first && (
              <Button variant="quiet" class="nav-btn" onClick={back}>
                <ArrowLeft {...ICON} /> Назад
              </Button>
            )}
          </div>
          <IconButton
            class={`play-btn ${status === 'blocked' ? 'is-attention' : ''}`}
            label={isPlaying ? 'Пауза' : 'Воспроизвести'}
            onClick={() => engine.toggle()}
          >
            {isPlaying ? <Pause {...ICON} size={28} /> : <Play {...ICON} size={28} />}
          </IconButton>
          <div class="transport-side is-end">
            {shown && (
              <Button variant="quiet" class="nav-btn nav-forward" onClick={next}>
                {r.pos === r.order.length - 1 ? 'Завершить' : 'Вперёд'} <ArrowRight {...ICON} />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
