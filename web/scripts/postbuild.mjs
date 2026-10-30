import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { Resvg } from '@resvg/resvg-js';

const dist = new URL('../dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const svg = readFileSync(join(dist, 'icon.svg'), 'utf8');
const maskable = svg.replace('<g ', '<g transform="translate(256 256) scale(0.78) translate(-256 -256)" ');
const icons = [
  ['icon-192.png', svg, 192],
  ['icon-512.png', svg, 512],
  ['apple-touch-icon.png', svg, 180],
  ['icon-maskable-512.png', maskable, 512],
];
icons.push(['og-image.png', readFileSync(join(dist, 'og-image.svg'), 'utf8'), 1200]);
for (const [name, source, size] of icons) {
  const png = new Resvg(source, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(join(dist, name), png);
}

const errorPages = {
  400: ['Запрос не принят', 'Сервер не смог обработать этот запрос. Попробуйте открыть страницу ещё раз.'],
  403: ['Доступ запрещён', 'У этой страницы закрытый доступ.'],
  404: ['Страница не найдена', 'Такого адреса на сайте нет. Возможно, ссылка устарела или в ней опечатка.'],
  429: ['Слишком много запросов', 'Сервер получил слишком много запросов подряд. Подождите немного и обновите страницу.'],
  500: ['Ошибка на сервере', 'Что-то пошло не так на нашей стороне. Попробуйте обновить страницу чуть позже.'],
  503: ['Сайт временно недоступен', 'Сервер обновляется или перегружен. Обычно это занимает меньше минуты.'],
};
mkdirSync(join(dist, 'errors'), { recursive: true });
for (const f of readdirSync(join(dist, 'assets'))) {
  const m = /^inter-(latin|cyrillic)-wght-normal-.*\.woff2$/.exec(f);
  if (m) copyFileSync(join(dist, 'assets', f), join(dist, 'errors', `inter-${m[1]}.woff2`));
}
writeFileSync(
  join(dist, 'errors', 'errors.css'),
  `@font-face{font-family:Inter;font-weight:100 900;font-display:swap;src:url(inter-cyrillic.woff2) format('woff2');unicode-range:U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116}
@font-face{font-family:Inter;font-weight:100 900;font-display:swap;src:url(inter-latin.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215}
*{box-sizing:border-box}html{height:100%;background:#121315;color-scheme:dark}
body{margin:0;min-height:100%;display:flex;flex-direction:column;background:#121315;color:#ececee;font-family:Inter,-apple-system,'Segoe UI',Roboto,sans-serif;line-height:1.45;-webkit-font-smoothing:antialiased;padding:env(safe-area-inset-top) 20px env(safe-area-inset-bottom)}
.wrap{width:100%;max-width:640px;margin:0 auto;flex:1;display:flex;flex-direction:column}
header{min-height:64px;display:flex;align-items:center}a.mark{color:#ececee;font-weight:650;font-size:18px;text-decoration:none}
main{flex:1;display:flex;flex-direction:column;justify-content:center;gap:12px;padding:40px 0}
.code{color:#85858e;font-size:15px;font-variant-numeric:tabular-nums;margin:0}h1{margin:0;font-size:clamp(26px,7vw,38px);line-height:1.15;font-weight:650;letter-spacing:-.02em}
p{margin:0;color:#a6a6ae;max-width:42ch}.btn{align-self:flex-start;margin-top:20px;display:inline-flex;align-items:center;min-height:52px;padding:0 24px;border-radius:12px;background:#c9a76a;color:#1a150c;font-weight:550;text-decoration:none}
.btn:hover{background:#d6b77e}a:focus-visible{outline:2px solid #c9a76a;outline-offset:2px}
footer{display:flex;flex-wrap:wrap;gap:6px 16px;padding:16px 0 20px;color:#85858e;font-size:12px}footer a{color:#85858e}
@media (prefers-reduced-motion:no-preference){main{animation:in .22s cubic-bezier(.2,.7,.2,1) both}@keyframes in{from{opacity:0;transform:translateY(6px)}}}
`,
);
for (const [code, [title, text]] of Object.entries(errorPages)) {
  writeFileSync(
    join(dist, 'errors', `${code}.html`),
    `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#121315">
<meta name="robots" content="noindex">
<title>${title} · MahiEar</title>
<meta name="description" content="${text}">
<meta property="og:site_name" content="MahiEar">
<meta property="og:type" content="website">
<meta property="og:locale" content="ru_RU">
<meta property="og:title" content="${title} · MahiEar">
<meta property="og:description" content="${text}">
<meta name="twitter:card" content="summary">
<link rel="stylesheet" href="/errors/errors.css">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
</head>
<body>
<div class="wrap">
<header><a class="mark" href="/">MahiEar</a></header>
<main>
<p class="code">Ошибка ${code}</p>
<h1>${title}</h1>
<p>${text}</p>
<a class="btn" href="/">На главную</a>
</main>
<footer><span>Copyright 2026 Lev Burmistrov (Mahiron-hq)</span><a href="/data">О данных</a><a href="https://github.com/Mahiron-hq/MahiEar" rel="noopener noreferrer">Открытый код</a></footer>
</div>
</body>
</html>
`,
  );
}

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = walk(dist).map((p) => '/' + relative(dist, p).split(sep).join('/'));
const precache = files.filter(
  (f) =>
    f !== '/sw.js' &&
    !f.startsWith('/og-image.') &&
    f !== '/robots.txt' &&
    !f.endsWith('.br') &&
    !f.endsWith('.gz') &&
    (!f.endsWith('.woff2') || f.startsWith('/errors/') || /inter-(latin|latin-ext|cyrillic|cyrillic-ext)-wght-normal/.test(f)),
);

const hash = createHash('sha256');
for (const f of precache.sort()) hash.update(f).update(readFileSync(join(dist, f)));
const version = hash.digest('hex').slice(0, 12);

const swPath = join(dist, 'sw.js');
const sw = readFileSync(swPath, 'utf8');
if (!sw.includes('__VERSION__') || !sw.includes('__ASSETS__')) throw new Error('sw.js placeholders not found');
writeFileSync(swPath, sw.replaceAll('__VERSION__', JSON.stringify(version)).replaceAll('__ASSETS__', JSON.stringify(precache)));

for (const f of walk(dist)) {
  if (!/\.(js|css|html|svg|webmanifest|json|txt)$/.test(f)) continue;
  const data = readFileSync(f);
  if (data.length < 512) continue;
  writeFileSync(`${f}.br`, brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
  writeFileSync(`${f}.gz`, gzipSync(data, { level: 9 }));
}

console.log(`sw version ${version}, ${precache.length} files precached`);
