export type RunKindRoute = 'full' | 'selective';

export type Route =
  | { name: 'home' }
  | { name: 'prep'; kind: RunKindRoute }
  | { name: 'finish'; kind: RunKindRoute }
  | { name: 'selective' }
  | { name: 'playlist'; track?: string }
  | { name: 'settings' }
  | { name: 'stats' }
  | { name: 'data' }
  | { name: 'notfound' };

const TRACK = /^[0-9a-f]{24}$/;

export function normalizePath(path: string): string {
  const p = path.split(/[?#]/)[0] ?? '/';
  if (p === '/index.html') return '/';
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p || '/';
}

export function parseRoute(path: string): Route {
  const p = normalizePath(path);
  switch (p) {
    case '/':
      return { name: 'home' };
    case '/prep':
      return { name: 'prep', kind: 'full' };
    case '/prep/selective':
      return { name: 'prep', kind: 'selective' };
    case '/prep/result':
      return { name: 'finish', kind: 'full' };
    case '/prep/selective/result':
      return { name: 'finish', kind: 'selective' };
    case '/select':
      return { name: 'selective' };
    case '/playlist':
      return { name: 'playlist' };
    case '/settings':
      return { name: 'settings' };
    case '/stats':
      return { name: 'stats' };
    case '/data':
      return { name: 'data' };
  }
  const m = /^\/playlist\/([^/]+)$/.exec(p);
  if (m && TRACK.test(m[1]!)) return { name: 'playlist', track: m[1]! };
  return { name: 'notfound' };
}

export function pathFor(r: Route): string {
  switch (r.name) {
    case 'home':
      return '/';
    case 'prep':
      return r.kind === 'full' ? '/prep' : '/prep/selective';
    case 'finish':
      return r.kind === 'full' ? '/prep/result' : '/prep/selective/result';
    case 'selective':
      return '/select';
    case 'playlist':
      return r.track ? `/playlist/${r.track}` : '/playlist';
    case 'settings':
      return '/settings';
    case 'stats':
      return '/stats';
    case 'data':
      return '/data';
    case 'notfound':
      return location.pathname;
  }
}

const TITLES: Record<Route['name'], string> = {
  home: 'MahiEar · Подготовка к музыкальной викторине',
  prep: 'Подготовка · MahiEar',
  finish: 'Итоги · MahiEar',
  selective: 'Выборочная подготовка · MahiEar',
  playlist: 'Плейлист · MahiEar',
  settings: 'Настройки · MahiEar',
  stats: 'Статистика · MahiEar',
  data: 'О данных · MahiEar',
  notfound: 'Страница не найдена · MahiEar',
};

export function titleFor(r: Route): string {
  return TITLES[r.name];
}
