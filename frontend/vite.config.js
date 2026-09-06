import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Build tuning (Task A4 — frontend bundle efficiency):
// - minify: 'esbuild'   → esbuild minifier is ~5-10x faster than terser and
//                         produces comparable gzip output; safe default.
// - target: 'es2020'    → drops transpiles of optional-chaining / nullish /
//                         async-iterators for modern browsers (all
//                         evergreens from 2020+ ship these natively).
//                         Smaller bundle, fewer polyfills, less parse work
//                         for the browser's main thread on cold load.
// - chunkSizeWarningLimit: 500 → surface a warning sooner when an individual
//                         chunk crosses 500 KB so we catch regressions
//                         (default is 1000 KB which lets bloat hide).
// - manualChunks:       → split vendor code out of the app chunk:
//     * 'leaflet'        is dynamically imported by ListingDetail.svelte and
//                       Regions.svelte (via `await import('leaflet')`), so its
//                       chunk stays lazy — only fetched when the user opens a
//                       map. Putting it in an explicit named chunk keeps
//                       caching stable across app-code deploys.
//     * 'svelte'         is statically imported by App.svelte, so its chunk
//                       loads on first paint — but as a separate file that
//                       caches independently of app code (svelte internals
//                       change rarely, so a hot app-code deploys don't bust
//                       the user's svelte cache).
//     * 'webauthn'       (@simplewebauthn/browser) is statically imported by
//                       the auth-only routes; pulling it into its own chunk
//                       keeps it out of the app chunk so non-login users
//                       browsing the feed still download it eagerly (since
//                       App.svelte imports every route statically) but at
//                       least the cache survives a svelte-version bump.
//                       Future work: lazy-load the auth routes themselves.
//     * 'vendor'         catches anything else from node_modules so the app
//                       chunk stays app-only.
export default defineConfig({
  plugins: [svelte()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:9120',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    minify: 'esbuild',
    target: 'es2020',
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return null;
          if (id.includes('leaflet')) return 'leaflet';
          if (id.includes('@simplewebauthn')) return 'webauthn';
          // svelte runtime (matches both "node_modules/svelte/" and
          // "node_modules/@sveltejs/" — the latter is dev-only but
          // keeps the rule defensive if it ever sneaks in).
          if (id.includes('/svelte/') || id.includes('@sveltejs')) return 'svelte';
          return 'vendor';
        }
      }
    }
  }
});
