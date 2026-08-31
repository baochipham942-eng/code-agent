import fs from 'node:fs/promises';
import path from 'node:path';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactJsxDevRuntime from 'react/jsx-dev-runtime';
import * as ReactJsxRuntime from 'react/jsx-runtime';
import * as Zustand from 'zustand';
import { beforeAll, describe, expect, it } from 'vitest';
import { build as viteBuild } from 'vite';
import rendererConfig from '../../../packages/internal/evaluation-center/vite.renderer.config';
import { INTERNAL_RENDERER_SDK_SPECIFIERS } from '../../../packages/internal/evaluation-center/scripts/renderer-sdk-specifiers';

const packageRoot = path.resolve(process.cwd(), 'packages/internal/evaluation-center');

function looseModule(): object {
  const callable = () => undefined;
  return new Proxy(callable, {
    apply: () => undefined,
    construct: () => ({}),
    get: (_target, key) => {
      if (key === Symbol.toPrimitive) return () => 0;
      if (key === '__esModule') return true;
      return looseModule();
    },
  });
}

beforeAll(async () => {
  await viteBuild(rendererConfig);
}, 30_000);

describe('evaluation-center renderer bundle', () => {
  it('uses the host React object directly and exports a constructible Page', async () => {
    const code = await fs.readFile(path.join(packageRoot, 'dist/renderer/index.js'), 'utf8');
    const modules: Record<string, unknown> = {};
    for (const specifier of INTERNAL_RENDERER_SDK_SPECIFIERS) modules[specifier] = looseModule();
    Object.assign(modules, {
      react: React,
      'react/jsx-runtime': ReactJsxRuntime,
      'react/jsx-dev-runtime': ReactJsxDevRuntime,
      'react-dom': ReactDOM,
      zustand: Zustand,
    });
    const windowValue = { __NEO_INTERNAL_SDK__: { modules } } as Record<string, unknown>;
    const execute = new Function(
      'window',
      `${code}\nwindow.__neoInternalFeature_evaluation_center = __neoInternalFeature_evaluation_center;`,
    );

    execute(windowValue);

    const feature = windowValue.__neoInternalFeature_evaluation_center as { Page?: unknown };
    expect(feature.Page).toBeTypeOf('function');
    expect(React.createElement(feature.Page as React.ComponentType)).toMatchObject({
      type: feature.Page,
    });
  });

  it('ships package-scoped utilities, host theme variants, and no preflight reset', async () => {
    const css = await fs.readFile(path.join(packageRoot, 'dist/renderer/index.css'), 'utf8');
    expect(css).toMatch(/\.grid-cols-(?:1|2|3|4)\b/u);
    expect(css).toContain('.border-brand');
    expect(css).toMatch(/data-theme=['"]?dark/u);
    expect(css).toContain('high-contrast-dark');
    expect(css).toMatch(/@layer\s+theme\b/u);
    expect(css).not.toMatch(/\*,::before,::after\s*\{\s*box-sizing/u);
  });
});
