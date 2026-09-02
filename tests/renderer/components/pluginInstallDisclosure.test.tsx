// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityPackagePreview } from '../../../src/shared/contract/capabilityPackage';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh }),
}));

import { PluginInstallDisclosure } from '../../../src/renderer/components/features/settings/tabs/PluginInstallDisclosure';

const ALL_LOCATIONS = [
  'nav.account.item',
  'hub.tab',
  'settings.section',
  'workspace.page',
  'shell.overlay',
  'conversation.turnTail',
];

function preview(overrides: Partial<CapabilityPackagePreview> = {}): CapabilityPackagePreview {
  return {
    token: 'preview-token',
    id: 'third-party.timeline',
    packageId: '1.0.0-fixture',
    mode: 'run',
    approvalRequired: true,
    name: 'Timeline',
    version: '1.0.0',
    description: 'Adds a reviewed timeline.',
    permissions: ['storage'],
    toolNames: [],
    surface: 'ui',
    sourceKind: 'zip',
    sourceLabel: 'Timeline Studio',
    sourceTrust: { level: 'signed', reason: 'verified', keyId: 'publisher-key-42' },
    requestedUiSlots: ALL_LOCATIONS,
    sandbox: { passed: true, summary: 'Package shape checked before installation.' },
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

function renderDisclosure(overrides: Partial<CapabilityPackagePreview> = {}) {
  return render(
    <PluginInstallDisclosure
      busy={false}
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
      preview={preview(overrides)}
      text={zh.settings.plugins.manualImport}
    />,
  );
}

afterEach(() => cleanup());

describe('plugin install disclosure', () => {
  it('V1 translates the bottom-left menu location', () => {
    renderDisclosure();
    expect(screen.getByText('会在你左下角的菜单里加一项')).toBeTruthy();
  });

  it('V2 translates the Capability Center tab location', () => {
    renderDisclosure();
    expect(screen.getByText('会在能力中心多出一个页签')).toBeTruthy();
  });

  it('V3 translates the settings location', () => {
    renderDisclosure();
    expect(screen.getByText('会在设置里加一段自己的设置')).toBeTruthy();
  });

  it('V4 translates the full-page location', () => {
    renderDisclosure();
    expect(screen.getByText('会占用一个整页来显示它自己的界面')).toBeTruthy();
  });

  it('V5 translates the floating-content location', () => {
    renderDisclosure();
    expect(screen.getByText('会在界面上层显示浮窗或提示')).toBeTruthy();
  });

  it('V6 translates the conversation ending location', () => {
    renderDisclosure();
    expect(screen.getByText('会在每轮对话结束后追加内容')).toBeTruthy();
  });

  it('never exposes raw location identifiers as fallback copy', () => {
    const { container } = renderDisclosure();
    for (const rawName of ALL_LOCATIONS) expect(container.textContent).not.toContain(rawName);
  });

  it('shows the verified source file and signing key', () => {
    renderDisclosure();
    expect(screen.getByText(zh.settings.plugins.manualImport.source.signedTitle)).toBeTruthy();
    expect(screen.getByText('Timeline Studio')).toBeTruthy();
    expect(screen.getByText('publisher-key-42')).toBeTruthy();
  });

  it('V7 makes an unverified source explicit and lists its blocked product locations', () => {
    renderDisclosure({
      sourceTrust: { level: 'unsigned', reason: 'not verified' },
      requestedUiSlots: ['workspace.page', 'settings.section'],
    });
    expect(screen.getByText('来源未经验证')).toBeTruthy();
    for (const blocked of ['左下角菜单', '能力中心页签', '界面浮窗或提示', '每轮对话后的内容区']) {
      expect(screen.getByText(blocked)).toBeTruthy();
    }
  });

  it('V8 states that an interface plugin has the same access as Neo', () => {
    renderDisclosure();
    expect(screen.getByText('插件和 Neo 运行在一起，它能看到你的会话内容和其他插件的数据，权限和 Neo 本身一样大。')).toBeTruthy();
  });

  it('V12 scans the exact task copy branches for forbidden implementation terms', () => {
    const leafPaths = (value: unknown, prefix = ''): string[] => {
      if (typeof value === 'string') return [prefix];
      if (Array.isArray(value)) return value.flatMap((child, index) => leafPaths(child, `${prefix}[${index}]`));
      if (value && typeof value === 'object') {
        return Object.entries(value).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
      }
      return [];
    };
    const collectValues = (value: unknown): string[] => {
      if (typeof value === 'string') return [value];
      if (Array.isArray(value)) return value.flatMap(collectValues);
      if (value && typeof value === 'object') return Object.values(value).flatMap(collectValues);
      return [];
    };
    expect(leafPaths(en.settings.plugins.manualImport).sort())
      .toEqual(leafPaths(zh.settings.plugins.manualImport).sort());
    expect(leafPaths(en.settings.privacy.pluginUi).sort())
      .toEqual(leafPaths(zh.settings.privacy.pluginUi).sort());
    const copy = [
      ...collectValues(zh.settings.plugins.manualImport),
      ...collectValues(zh.settings.privacy.pluginUi),
      ...collectValues(en.settings.plugins.manualImport),
      ...collectValues(en.settings.privacy.pluginUi),
    ].join('\n');

    expect(copy).not.toMatch(/\bslot\b|\breplaceRisk\b|\bkind\b|\bchain\b|座位/iu);
  });
});
