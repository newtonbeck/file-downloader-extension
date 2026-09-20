import { defineConfig } from 'vite'
import { resolve } from 'path'

/**
 * The service worker is built on its own, after the panel build, because it has to come out as
 * one self-contained classic script: a manifest `service_worker` declared without
 * `"type": "module"` cannot `import`, and the panel's multi-entry build would split shared code
 * into chunks under `assets/`.
 *
 * `target: 'esnext'` is load-bearing, not a preference. Functions handed to
 * `chrome.scripting.executeScript({ func })` are shipped as stringified source; a lower target
 * would have esbuild rewrite `async`/spread into module-scope helpers that do not exist in the
 * page, and every injected function would throw a ReferenceError on injection.
 *
 * `minify: false` for the same reason — being able to read the serialized functions in `dist/`
 * is worth more than the bytes.
 */
export default defineConfig({
  build: {
    target: 'esnext',
    outDir: 'dist',
    // The panel build owns emptying dist; this one only adds to it.
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: resolve(__dirname, 'src/worker/index.ts'),
      formats: ['iife'],
      name: 'fileDownloaderWorker',
      fileName: () => 'background.js',
    },
  },
})
