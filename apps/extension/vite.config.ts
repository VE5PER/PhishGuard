import { defineConfig, loadEnv, type Plugin } from 'vite';
import { resolve } from 'path';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs';

// CPU-only runtime binaries shipped under dist/assets/. The JSEP worker wasm
// is intentionally absent: the service worker is the only execution context
// and uses the plain (non-JSEP) ONNX runtime bundle with an explicit
// wasmBinary, so no worker/mjs assets may be packaged.
const DIST_WASM_ASSETS = [
  'ort-wasm-simd-threaded.wasm',
  'sql-wasm.wasm',
];
const DIST_MODEL_FILES = [
  'student_model.onnx',
  'student_model.metadata.json',
];

function packagedDistAssetsPlugin(isContentScriptBuild: boolean): Plugin {
  let emittedFiles = new Set<string>();
  return {
    name: 'phishguard-packaged-dist-assets',
    apply: 'build',
    generateBundle(_options, bundle) {
      emittedFiles = new Set(Object.keys(bundle));
    },
    writeBundle() {
      if (isContentScriptBuild) return;
      const distDir = resolve(__dirname, 'dist');
      const publicDir = resolve(__dirname, 'public');
      const copyPublic = (subdir: string, files: string[]) => {
        const srcDir = resolve(publicDir, subdir);
        // Tolerate optional packaged assets (e.g. the INT8 ONNX model is
        // gitignored). The runtime falls back to kinematic heuristics when a
        // model is absent, so a missing allowlisted file must not fail the build.
        const existing = files.filter((file) => existsSync(resolve(srcDir, file)));
        if (existing.length === 0) return;
        mkdirSync(resolve(distDir, subdir), { recursive: true });
        for (const file of existing) {
          copyFileSync(resolve(srcDir, file), resolve(distDir, subdir, file));
        }
      };
      copyPublic('assets', DIST_WASM_ASSETS);
      copyPublic(
        'icons',
        existsSync(resolve(publicDir, 'icons'))
          ? readdirSync(resolve(publicDir, 'icons'))
          : [],
      );
      copyPublic('models', DIST_MODEL_FILES);

      // Keep only this build's emitted chunks plus the allowlisted CPU
      // binaries; drop stale hashed chunks and foreign wasm binaries that
      // accumulated in dist/assets/ across builds.
      const keep = new Set(DIST_WASM_ASSETS);
      for (const file of emittedFiles) {
        if (file.startsWith('assets/')) {
          keep.add(file.slice('assets/'.length));
        }
      }
      const assetsDir = resolve(distDir, 'assets');
      if (existsSync(assetsDir)) {
        for (const file of readdirSync(assetsDir)) {
          const fullPath = resolve(assetsDir, file);
          if (!keep.has(file) && statSync(fullPath).isFile()) {
            rmSync(fullPath);
          }
        }
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const isContentScriptBuild = mode === 'content-script';
  const env = loadEnv(mode, process.cwd(), '');
  const rootEnv = loadEnv(mode, resolve(__dirname, '../..'), '');

  const rawBackendUrl =
    process.env.BACKEND_URL ||
    env.BACKEND_URL ||
    rootEnv.BACKEND_URL ||
    process.env.GATEWAY_DOMAIN ||
    env.GATEWAY_DOMAIN ||
    rootEnv.GATEWAY_DOMAIN ||
    process.env.VITE_BACKEND_URL ||
    env.VITE_BACKEND_URL ||
    rootEnv.VITE_BACKEND_URL ||
    process.env.EXTENSION_UPDATE_BASE_URL ||
    env.EXTENSION_UPDATE_BASE_URL ||
    rootEnv.EXTENSION_UPDATE_BASE_URL ||
    '';

  let backendUrl = rawBackendUrl.trim().replace(/\/+$/, '');
  if (backendUrl && !/^https?:\/\//i.test(backendUrl)) {
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(backendUrl)) {
      backendUrl = `http://${backendUrl}`;
    } else {
      backendUrl = `https://${backendUrl}`;
    }
  }

  return {
    define: {
      '__BACKEND_URL__': JSON.stringify(backendUrl),
      'import.meta.env.VITE_BACKEND_URL': JSON.stringify(backendUrl),
    },
    plugins: [packagedDistAssetsPlugin(isContentScriptBuild)],
    // publicDir copying is disabled for both builds; the plugin copies the
    // allowlisted CPU assets so the JSEP worker wasm is never emitted.
    publicDir: false,
    build: {
      outDir: 'dist',
      emptyOutDir: false,
      rollupOptions: {
        input: isContentScriptBuild
          ? resolve(__dirname, 'src/content/index.ts')
          : {
              background: resolve(__dirname, 'src/background/service-worker.ts'),
              popup: resolve(__dirname, 'popup/popup.ts'),
              options: resolve(__dirname, 'options/options.ts'),
            },
        output: isContentScriptBuild
          ? {
              entryFileNames: 'content.js',
              format: 'iife',
              inlineDynamicImports: true,
            }
          : {
              entryFileNames: '[name].js',
              format: 'es',
            },
      },
    },
  };
});
