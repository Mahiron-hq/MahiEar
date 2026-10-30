import { fullTitle } from '../lib/manifest';
import { times } from '../lib/format';
import { mostMissed, stats } from '../lib/stats';
import { cat, navigate } from '../state';
import { Button, TopBar } from './common';
import { Footer } from './Footer';
import { startSelective } from './Home';

export function Stats() {
  const c = cat.value;
  const s = stats.value;
  const ids = c ? c.manifest.tracks.map((t) => t.id) : [];
  const missed = mostMissed(ids);
  const answered = ids.filter((id) => s.tracks[id] && (s.tracks[id]!.knew > 0 || s.tracks[id]!.didnt > 0)).length;

  return (
    <div class="screen stats">
      <TopBar title="Статистика" onBack={() => navigate({ name: 'home' })} />
      <dl class="tally">
        <div class="tally-item">
          <dt>Полных прогонов</dt>
          <dd class="tabular">{s.completedRuns}</dd>
        </div>
        <div class="tally-item">
          <dt>Отрывков с ответами</dt>
          <dd class="tabular">
            {answered} / {ids.length}
          </dd>
        </div>
      </dl>
      <p class="muted small">Статистика хранится только на этом устройстве.</p>

      <section class="finish-list">
        <h2 class="section-title">Чаще всего не узнаёте</h2>
        {missed.length === 0 ? (
          <p class="muted">Ошибок пока нет. Отмечайте «Знал» и «Не знал» после показа названия.</p>
        ) : (
          <ol class="missed">
            {missed.slice(0, 50).map((id) => {
              const t = s.tracks[id]!;
              const track = c?.byId.get(id);
              return (
                <li key={id} class="missed-row">
                  <span class="missed-title">{track ? fullTitle(track) : id}</span>
                  <span class="missed-meta tabular">
                    не знал {times(t.didnt)} · знал {times(t.knew)}
                    {t.last === 'didnt' ? ' · последний ответ: не знал' : t.last === 'knew' ? ' · последний ответ: знал' : ''}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </section>
      {missed.length > 0 && (
        <div class="dock dock-simple">
          <Button variant="primary" size="lg" class="wide" onClick={() => void startSelective(missed, 'Частые ошибки')}>
            Прогон по этим отрывкам
          </Button>
        </div>
      )}
      <Footer />
    </div>
  );
}
