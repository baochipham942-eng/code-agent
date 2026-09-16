// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MobileRoot } from '../../../packages/mobile/src/app/MobileRoot';
import type { PlatformPorts } from '../../../packages/mobile/src/platform/ports';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../src/shared/companion/lanProtocol';
import { messages } from '../../../packages/mobile/src/i18n';

/**
 * N-MOBILE-SESSIONSHEET-SPLIT + N-MOBILE-RUNFAIL-REASON（爸 2026-09-16 build 45 真机）：
 * 模型入口只留输入区胶囊，打开独立的「选择会话模型」；「会话操作」里不再有模型。
 * 会话里模型密钥用不了的失败卡给「换一个可用模型」，落点就是同一屏（execStatusInline 覆盖卡片本身）。
 */
const reads = vi.hoisted(() => ({ library: 0 }));
vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    async recover() {
      return { version: 1 as const, endpoint: 'http://192.168.1.2:8182', hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['project:one'] };
    }
    async request(payload: unknown) {
      const action = (payload as { action?: string }).action;
      if (action === 'read' && (payload as { query?: { kind?: string } }).query?.kind === 'library') reads.library += 1;
      if (action === 'read') return {
        nextOffset: null,
        projects: [{ id: 'one', name: 'One', canCreate: true, workspacePath: '/w/one' }],
        sessions: [{ id: 's1', title: '你好', projectId: 'one', updatedAt: 2, archived: false, provider: 'custom-team-relay', model: 'LongCat-2.0' }],
        models: [
          { provider: 'custom-team-relay', model: 'LongCat-2.0', label: 'LongCat 2.0', providerLabel: 'Team Relay', isDefault: true, recentlyFailed: true },
          { provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek Chat', providerLabel: 'DeepSeek' },
        ],
      };
            return { kind: 'events', epoch: 1, nextSeq: 0, events: [] };
    }
    close() {}
  },
}));

function savedWithBinding(): string {
  const identity = createIdentity();
  return JSON.stringify({
    version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
    binding: { version: 1, endpoint: 'http://192.168.1.2:8182', hostKey: toHex(identity.publicKey), deviceId: 'phone-1', scopeEpoch: 1, scope: ['project:one'] },
  });
}

const ports = (): PlatformPorts => ({
  preferences: { get: async () => null, set: async () => {} },
  appInfo: { read: async () => ({ version: '0.1.0', build: '46' }) },
  lifecycle: { subscribe: async () => () => {}, leave: async () => {} },
  keyboard: { subscribe: async () => () => {}, subscribeFrame: async () => () => {}, hide: async () => {} },
  companion: { read: async () => savedWithBinding(), write: async () => {}, scan: async () => { throw new Error('unused'); }, post: async () => ({}) },
});

const text = messages('zh');
const title = () => (document.querySelector('#sheet-title') as HTMLElement | null)?.textContent;

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
  Object.defineProperty(window.navigator, 'language', { value: 'zh-CN', configurable: true });
});
afterEach(() => { vi.unstubAllGlobals(); cleanup(); });

async function mountInSession() {
  await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
  // 只授权项目 ⇒ 连上先弹「选择项目」；收掉，从抽屉进已有会话
  await waitFor(() => { expect(document.querySelector('.project-list')).toBeTruthy(); });
  fireEvent.click(document.querySelector('.sheet-layer .scrim') as HTMLElement);
  fireEvent.click(document.querySelector('[data-testid="open-drawer"]') as HTMLElement);
  fireEvent.click(await waitFor(() => document.querySelector('[data-testid="session-s1"]') as HTMLElement));
  await waitFor(() => { expect(document.querySelector('.composer-tools .model')).toBeTruthy(); });
}

describe('模型入口只留输入区胶囊', () => {
  it('胶囊打开「选择会话模型」；「会话操作」里没有模型', async () => {
    await mountInSession();
    expect(document.querySelector('.composer-tools .model')!.textContent).toContain('LongCat 2.0');
    const before = reads.library;
    fireEvent.click(document.querySelector('.composer-tools .model') as HTMLElement);
    await waitFor(() => { expect(title()).toBe(text.chooseModel); });
    // 打开时现拉一次库：「最近调用失败」是执行失败那一刻才标上的，旧副本里看不到（build 46 远端验收）
    await waitFor(() => { expect(reads.library).toBeGreaterThan(before); });
    expect(document.querySelectorAll('button.model-row')).toHaveLength(2);
    expect(document.querySelector('[data-testid="model-custom-team-relay:LongCat-2.0"]')!.textContent).toContain(text.modelRecentlyFailed);
    fireEvent.click(document.querySelector('.sheet-layer .scrim') as HTMLElement);
    fireEvent.click(document.querySelector('[data-testid="open-more"]') as HTMLElement);
    await waitFor(() => { expect(document.querySelector('.library-sheet')).toBeTruthy(); });
    // 前提自证：确实是会话操作这一屏
    expect(document.querySelector('.library-sheet')!.textContent).toContain(text.rename);
    expect(document.querySelector('.model-row')).toBeNull();
    expect(document.querySelector('.library-sheet select')).toBeNull();
  });
});
