import { defineConfig, type Plugin } from 'vite';

function preloadFonts(): Plugin {
  return {
    name: 'preload-fonts',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        if (!ctx.bundle) return [];
        return Object.keys(ctx.bundle)
          .filter((f) => /inter-(latin|cyrillic)-wght-normal-.*\.woff2$/.test(f))
          .map((f) => ({
            tag: 'link',
            attrs: { rel: 'preload', href: `/${f}`, as: 'font', type: 'font/woff2', crossorigin: '' },
            injectTo: 'head' as const,
          }));
      },
    },
  };
}

export default defineConfig({
  plugins: [preloadFonts()],
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  build: {
    target: ['es2020', 'safari15'],
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: { main: 'index.html', sw: 'src/sw.ts' },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
  server: {
    proxy: { '/api': 'http://127.0.0.1:8090', '/a/': 'http://127.0.0.1:8090' },
  },
});
