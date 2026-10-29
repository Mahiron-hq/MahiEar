import { fullTitle } from '../lib/manifest';
import { times } from '../lib/format';
import { summarize, type RunKind } from '../lib/runs';
import { stats } from '../lib/stats';
import { closeFinished, run, unfinished } from '../prep';
import { cat, navigate } from '../state';
import { Button } from './common';
import { confirmAsk } from './confirm';
import { startFull, startSelective } from './Home';

export function Finish({ kind }: { kind: RunKind }) {
  const r = run.value;
  const c = cat.value;
  if (!r || !c || !r.finished) {
    return (
      <div class="screen finish">
        <p class="empty">Итоги недоступны.</p>
        <Button onClick={() => navigate({ name: 'home' })}>В главное меню</Button>
      </div>
    );
  }
  const s = summarize(r);
  const name = (id: string) => {
    const t = c.byId.get(id);
    return t ? fullTitle(t) : 'Отрывок удалён из набора';
  };
  const home = () => {
    closeFinished(kind);
    navigate({ name: 'home' });
  };

  return (
    <div class="screen finish">
      <header class="finish-head">
        <h1 class="finish-title">Подготовка завершена</h1>
        <p class="finish-sub">{r.label}</p>
      </header>

      <dl class="tally">
        <div class="tally-item">
          <dt>Знал</dt>
          <dd class="tabular">{s.knew.length}</dd>
        </div>
        <div class="tally-item is-miss">
          <dt>Не знал</dt>
          <dd class="tabular">{s.didnt.length}</dd>
        </div>
        <div class="tally-item">
          <dt>Без ответа</dt>
          <dd class="tabular">{s.unanswered.length}</dd>
        </div>
      </dl>

      <p class="finish-runs">
        Полный прогон пройден {times(stats.value.completedRuns)}
      </p>

      {s.didnt.length > 0 && (
        <section class="finish-list">
          <h2 class="section-title">Не знал</h2>
          <ul>
            {s.didnt.map((id) => (
              <li key={id}>{name(id)}</li>
            ))}
          </ul>
        </section>
      )}
      {s.skipped.length > 0 && (
        <section class="finish-list">
          <h2 class="section-title">Пропущены из-за ошибок загрузки</h2>
          <ul>
            {s.skipped.map((id) => (
              <li key={id}>{name(id)}</li>
            ))}
          </ul>
        </section>
      )}

      <div class="finish-actions">
        {s.didnt.length > 0 && (
          <Button
            variant="primary"
            size="lg"
            class="wide"
            onClick={() => {
              const ids = s.didnt.filter((id) => c.byId.has(id));
              closeFinished(kind);
              void startSelective(ids, 'Только ошибки');
            }}
          >
            Повторить только ошибки
          </Button>
        )}
        <Button
          variant={s.didnt.length > 0 ? 'secondary' : 'primary'}
          size="lg"
          class="wide"
          onClick={async () => {
            const pending = kind === 'selective' ? unfinished('full') : null;
            if (
              pending &&
              !(await confirmAsk(
                'Начать новый полный прогон?',
                `Незавершённый полный прогон (${pending.pos + 1} из ${pending.order.length}) будет сброшен.`,
                'Начать',
              ))
            )
              return;
            closeFinished(kind);
            startFull();
          }}
        >
          Начать заново
        </Button>
        <Button variant="ghost" class="wide" onClick={home}>
          В главное меню
        </Button>
      </div>
    </div>
  );
}
