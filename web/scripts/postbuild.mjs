import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
for (const [name, source, size] of icons) {
  const png = new Resvg(source, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(join(dist, name), png);
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
    !f.endsWith('.br') &&
    !f.endsWith('.gz') &&
    (!f.endsWith('.woff2') || /inter-(latin|latin-ext|cyrillic|cyrillic-ext)-wght-normal/.test(f)),
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
