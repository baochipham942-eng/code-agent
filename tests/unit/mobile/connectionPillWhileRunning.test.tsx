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
 * 爸 2026-09-16 真机：任务在跑时「已连接电脑」和执行条同时出现——执行条已经说明电脑在处理，连着不言自明。
 * 在跑时收起连接那一行；没在跑时照常显示。
 */
vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    async recover() {
      return { version: 1 as const, endpoint: 'http://192.168.1.2:8182', hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['project:one'] };
    }
    async request(payload: unknown) {
      const action = (payload as { action?: string }).action;
      if (action === 'read') return {
        nextOffset: null,
        projects: [{ id: 'one', name: 'One', canCreate: true, workspacePath: '/w/one' }],
        sessions: [{ id: 's1', title: '你好', projectId: 'one', updatedAt: 2, archived: false, provider: 'longcat', model: 'LongCat-2.0' }],
        models: [{ provider: 'longcat', model: 'LongCat-2.0', label: 'LongCat-2.0', providerLabel: 'LongCat', isDefault: true }],
      };
      if (action === 'command') {
        const command = (payload as { command: { commandId: string; deviceId: string; sessionId: string; action: string } }).command;
        return { kind: 'accepted', command: { ...command, state: 'resolved', createdAt: 1, result: { runId: 'run-1' } } };
      }
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

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
  Object.defineProperty(window.navigator, 'language', { value: 'zh-CN', configurable: true });
});
afterEach(() => { vi.unstubAllGlobals(); cleanup(); });

describe('执行中不重复说「已连接电脑」', () => {
  it('没在跑时显示连接那一行；发出任务、电脑开始处理后收起', async () => {
    await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
    await waitFor(() => { expect(document.querySelector('.project-list')).toBeTruthy(); });
    fireEvent.click(document.querySelector('.sheet-layer .scrim') as HTMLElement);
    fireEvent.click(document.querySelector('[data-testid="open-drawer"]') as HTMLElement);
    fireEvent.click(await waitFor(() => { const el = document.querySelector('[data-testid="session-s1"]'); expect(el).toBeTruthy(); return el as HTMLElement; }));
    // 前提自证：连上、没在跑时那一行在
    await waitFor(() => { expect(document.querySelector('.connection-pill')?.textContent).toContain(text.connected); });
    expect(document.querySelector('[data-testid="send-stop"]')).toBeNull();
    fireEvent.change(document.querySelector('[data-testid="draft"]') as HTMLTextAreaElement, { target: { value: '你好' } });
    fireEvent.click(document.querySelector('[data-testid="send"]') as HTMLElement);
    // 在跑（输入区的键变成停止）时连接那一行不在
    await waitFor(() => { expect(document.querySelector('[data-testid="send-stop"]')).toBeTruthy(); });
    expect(document.querySelector('.connection-pill')).toBeNull();
  });
});
