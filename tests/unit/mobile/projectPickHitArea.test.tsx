// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { MobileRoot } from '../../../packages/mobile/src/app/MobileRoot';
import type { PlatformPorts } from '../../../packages/mobile/src/platform/ports';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../src/shared/companion/lanProtocol';

/**
 * N-MOBILE-PROJECTPICK-HITAREA（FB-181）：胶囊外观 36pt 不变，::after 上下各扩 4pt。
 * 模拟器验收用 elementFromPoint 在胶囊外上下 3pt 命中；这里钉 CSS（getBoundingClientRect 不含伪元素）。
 */
const css = readFileSync('packages/mobile/src/styles.css', 'utf8');

describe('project-pick 点按区', () => {
  it('视觉仍是 36pt 胶囊（padding/边框/底色不变），不可见点按区上下各扩 4pt', () => {
    const rule = css.match(/\.project-pick \{[^}]+\}/)?.[0] ?? '';
    expect(rule).toContain('position: relative');
    expect(rule).toContain('min-height: 36px');
    expect(rule).toContain('padding: 6px 12px');
    expect(rule).toContain('background: var(--surface)');
    expect(rule).toContain('border: 1px solid var(--line)');
    expect(rule).not.toContain('padding: 10px');
    const after = css.match(/\.project-pick::after \{[^}]+\}/)?.[0] ?? '';
    expect(after).toMatch(/content: ''/);
    expect(after).toContain('position: absolute');
    expect(after).toContain('inset: -4px 0');
  });
});

vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    async recover() {
      return { version: 1 as const, endpoint: 'http://192.168.1.2:8182', hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['project:one'] };
    }
    async request(payload: unknown) {
      const action = (payload as { action?: string }).action;
      if (action === 'read') {
        const query = (payload as { query?: { kind?: string } }).query;
        if (query?.kind === 'history') return { sessionId: 'none', messages: [], nextOffset: null };
        if (query?.kind === 'artifacts') return { sessionId: 'none', artifacts: [] };
        return {
          nextOffset: null,
          projects: [{ id: 'one', name: '未分类', canCreate: true }],
          sessions: [],
          models: [{ provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek', providerLabel: 'DeepSeek', isDefault: true }],
        };
      }
      return { kind: 'events', epoch: 1, nextSeq: 0, events: [] };
    }
    close() {}
  },
}));

function saved(): string {
  const identity = createIdentity();
  return JSON.stringify({
    version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
    binding: { version: 1, endpoint: 'http://192.168.1.2:8182', hostKey: toHex(identity.publicKey), deviceId: 'phone-1', scopeEpoch: 1, scope: ['project:one'] },
  });
}

const ports = (): PlatformPorts => ({
  preferences: { get: async () => null, set: async () => {} },
  appInfo: { read: async () => ({ version: '0.1.0', build: '51' }) },
  lifecycle: { subscribe: async () => () => {}, leave: async () => {} },
  keyboard: { subscribe: async () => () => {}, subscribeFrame: async () => () => {}, hide: async () => {} },
  companion: { read: async () => saved(), write: async () => {}, scan: async () => { throw new Error('unused'); }, post: async () => ({}) },
});

/**
 * 验收合同：胶囊 getBoundingClientRect 不含伪元素，点在上下 3pt 处仍应命中 project-pick。
 * jsdom 没有布局，用与 ::after inset:-4px 0 等价的命中判定钉这个几何。
 */
function hitsProjectPick(rect: { top: number; bottom: number; left: number; right: number }, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top - 4 && y <= rect.bottom + 4;
}

describe('欢迎页 project-pick 可定位，上下 3pt 落在扩展点按区', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }));
    Object.defineProperty(window.navigator, 'language', { value: 'zh-CN', configurable: true });
  });
  afterEach(() => { vi.unstubAllGlobals(); cleanup(); });

  it('欢迎页挂着 data-testid=project-pick；胶囊外上下 3pt 算命中', async () => {
    await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
    const pick = await waitFor(() => {
      const el = document.querySelector('[data-testid="project-pick"]') as HTMLElement;
      expect(el).toBeTruthy();
      return el;
    });
    const rect = { top: 200, bottom: 236, left: 100, right: 210 };
    expect(hitsProjectPick(rect, 150, 197)).toBe(true);
    expect(hitsProjectPick(rect, 150, 239)).toBe(true);
    expect(hitsProjectPick(rect, 150, 195)).toBe(false);
    expect(pick.getBoundingClientRect()).toBeTruthy();
  });
});
