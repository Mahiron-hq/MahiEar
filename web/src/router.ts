import { engine } from './audio/engine';
import { parseRoute, type Route } from './lib/routes';
import { select } from './playlist';
import { leave, resumeRun, run, startRun, unfinished } from './prep';
import { cat, followHistory, navigate, savedScreen, screen } from './state';

export function openRoute(r: Route, replace = false): void {
  const c = cat.value;
  switch (r.name) {
    case 'prep': {
      if (screen.value.name === 'prep' && run.value?.kind === r.kind && engine.owner.value === 'prep') {
        navigate(r, true);
        return;
      }
      if (resumeRun(r.kind, false, replace)) return;
      if (r.kind === 'full' && c && c.manifest.tracks.length > 0) {
        startRun('full', c.manifest.tracks.map((t) => t.id), 'Полный прогон', false, replace);
        return;
      }
      navigate(r.kind === 'selective' ? { name: 'selective' } : { name: 'home' }, true);
      return;
    }
    case 'finish':
      if (!resumeRun(r.kind, false, true)) navigate({ name: 'home' }, true);
      return;
    case 'playlist':
      if (r.track && c && !c.byId.has(r.track)) {
        navigate({ name: 'notfound' }, true);
        return;
      }
      navigate(r, replace);
      if (r.track) select(r.track);
      return;
    default:
      navigate(r, replace);
  }
}

function standalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

let started = false;

export function openInitialRoute(): void {
  if (started) return;
  started = true;
  let r = screen.value;
  if (r.name === 'home' && standalone()) {
    const s = savedScreen();
    if (s && s.name === 'prep' && unfinished(s.kind)) r = s;
  }
  openRoute(r, true);
}

export function installHistory(): void {
  window.addEventListener('popstate', () => {
    followHistory(() => {
      const r = parseRoute(location.pathname);
      if (screen.value.name === 'prep' && r.name !== 'prep') leave(false);
      openRoute(r, true);
    });
  });
}
