// ponytail: IIFE keeps this plugin to one file and therefore cannot split code. When that
// stops scaling, move to ES output plus functional output.paths, as proven by the ADR-060 spike.
import path from 'node:path';
import tailwindcss from '@tailwindcss/postcss';
import { defineConfig, type Plugin } from 'vite';
import { INTERNAL_RENDERER_SDK_SPECIFIERS } from './scripts/renderer-sdk-specifiers';

const packageRoot = import.meta.dirname;
const rendererSdkSpecifiers = new Set<string>(INTERNAL_RENDERER_SDK_SPECIFIERS);

function assertRendererSdkSpecifier(id: string): void {
  if (id.startsWith('@renderer/') && !rendererSdkSpecifiers.has(id)) {
    throw new Error(`插件引用了未暴露的宿主模块 ${id}，加进宿主 SDK 表或改由插件自带`);
  }
}

function rendererSdkBoundaryPlugin(): Plugin {
  return {
    name: 'neo-internal-renderer-sdk-boundary',
    enforce: 'pre',
    resolveId(id) {
      if (!id.startsWith('@renderer/')) return null;
      try {
        assertRendererSdkSpecifier(id);
      } catch (error) {
        this.error(error instanceof Error ? error.message : String(error));
      }
      return { id, external: true };
    },
  };
}

function isExternal(id: string): boolean {
  assertRendererSdkSpecifier(id);
  return id === 'react'
    || id === 'react/jsx-runtime'
    || id === 'react/jsx-dev-runtime'
    || id === 'react-dom'
    || id.startsWith('react-dom/')
    || id === 'zustand'
    || id.startsWith('zustand/')
    || id.startsWith('@renderer/');
}

export default defineConfig({
  root: packageRoot,
  plugins: [rendererSdkBoundaryPlugin()],
  resolve: {
    alias: {
      '@shared': path.resolve(packageRoot, '../../../src/shared'),
    },
  },
  css: {
    postcss: {
      plugins: [tailwindcss({ base: packageRoot })],
    },
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: 'src/renderer/entry.tsx',
      name: '__neoInternalFeature_evaluation_center',
      formats: ['iife'],
      fileName: () => 'index.js',
      cssFileName: 'index',
    },
    rollupOptions: {
      external: isExternal,
      output: {
        globals: (id: string) => `window.__NEO_INTERNAL_SDK__.modules[${JSON.stringify(id)}]`,
      },
    },
  },
});
