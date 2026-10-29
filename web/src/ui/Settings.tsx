import { offline } from '../lib/offline';
import { advanceBounds, DELAY_MAX, DELAY_MIN, type AutoAdvance } from '../lib/settings';
import { resetStats } from '../lib/stats';
import { onSettingsChanged } from '../prep';
import { maxDuration, navigate, resetSettings, settings, toast, updateSettings } from '../state';
import { Button, Stepper, Switch, TopBar } from './common';
import { confirmAsk } from './confirm';

const MODES: { value: AutoAdvance; label: string }[] = [
  { value: 'off', label: 'Выключен' },
  { value: 'end', label: 'По окончании трека' },
  { value: 'after', label: 'Через N секунд' },
];

function offlineHint(): string {
  const o = offline.value;
  switch (o.state) {
    case 'done':
      return 'Доступно офлайн';
    case 'downloading':
      return `Загружено ${o.done} из ${o.total}`;
    case 'waiting':
      return `Загружено ${o.done} из ${o.total}, загрузка продолжится при появлении сети`;
    case 'quota':
      return 'Недостаточно места на устройстве';
    case 'unsupported':
      return 'Браузер не поддерживает хранение отрывков';
    default:
      return 'Все отрывки хранятся на устройстве и доступны без интернета';
  }
}

export function SettingsScreen() {
  const s = settings.value;
  const longest = maxDuration();
  const bounds = advanceBounds(s.revealDelay, longest);
  const apply = (patch: Parameters<typeof updateSettings>[0]) => {
    updateSettings(patch);
    onSettingsChanged();
  };

  return (
    <div class="screen settings">
      <TopBar title="Настройки" onBack={() => navigate({ name: 'home' })} />

      <section class="group">
        <h2 class="section-title">Подготовка</h2>
        <div class="row column">
          <span class="row-label">Задержка показа названия</span>
          <span class="row-hint">От {DELAY_MIN} до {DELAY_MAX} секунд звучания</span>
          <Stepper
            label="Задержка показа названия"
            value={s.revealDelay}
            min={DELAY_MIN}
            max={DELAY_MAX}
            unit="с"
            onChange={(v) => apply({ revealDelay: v })}
          />
        </div>

        <fieldset class="row column">
          <legend class="row-label">Автопереход</legend>
          <div class="segmented" role="radiogroup" aria-label="Автопереход">
            {MODES.map((m) => {
              const unavailable = m.value === 'after' && !bounds.available;
              return (
                <label class={`segment ${s.autoAdvance === m.value ? 'is-on' : ''} ${unavailable ? 'is-disabled' : ''}`} key={m.value}>
                  <input
                    type="radio"
                    name="auto"
                    value={m.value}
                    checked={s.autoAdvance === m.value}
                    disabled={unavailable}
                    onChange={() => apply({ autoAdvance: m.value })}
                  />
                  {m.label}
                </label>
              );
            })}
          </div>
          {s.autoAdvance === 'after' && bounds.available && (
            <div class="sub-setting">
              <span class="row-hint">
                N от {bounds.min} до {bounds.max} с: не раньше чем через 3 с после показа названия и не дольше самого длинного
                отрывка
              </span>
              <Stepper
                label="Через сколько секунд переходить"
                value={Math.min(bounds.max, Math.max(bounds.min, s.advanceAfter))}
                min={bounds.min}
                max={bounds.max}
                unit="с"
                onChange={(v) => apply({ advanceAfter: v })}
              />
            </div>
          )}
          {!bounds.available && longest > 0 && (
            <p class="row-hint">
              «Через N секунд» недоступен: самый длинный отрывок ({Math.floor(longest)} с) короче минимального времени перехода (
              {bounds.min} с).
            </p>
          )}
        </fieldset>
      </section>

      <section class="group">
        <h2 class="section-title">Звук</h2>
        <Switch
          label="Выравнивание громкости"
          hint="Все отрывки звучат одинаково громко"
          checked={s.normalize}
          onChange={(v) => apply({ normalize: v })}
        />
        <Switch
          label="Воспроизведение в фоне"
          hint="Звук не останавливается при сворачивании и блокировке экрана"
          checked={s.background}
          onChange={(v) => apply({ background: v })}
        />
        <Switch label="Офлайн-режим" hint={offlineHint()} checked={s.offline} onChange={(v) => apply({ offline: v })} />
      </section>

      <section class="group">
        <h2 class="section-title">Данные</h2>
        <div class="row-actions">
          <Button
            onClick={() => {
              resetSettings();
              onSettingsChanged();
              toast('Настройки сброшены');
            }}
          >
            Сбросить настройки
          </Button>
          <Button
            onClick={async () => {
              const ok = await confirmAsk(
                'Сбросить статистику?',
                'Счётчик пройденных прогонов и ответы «Знал» и «Не знал» будут удалены с этого устройства.',
                'Сбросить',
              );
              if (ok) {
                resetStats();
                toast('Статистика сброшена');
              }
            }}
          >
            Сбросить статистику
          </Button>
        </div>
        <p class="row-hint privacy">
          Сайт работает без регистрации и не собирает сведений о пользователях. Ответы и личная статистика хранятся только в
          этом браузере. На сервер передаются только обезличенные счётчики: сколько раз звучал каждый отрывок и сколько полных
          прогонов завершено.
        </p>
      </section>
    </div>
  );
}
