import { describe, expect, it } from 'vitest';
import { normalizePath, parseRoute, pathFor, type Route } from '../lib/routes';
import swSource from '../sw.ts?raw';

const id = 'a'.repeat(24);

describe('routes', () => {
  it('round-trips every screen', () => {
    const all: Route[] = [
      { name: 'home' },
      { name: 'prep', kind: 'full' },
      { name: 'prep', kind: 'selective' },
      { name: 'finish', kind: 'full' },
      { name: 'finish', kind: 'selective' },
      { name: 'selective' },
      { name: 'playlist' },
      { name: 'playlist', track: id },
      { name: 'settings' },
      { name: 'stats' },
      { name: 'data' },
    ];
    for (const r of all) expect(parseRoute(pathFor(r))).toEqual(r);
  });

  it('prep addresses carry nothing about the excerpt', () => {
    expect(pathFor({ name: 'prep', kind: 'full' })).toBe('/prep');
    expect(pathFor({ name: 'prep', kind: 'selective' })).toBe('/prep/selective');
  });

  it('tolerates trailing slashes, queries and index.html', () => {
    expect(parseRoute('/playlist/')).toEqual({ name: 'playlist' });
    expect(parseRoute('/settings?x=1#y')).toEqual({ name: 'settings' });
    expect(parseRoute('/index.html')).toEqual({ name: 'home' });
    expect(normalizePath('/')).toBe('/');
  });

  it('marks everything else as not found', () => {
    for (const p of ['/wdsf', '/prep/123', '/playlist/xyz', `/playlist/${id}/extra`, '/PLAYLIST', '/data/x'])
      expect(parseRoute(p)).toEqual({ name: 'notfound' });
  });
});

describe('service worker route list', () => {
  it('matches the app router', () => {
    const m = /const APP_ROUTE =\s*\/(.+)\/;/.exec(swSource);
    expect(m).not.toBeNull();
    const re = new RegExp(m![1]!);
    const paths = ['/', '/prep', '/prep/', '/prep/selective', '/prep/result', '/prep/selective/result', '/select',
      '/playlist', `/playlist/${id}`, '/settings', '/stats', '/data', '/index.html', '/wdsf', '/prep/x', '/playlist/abc',
      '/assets/x.js', '/data/more', '/Settings'];
    for (const p of paths) expect(re.test(p), p).toBe(parseRoute(p).name !== 'notfound');
  });
});
