import { useMemo, useState } from 'preact/hooks';
import { excerpts } from '../lib/format';
import { load, save } from '../lib/storage';
import { cat, navigate } from '../state';
import { Button, TopBar } from './common';
import { startSelective } from './Home';

const KEY = 'mahiear.selection.v1';

function blockKey(composer: string, work: string): string {
  return `${composer}\u0000${work}`;
}

function loadSelection(): Set<string> | null {
  const l = load(KEY, (raw) => (Array.isArray(raw) && raw.every((x) => typeof x === 'string') ? (raw as string[]) : null));
  return l.status === 'ok' ? new Set(l.value) : null;
}

export function Selective() {
  const c = cat.value;
  const blocks = c?.manifest.blocks ?? [];
  const [chosen, setChosen] = useState<Set<string>>(() => {
    const saved = loadSelection();
    const all = blocks.map((b) => blockKey(b.composer, b.work));
    return saved ? new Set(all.filter((k) => saved.has(k))) : new Set(all);
  });

  const composers = useMemo(() => {
    const m = new Map<string, typeof blocks>();
    for (const b of blocks) m.set(b.composer, [...(m.get(b.composer) ?? []), b]);
    return [...m.entries()];
  }, [blocks]);

  const update = (next: Set<string>) => {
    setChosen(next);
    save(KEY, [...next]);
  };
  const toggle = (k: string) => {
    const n = new Set(chosen);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    update(n);
  };
  const toggleComposer = (composer: string, on: boolean) => {
    const n = new Set(chosen);
    for (const b of blocks) {
      if (b.composer !== composer) continue;
      const k = blockKey(b.composer, b.work);
      if (on) n.add(k);
      else n.delete(k);
    }
    update(n);
  };

  const ids = blocks.filter((b) => chosen.has(blockKey(b.composer, b.work))).flatMap((b) => b.tracks);
  const label = (() => {
    const picked = blocks.filter((b) => chosen.has(blockKey(b.composer, b.work)));
    if (picked.length === 1) return picked[0]!.work;
    const names = [...new Set(picked.map((b) => b.composer))];
    const whole = names.every((n) => blocks.filter((b) => b.composer === n).every((b) => chosen.has(blockKey(b.composer, b.work))));
    return whole && names.length <= 2 ? names.join(', ') : `Выбрано произведений: ${picked.length}`;
  })();

  return (
    <div class="screen selective">
      <TopBar title="Выборочная подготовка" onBack={() => navigate({ name: 'home' })} />
      <div class="bulk">
        <Button variant="ghost" size="sm" onClick={() => update(new Set(blocks.map((b) => blockKey(b.composer, b.work))))}>
          Выбрать все
        </Button>
        <Button variant="ghost" size="sm" onClick={() => update(new Set())}>
          Снять все
        </Button>
      </div>
      <div class="pick">
        {composers.map(([composer, list]) => {
          const on = list.filter((b) => chosen.has(blockKey(b.composer, b.work))).length;
          return (
            <fieldset class="pick-group" key={composer}>
              <legend class="pick-legend">
                <label class="check">
                  <input
                    type="checkbox"
                    checked={on === list.length}
                    ref={(el) => {
                      if (el) el.indeterminate = on > 0 && on < list.length;
                    }}
                    onChange={(e) => toggleComposer(composer, e.currentTarget.checked)}
                  />
                  <span class="check-label is-composer">{composer}</span>
                </label>
              </legend>
              {list.map((b) => {
                const k = blockKey(b.composer, b.work);
                return (
                  <label class="check" key={k}>
                    <input type="checkbox" checked={chosen.has(k)} onChange={() => toggle(k)} />
                    <span class="check-label">{b.work}</span>
                    <span class="check-count tabular">{b.tracks.length}</span>
                  </label>
                );
              })}
            </fieldset>
          );
        })}
      </div>
      <div class="dock dock-simple">
        <Button variant="primary" size="lg" class="wide" disabled={ids.length === 0} onClick={() => void startSelective(ids, label)}>
          {ids.length === 0 ? 'Ничего не выбрано' : `Начать · ${excerpts(ids.length)}`}
        </Button>
      </div>
    </div>
  );
}
