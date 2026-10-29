import '@fontsource-variable/inter/wght.css';
import './styles.css';
import { effect } from '@preact/signals';
import { render } from 'preact';
import { engine } from './audio/engine';
import { applyPendingIfSafe, initCatalog } from './lib/catalogLoader';
import { initQueue, setQueueActive } from './lib/events';
import { installGlobalHandlers, reportError } from './lib/log';
import type { Manifest } from './lib/manifest';
import { syncOffline } from './lib/offline';
import { dropRun, loadRun, rebase, saveRun, stillValid, type RunKind } from './lib/runs';
import { setWritable, storageProblem } from './lib/storage';
import { initStats, pruneStats } from './lib/stats';
import { initTabs, passive } from './lib/tabs';
import { initPlaylist, resetPlaylist } from './playlist';
import { leave, onBackground, resumeRun, run } from './prep';
import { initServiceWorker } from './pwa';
import { cat, initSettings, navigate, notice, savedScreen, screen, settings, toast } from './state';
import { App } from './ui/App';
import { focusScreen, trackInputMode } from './ui/focus';

installGlobalHandlers();
trackInputMode();

if (initSettings() === 'reset')
  notice('Настройки сброшены', 'Сохранённые настройки оказались повреждены, поэтому восстановлены значения по умолчанию.');
if (initStats() === 'reset')
  notice('Статистика сброшена', 'Сохранённая статистика оказалась повреждена и была очищена. Настройки сохранены.');
initPlaylist();

function checkRuns(next: Manifest): void {
  const c = cat.value;
  if (!c) return;
  for (const kind of ['full', 'selective'] as RunKind[]) {
    const l = loadRun(kind);
    if (l.status === 'corrupt') {
      dropRun(kind);
      notice(
        'Прогон не удалось восстановить',
        'Сохранённые данные прогона повреждены. Начните новый прогон: статистика и настройки сохранены.',
      );
    } else if (l.status === 'ok') {
      if (!stillValid(l.value, c)) {
        dropRun(kind);
        if (!l.value.finished)
          notice(
            'Набор отрывков изменился',
            'Незавершённый прогон больше не совпадает с набором. Начните новый: статистика по сохранившимся отрывкам осталась.',
          );
      } else if (l.value.set !== next.version) saveRun(rebase(l.value, c));
    }
  }
}

let restored = false;

function onCatalog(prev: Manifest | null, next: Manifest): void {
  checkRuns(next);
  if (prev) {
    pruneStats(new Set(next.tracks.map((t) => t.id)));
    resetPlaylist();
    if (prev.version !== next.version) toast('Набор отрывков обновлён');
  }
  if (!restored) {
    restored = true;
    const s = savedScreen();
    if (s && (s.name === 'prep' || s.name === 'finish')) {
      if (!resumeRun(s.kind, false)) navigate({ name: 'home' }, true);
    } else if (s && s.name !== 'home') navigate(s, true);
  }
}

effect(() => {
  const p = storageProblem.value;
  if (p === 'unavailable')
    toast('Браузер не разрешает сохранять данные: прогресс и статистика не сохранятся после закрытия страницы', 8000);
  else if (p === 'full') toast('Память браузера заполнена: изменения больше не сохраняются', 8000);
});

let lastOffline: boolean | null = null;
effect(() => {
  const on = settings.value.offline;
  const c = cat.value;
  if (!c || lastOffline === null) {
    lastOffline = on;
    return;
  }
  if (on !== lastOffline) {
    lastOffline = on;
    void syncOffline(c, on);
  }
});

effect(() => {
  const s = screen.value.name;
  if (s === 'home' || s === 'settings' || s === 'stats' || s === 'selective') applyPendingIfSafe();
  if (s !== 'prep') focusScreen();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (!settings.value.background && engine.playing) engine.pause();
    onBackground();
  } else onBackground();
});

window.addEventListener('popstate', (ev) => {
  const target = (ev.state as { s?: string } | null)?.s;
  const s = screen.value.name;
  if (target === 'playlist' || target === 'settings' || target === 'stats' || target === 'selective') {
    if (s === 'prep') leave();
    navigate({ name: target }, true);
    return;
  }
  if (s === 'prep') leave();
  else if (s !== 'home') navigate({ name: 'home' }, true);
});

const root = document.getElementById('app');
if (root) {
  root.textContent = '';
  render(<App />, root);
}

void initTabs(() => {
  engine.stop();
  setWritable(false);
  setQueueActive(false);
  run.value = null;
}).then(() => {
  if (passive.value) {
    setWritable(false);
    setQueueActive(false);
  }
});

initQueue();
try {
  initCatalog(onCatalog);
} catch (e) {
  reportError(e, 'catalog.init');
}
initServiceWorker();
