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
 * N-MOBILE-STATUS-NOISE 接线层：MobileRoot 真的只挂一个状态位。纯函数的优先级逐对在 statusSlot.test.tsx。
 * build 50 真机 00:03：电脑没回应时输入框上方叠了四行（连接胶囊 / 未确认送达 / 读取失败 / 会话没建成）。
 */
const harness = vi.hoisted(() => ({ offline: false, hangSend: false }));

vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    async recover() {
      return { version: 1 as const, endpoint: 'http://192.168.1.2:8182', hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['project:one', 's1'] };
    }
    async request(payload: unknown) {
      const action = (payload as { action?: string }).action;
      if (harness.offline) throw new Error('COMPANION_NO_RESPONSE');
      if (action === 'read') {
        const query = (payload as { query?: { kind?: string; sessionId?: string } }).query;
        if (query?.kind === 'history') return { sessionId: query.sessionId, messages: [], nextOffset: null };
        if (query?.kind === 'artifacts') return { sessionId: query.sessionId, artifacts: [] };
        return {
          nextOffset: null,
          projects: [{ id: 'one', name: 'One', canCreate: true, workspacePath: '/w/one' }],
          sessions: [{ id: 's1', title: '你好', projectId: 'one', updatedAt: 2, archived: false, provider: 'longcat', model: 'LongCat-2.0' }],
          models: [{ provider: 'longcat', model: 'LongCat-2.0', label: 'LongCat-2.0', providerLabel: 'LongCat', isDefault: true }],
        };
      }
      if (action === 'command') {
        if (harness.hangSend) return new Promise(() => {});
        const command = (payload as { command: { commandId: string; deviceId: string; sessionId: string; action: string } }).command;
        return { kind: 'accepted', command: { ...command, state: 'resolved', createdAt: 1, result: { runId: 'run-1' } } };
      }
      if (action === 'status') return null;
      return { kind: 'events', epoch: 1, nextSeq: 0, events: [] };
    }
    close() {}
  },
}));

function savedWithBinding(): string {
  const identity = createIdentity();
  return JSON.stringify({
    version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
    binding: { version: 1, endpoint: 'http://192.168.1.2:8182', hostKey: toHex(identity.publicKey), deviceId: 'phone-1', scopeEpoch: 1, scope: ['project:one', 's1'] },
  });
}

const ports = (): PlatformPorts => ({
  preferences: { get: async () => null, set: async () => {} },
  appInfo: { read: async () => ({ version: '0.1.0', build: '50' }) },
  lifecycle: { subscribe: async () => () => {}, leave: async () => {} },
  keyboard: { subscribe: async () => () => {}, subscribeFrame: async () => () => {}, hide: async () => {} },
  companion: { read: async () => savedWithBinding(), write: async () => {}, scan: async () => { throw new Error('unused'); }, post: async () => ({}) },
});

const text = messages('zh');
const slots = () => [...document.querySelectorAll('[data-testid="status-slot"]')] as HTMLElement[];
/** 输入区里除了状态位之外，旧的那几种提示容器一个都不许再出现。 */
const legacyRows = () => document.querySelectorAll('.composer-area .notice, .composer-area .task-status, .composer-area .connection-pill, .composer-area .voice-notice').length;

beforeEach(() => {
  harness.offline = false;
  harness.hangSend = false;
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
  await waitFor(() => { expect((document.querySelector('.topbar strong') as HTMLElement).textContent).toBe('你好'); });
}

describe('已连接不说话', () => {
  it('连着、没在跑：没有状态位；发出任务在跑时也没有（去掉「已连接电脑」常驻胶囊）', async () => {
    await mountInSession();
    // 前提自证：确实连上了（库读到、模型胶囊出来了）
    await waitFor(() => { expect(document.querySelector('.composer-tools .model')).toBeTruthy(); });
    expect(slots()).toHaveLength(0);
    expect(legacyRows()).toBe(0);
    fireEvent.change(document.querySelector('[data-testid="draft"]') as HTMLTextAreaElement, { target: { value: '你好' } });
    fireEvent.click(document.querySelector('[data-testid="send"]') as HTMLElement);
    await waitFor(() => { expect(document.querySelector('[data-testid="send-stop"]')).toBeTruthy(); });
    expect(slots()).toHaveLength(0);
    expect(legacyRows()).toBe(0);
  });

  it('空会话只留一句 + 项目选择器', async () => {
    await mountInSession();
    const empty = await waitFor(() => { const el = document.querySelector('[data-testid="session-empty"]') as HTMLElement; expect(el).toBeTruthy(); return el; });
    expect(empty.querySelector('h1')!.textContent).toBe(text.welcome);
    expect(empty.querySelector('[data-testid="project-pick"]')!.textContent).toBe('One');
    // 除了标题与选择器，欢迎区里没有别的字
    expect(empty.textContent).toBe(`${text.welcome}One`);
  });
});

describe('build 50 场景：电脑没回应时只有一条', () => {
  it('断连后点发送：只见「连不上电脑」+ 重新连接；点文字打开连接电脑弹层', async () => {
    await mountInSession();
    await waitFor(() => { expect(document.querySelector('.composer-tools .model')).toBeTruthy(); });
    harness.offline = true;
    // 轮询（1 秒一拍）踩空把连接收成 offline
    await waitFor(() => { expect(slots()[0]?.textContent).toContain(text.cannotReachComputer); }, { timeout: 4000 });
    fireEvent.change(document.querySelector('[data-testid="draft"]') as HTMLTextAreaElement, { target: { value: '整理一下' } });
    fireEvent.click(document.querySelector('[data-testid="send"]') as HTMLElement);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(slots()).toHaveLength(1);
    expect(slots()[0].querySelector('.status-text')!.textContent).toBe(text.cannotReachComputer);
    expect(slots()[0].querySelector('[data-testid="status-action"]')!.textContent).toBe(text.reconnect);
    expect(legacyRows()).toBe(0);
    // 草稿没丢
    expect((document.querySelector('[data-testid="draft"]') as HTMLTextAreaElement).value).toBe('整理一下');
    fireEvent.click(slots()[0].querySelector('[data-testid="status-open"]')!);
    await waitFor(() => { expect(document.querySelector('[data-testid="remote-unreachable"]')).toBeTruthy(); });
  });
});
