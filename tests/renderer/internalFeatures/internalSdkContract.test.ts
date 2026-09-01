// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { capabilityHubEn, capabilityHubZh } from '../../../src/renderer/i18n/capabilityHub';
import {
  installInternalSdk,
  INTERNAL_RENDERER_SDK,
} from '../../../src/renderer/internalFeatures/internalSdk';

const rendererRoot = path.resolve(process.cwd(), 'src/renderer');
const featureRoot = path.join(rendererRoot, 'internalFeatures');

function sourceFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    return entry.isDirectory() ? sourceFiles(absolute) : [absolute];
  }).filter((file) => /\.(?:ts|tsx)$/u.test(file));
}

beforeEach(() => {
  delete window.__NEO_INTERNAL_SDK__;
});

describe('renderer internal plugin shared table', () => {
  it('exposes the exact package import surface and installs idempotently', () => {
    expect(Object.keys(INTERNAL_RENDERER_SDK.modules)).toEqual([
      'react',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'zustand',
      '@renderer/components/primitives/Button',
      '@renderer/components/primitives/Modal',
      '@renderer/components/primitives/EmptyState',
      '@renderer/components/primitives/Badge',
      '@renderer/components/primitives/Textarea',
      '@renderer/components/primitives/Select',
      '@renderer/components/primitives/Toggle',
      '@renderer/components/primitives/IconButton',
      '@renderer/components/composites/ConfirmDialog',
      '@renderer/components/features/shared/FullScreenPage',
      '@renderer/components/features/shared/PageContent',
      '@renderer/components/features/inAppValidation/InAppValidationWorkspace',
      '@renderer/stores/appStore',
      '@renderer/stores/authStore',
      '@renderer/stores/sessionStore',
      '@renderer/services/ipcService',
      '@renderer/hooks/useToast',
      '@renderer/hooks/useI18n',
      '@renderer/utils/accessControl',
      '@renderer/utils/sessionPresentation',
      '@renderer/styles/zLayers',
      '@renderer/slots/pluginUiSdk',
    ]);
    expect(Object.isFrozen(INTERNAL_RENDERER_SDK)).toBe(true);
    expect(Object.isFrozen(INTERNAL_RENDERER_SDK.modules)).toBe(true);

    installInternalSdk();
    const installed = window.__NEO_INTERNAL_SDK__;
    installInternalSdk();
    expect(window.__NEO_INTERNAL_SDK__).toBe(installed);
    expect(installed).toBe(INTERNAL_RENDERER_SDK);
  });

  it('is installed exactly once by the renderer entry and never imports host modules', () => {
    const entry = fs.readFileSync(path.join(rendererRoot, 'index.tsx'), 'utf8');
    const sources = sourceFiles(featureRoot).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    expect(entry.match(/installInternalSdk\(\)/gu)).toHaveLength(1);
    expect(entry).toContain("from './internalFeatures/internalSdk'");
    expect(sources).not.toMatch(/(?:from|import\s*)\s*['"]@host\//u);
  });

  it('用户可见文案不暴露实现黑话', () => {
    const copy = [
      ...Object.values(capabilityHubZh.internalFeatures),
      ...Object.values(capabilityHubEn.internalFeatures),
    ];
    const sourceCopy = sourceFiles(featureRoot)
      .flatMap((file) => fs.readFileSync(file, 'utf8').match(/['"`]([^'"`]*[\u3400-\u9fff][^'"`]*)['"`]/gu) ?? []);
    const forbidden = /\b(?:SDK|hash|manifest|internal-feature)\b|契约/iu;
    expect([...copy, ...sourceCopy]).not.toEqual(expect.arrayContaining([expect.stringMatching(forbidden)]));
  });
});
