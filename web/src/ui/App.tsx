import { useEffect } from 'preact/hooks';
import { passive, takeOver } from '../lib/tabs';
import { dismissNotice, navigate, notices, screen, toasts } from '../state';
import { leave } from '../prep';
import { Boundary, Button, Dialog } from './common';
import { ConfirmHost } from './confirm';
import { Finish } from './Finish';
import { Home } from './Home';
import { KeysHelp, onKeyDown } from './Keys';
import { Playlist } from './Playlist';
import { Prep } from './Prep';
import { Selective } from './Selective';
import { SettingsScreen } from './Settings';
import { Stats } from './Stats';

function Current() {
  const s = screen.value;
  switch (s.name) {
    case 'prep':
      return <Prep />;
    case 'finish':
      return <Finish kind={s.kind} />;
    case 'selective':
      return <Selective />;
    case 'playlist':
      return <Playlist />;
    case 'settings':
      return <SettingsScreen />;
    case 'stats':
      return <Stats />;
    default:
      return <Home />;
  }
}

function goHome(): void {
  if (screen.value.name === 'prep') leave();
  else navigate({ name: 'home' });
}

export function App() {
  useEffect(() => {
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const s = screen.value;
  const n = notices.value[0];
  return (
    <>
      <main class={`app is-${s.name}`} inert={passive.value || undefined}>
        <Boundary name={s.name} onHome={goHome} key={s.name}>
          <Current />
        </Boundary>
      </main>

      <div class="toasts" role="status" aria-live="polite">
        {toasts.value.map((t) => (
          <div class="toast" key={t.id}>
            {t.text}
          </div>
        ))}
      </div>

      {passive.value && (
        <div class="takeover" role="alertdialog" aria-labelledby="takeover-title">
          <div class="takeover-card">
            <p id="takeover-title" class="takeover-title">
              MahiEar открыт в другой вкладке
            </p>
            <p class="takeover-text">Чтобы прогресс не перепутался, работать можно только в одной вкладке.</p>
            <Button variant="primary" onClick={takeOver}>
              Работать здесь
            </Button>
          </div>
        </div>
      )}

      <Dialog
        open={!!n && !passive.value}
        title={n?.title ?? ''}
        onClose={dismissNotice}
        actions={
          <Button variant="primary" onClick={dismissNotice}>
            Понятно
          </Button>
        }
      >
        {n?.text}
      </Dialog>
      <ConfirmHost />
      <KeysHelp />
    </>
  );
}
