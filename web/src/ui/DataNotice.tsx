import { signal } from '@preact/signals';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { load, save } from '../lib/storage';
import { screen } from '../state';
import { Link } from './Footer';

const KEY = 'mahiear.dataNotice.v1';
const dismissed = signal(load(KEY, (raw) => (raw === true ? true : null)).status === 'ok');

function close(): void {
  dismissed.value = true;
  save(KEY, true);
}

export function DataNotice() {
  const s = screen.value.name;
  const hidden = dismissed.value || s === 'prep' || s === 'data';
  const box = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const el = box.current;
    if (hidden || !el) {
      root.style.removeProperty('--notice-space');
      return;
    }
    const sync = () => root.style.setProperty('--notice-space', `${Math.ceil(el.getBoundingClientRect().height) + 24}px`);
    sync();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      root.style.removeProperty('--notice-space');
    };
  }, [hidden]);
  if (hidden) return null;
  return (
    <aside ref={box} class="data-notice" role="region" aria-label="Хранение данных">
      <p class="data-notice-text">
        MahiEar сохраняет на этом устройстве настройки, прогресс и отрывки для работы без интернета.{' '}
        <Link to={{ name: 'data' }} onClick={close}>
          Подробнее
        </Link>
      </p>
      <button type="button" class="btn btn-secondary btn-sm" onClick={close}>
        Понятно
      </button>
    </aside>
  );
}
