// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MobileRoot } from '../../../packages/mobile/src/app/MobileRoot';
import type { PlatformPorts } from '../../../packages/mobile/src/platform/ports';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../src/shared/companion/lanProtocol';
import { COMPANION_LIMITS } from '../../../src/shared/constants/companion';
import { messages } from '../../../packages/mobile/src/i18n';

/**
 * N-MOBILE-PENDING-NOISE（爸 2026-09-16 build 43 真机「刚点消息发送，为什么要出这样一句提示」）。
 * taskStatusCopy 的纯函数分支已在 taskStatusCopy.test.ts 钉住；这里钉的是**接线**：
 * MobileRoot 真的会先闭嘴、到点才说。少了这一层，闸门就是「装好没接电」——
 * 纯函数怎么改都绿，而真机上照旧一发就弹。
 * 命令发出去就吊着（Host 不回 ack），pending 一直为真，闸门是唯一决定说不说的东西。
 */
const harness = vi.hoisted(() => ({ hangCommand: true }));

vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    async recover() {
      return { version: 1 as const, endpoint: 'http://192.168.1.2:8182', hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['s1'] };
    }
    async request(payload: unknown) {
      const action = (payload as { action?: string }).action;
      if (action === 'read') {
        const query = (payload as { query?: { kind?: string; sessionId?: string } }).query;
        if (query?.kind === 'history') return { sessionId: query.sessionId, messages: [], nextOffset: null };
        if (query?.kind === 'artifacts') return { sessionId: query.sessionId, artifacts: [] };
        return {
          nextOffset: null,
          sessions: [{ id: 's1', title: '会话一', projectId: null, updatedAt: 2, archived: false, provider: 'deepseek', model: 'deepseek-chat' }],
          projects: [],
          models: [{ provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek Chat', providerLabel: 'DeepSeek', isDefault: true }],
        };
      }
      // 命令永远不结算：pending 保持为真，说不说话全看闸门
      if (action === 'command' && harness.hangCommand) return new Promise(() => {});
      if (action === 'status') return null;
      return { kind: 'events', epoch: 1, nextSeq: 0, events: [] };
    }
    close() {}
  },
}));

function saved(): string {
  const identity = createIdentity();
  return JSON.stringify({
    version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
    binding: { version: 1, endpoint: 'http://192.168.1.2:8182', hostKey: toHex(identity.publicKey), deviceId: 'phone-1', scopeEpoch: 1, scope: ['s1'] },
  });
}

const ports = (): PlatformPorts => ({
  preferences: { get: async () => null, set: async () => {} },
  appInfo: { read: async () => ({ version: '0.1.0', build: '44' }) },
  lifecycle: { subscribe: async () => () => {}, leave: async () => {} },
  keyboard: { subscribe: async () => () => {}, subscribeFrame: async () => () => {}, hide: async () => {} },
  companion: { read: async () => saved(), write: async () => {}, scan: async () => { throw new Error('unused'); }, post: async () => ({}) },
});

const text = messages('zh');
const statusRow = () => document.querySelector('.task-status')?.textContent ?? '';

beforeEach(() => {
  harness.hangCommand = true;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
  Object.defineProperty(window.navigator, 'language', { value: 'zh-CN', configurable: true });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); cleanup(); });

describe('「正在核对电脑是否已接收」要憋过阈值才说（接线层）', () => {
  it('刚点发送时状态行不出现那句话；过了阈值才出现', async () => {
    await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
    await waitFor(() => { expect(document.querySelector('[data-testid="draft"]')).toBeTruthy(); });

    // 闸门用的是发送那一刻起的 setTimeout。必须**先**换成假时钟再发送——发完再换，
    // 那个真时钟的定时器就不归假时钟管，advanceTimersByTime 推不动它（实测踩过）。
    vi.useFakeTimers();
    fireEvent.change(document.querySelector('[data-testid="draft"]') as HTMLTextAreaElement, { target: { value: '你好' } });
    await act(async () => { fireEvent.click(document.querySelector('[data-testid="send"]') as HTMLElement); });

    // 「阈值之内没有那句话」单独看是恒真判据（pending 压根没起也会满足）。撑住它的是下面
    // 那条：过了阈值它**出现了**——只有 pending 全程为真才可能出现。两条合起来才是判据。
    expect(statusRow()).not.toContain(text.pendingCommand);

    await act(async () => { await vi.advanceTimersByTimeAsync(COMPANION_LIMITS.pendingNoticeDelayMs + 50); });
    expect(statusRow()).toContain(text.pendingCommand);
  });
});
