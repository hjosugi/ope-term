import { defineConfig } from 'vite';

import { xtermFreezePrototypeCompat } from './scripts/xterm-freeze-compat.mjs';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  cacheDir: process.env.VITE_CACHE_DIR || 'node_modules/.vite',
  plugins: [xtermFreezePrototypeCompat()],
  // The compatibility transform must see xterm's ESM before dependency
  // optimization. Remove this together with the transform once xterm ships a
  // stable release that supports a frozen Object.prototype.
  optimizeDeps: {
    exclude: ['@xterm/xterm'],
  },
  // Keep Bazel's sandboxed source tree intact instead of resolving symlinks
  // back into the execroot, which would make HTML asset paths escape the root.
  resolve: {
    preserveSymlinks: true,
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    // xterm 6 targets modern WebViews; lowering it to Safari 13 breaks its renderer.
    // Tauri v2's supported desktop runtimes all understand ES2022 syntax.
    target: 'es2022',
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
});
