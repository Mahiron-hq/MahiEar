import {
  ChartColumn,
  ChevronRight,
  CloudCheck,
  CloudDownload,
  CloudOff,
  HardDrive,
  ListChecks,
  ListMusic,
  RotateCcw,
  Settings,
} from 'lucide-preact';
import { excerpts, times } from '../lib/format';
import { offline } from '../lib/offline';
import type { RunKind } from '../lib/runs';
import { stats } from '../lib/stats';
import { resumeRun, startRun, unfinished } from '../prep';
import { cat, catalogState, navigate } from '../state';
import { refresh } from '../lib/catalogLoader';
import { Button, ICON } from './common';
import { confirmAsk } from './confirm';

export function startFull(): void {
  const c = cat.value;
  if (!c) return;
  startRun('full', c.manifest.tracks.map((t) => t.id), 'Полный прогон');
}

export async function startSelective(ids: string[], label: string): Promise<void> {
  if (ids.length === 0) return;
  const existing = unfinished('selective');
  if (existing) {
    const ok = await confirmAsk(
      'Заменить выборочный прогон?',
      `Незавершённый выборочный прогон (${existing.pos + 1} из ${existing.order.length}) будет удалён. Полный прогон это не затронет.`,
      'Заменить',
    );
    if (!ok) return;
  }
  startRun('selective', ids, label);
}

function OfflineBadge() {
  const o = offline.value;
  const view =
    o.state === 'done'
      ? { icon: <CloudCheck {...ICON} size={16} />, text: 'Доступно офлайн' }
      : o.state === 'downloading'
        ? { icon: <CloudDownload {...ICON} size={16} />, text: `Загружено ${o.done} из ${o.total}` }
        : o.state === 'waiting'
          ? { icon: <CloudOff {...ICON} size={16} />, text: `Загружено ${o.done} из ${o.total}` }
          : o.state === 'quota'
            ? { icon: <HardDrive {...ICON} size={16} />, text: 'Недостаточно места' }
            : null;
  if (!view) return <span class="offline-badge is-empty" />;
  return (
    <span class={`offline-badge is-${o.state}`} role="status">
      {view.icon}
      {view.text}
    </span>
  );
}

export function Home() {
  const c = cat.value;
  const state = catalogState.value;
  const full = c ? unfinished('full') : null;
  const sel = c ? unfinished('selective') : null;
  const done = stats.value.completedRuns;

  const restart = async (kind: RunKind) => {
    const ok = await confirmAsk('Начать заново?', 'Текущий прогон будет сброшен, порядок отрывков составится заново.', 'Начать заново');
    if (ok && kind === 'full') startFull();
  };

  return (
    <div class="screen home">
      <header class="brand">
        <span class="wordmark">MahiEar</span>
        <OfflineBadge />
      </header>

      <section class="hero">
        <h1 class="hero-title">Подготовка к музыкальной викторине</h1>
        {c ? (
          <p class="hero-meta">
            {excerpts(c.manifest.tracks.length)} · произведений: {c.manifest.blocks.length}
          </p>
        ) : (
          <p class="hero-meta">{state === 'error' ? 'Не удалось загрузить список отрывков' : 'Загрузка…'}</p>
        )}

        <div class="hero-actions">
          {state === 'error' && !c ? (
            <Button variant="primary" size="lg" class="wide" onClick={() => void refresh()}>
              Повторить
            </Button>
          ) : c && c.manifest.tracks.length === 0 ? (
            <p class="empty">Отрывки пока не добавлены.</p>
          ) : full ? (
            <>
              <Button variant="primary" size="lg" class="wide" onClick={() => resumeRun('full', true)}>
                Продолжить<span class="wide-only"> подготовку</span>{' '}
                <span class="nowrap">
                  · {full.pos + 1} из {full.order.length}
                </span>
              </Button>
              <Button variant="ghost" onClick={() => void restart('full')}>
                Начать заново
              </Button>
            </>
          ) : (
            <Button variant="primary" size="lg" class="wide" disabled={!c} onClick={startFull}>
              Начать подготовку
            </Button>
          )}
        </div>
      </section>

      <nav class="menu" aria-label="Разделы">
        <button type="button" class="menu-item" disabled={!c} onClick={() => navigate({ name: 'selective' })}>
          <ListChecks {...ICON} />
          <span class="menu-text">
            <span class="menu-label">Выборочная подготовка</span>
            <span class="menu-hint">Только выбранные композиторы и произведения</span>
          </span>
          <ChevronRight {...ICON} />
        </button>
        {sel && (
          <button type="button" class="menu-item is-sub" onClick={() => resumeRun('selective', true)}>
            <RotateCcw {...ICON} size={18} />
            <span class="menu-text">
              <span class="menu-label">
                Продолжить выборочную{' '}
                <span class="nowrap">
                  · {sel.pos + 1} из {sel.order.length}
                </span>
              </span>
              <span class="menu-hint">{sel.label}</span>
            </span>
            <ChevronRight {...ICON} />
          </button>
        )}
        <button type="button" class="menu-item" disabled={!c} onClick={() => navigate({ name: 'playlist' })}>
          <ListMusic {...ICON} />
          <span class="menu-text">
            <span class="menu-label">Плейлист</span>
            <span class="menu-hint">Все отрывки с названиями</span>
          </span>
          <ChevronRight {...ICON} />
        </button>
        <button type="button" class="menu-item" onClick={() => navigate({ name: 'stats' })}>
          <ChartColumn {...ICON} />
          <span class="menu-text">
            <span class="menu-label">Статистика</span>
            <span class="menu-hint">
              {done > 0 ? `Полный прогон пройден ${times(done)}` : 'Полных прогонов пока нет'}
            </span>
          </span>
          <ChevronRight {...ICON} />
        </button>
        <button type="button" class="menu-item" onClick={() => navigate({ name: 'settings' })}>
          <Settings {...ICON} />
          <span class="menu-text">
            <span class="menu-label">Настройки</span>
          </span>
          <ChevronRight {...ICON} />
        </button>
      </nav>
    </div>
  );
}
