import { signal } from '@preact/signals';
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
  if (dismissed.value || s === 'prep' || s === 'data') return null;
  return (
    <aside class="data-notice" role="region" aria-label="Хранение данных">
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
