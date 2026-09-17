// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MobileRoot } from '../../../packages/mobile/src/app/MobileRoot';
import type { PlatformPorts } from '../../../packages/mobile/src/platform/ports';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../src/shared/companion/lanProtocol';

/**
 * fix6（2026-09-15 build 37 爸真机：「新会话的 + 点了没反应」）：已配对+已连接+库已加载时
 * 点抽屉里的 +，必须有一个可见结果——成功=收层并进新会话的空会话视图；失败=「会话没建成：…」
 * 提示条（连接诊断三分类复用），且抽屉收起别把提示盖住。LanCompanionClient 整个 mock 掉
 * （projectSheet.test.tsx 的形态），binding 带一条已选会话 s1（不触发自动弹项目 sheet），
 * harness.mode 切换 Host 行为模拟各条失败路。
 */
const harness = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'drop-sync' | 'drop-command' | 'reject-project' | 'reconciling' | 'old-host',
  createSessionIds: [] as string[],
  created: false,
}));

vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    async recover() {
      return { version: 1 as const, endpoint: 'http://192.168.1.2:8182', altEndpoint: 'http://imac.local:8182', hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['project:one', 's1'] };
    }
    async request(payload: unknown) {
      const action = (payload as { action?: string }).action;
      // 断连形态①：轮询踩空 → sync 的 catch 把 status 收成 offline（connectionUnavailable）
      if (harness.mode === 'drop-sync' && action === 'sync') throw new Error('COMPANION_NO_RESPONSE');
      if (action === 'read') {
        const query = (payload as { query?: { kind?: string; sessionId?: string } }).query;
        if (query?.kind === 'history') return { sessionId: query.sessionId, messages: [], nextOffset: null };
        if (query?.kind === 'artifacts') return { sessionId: query.sessionId, artifacts: [] };
        return {
          nextOffset: null,
          sessions: [
            { id: 's1', title: '会话一', projectId: 'one', updatedAt: 2, archived: false, provider: 'deepseek', model: 'deepseek-chat' },
            ...(harness.created ? [{ id: 'mobile-new-1', title: '新会话', projectId: 'one', updatedAt: 3, archived: false, provider: 'deepseek', model: 'deepseek-chat' }] : []),
          ],
          projects: [{ id: 'one', name: '工作项目', canCreate: true, workspacePath: '/Users/neo/Downloads/ai/workspace' }],
          models: harness.mode === 'old-host'
            ? [{ provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek Chat', providerLabel: 'DeepSeek' }]
            : [{ provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek Chat', providerLabel: 'DeepSeek', isDefault: true }],
        };
      }
      if (action === 'command') {
        const command = (payload as { command?: { commandId?: string; deviceId?: string; sessionId?: string | null; action?: string } }).command;
        if (command?.action === 'session.create') harness.createSessionIds.push(String(command.sessionId));
        // 断连形态②：点 + 那一刻命令发不出去（persist 已落，deliver 抛错 → safely 收 offline）
        if (harness.mode === 'drop-command') throw new Error('COMPANION_NO_RESPONSE');
        if (command?.action === 'session.create') {
          if (harness.mode === 'reject-project') return { kind: 'rejected', reason: 'COMPANION_PROJECT_UNAVAILABLE' };
          // 结算一直没到（reconciling）：槽保持占用，第二条 session.create 会被守卫挡下
          if (harness.mode === 'reconciling') return { kind: 'accepted', command: { commandId: command.commandId, deviceId: command.deviceId, sessionId: command.sessionId, action: command.action, state: 'reconciling', createdAt: 1, result: {} } };
          harness.created = true;
        }
        // 结算记录必须带原命令的身份（companionAckMatches 认 commandId/deviceId/sessionId/action）
        return { kind: 'accepted', command: { commandId: command?.commandId ?? '', deviceId: command?.deviceId ?? 'phone-1', sessionId: command?.sessionId ?? null, action: command?.action ?? '', state: 'resolved', createdAt: 1, result: command?.action === 'session.create' ? { sessionId: 'mobile-new-1' } : {} } };
      }
      if (action === 'status') {
        if (harness.mode === 'reconciling') {
          const commandId = (payload as { commandId?: string }).commandId;
          return { commandId, deviceId: 'phone-1', sessionId: 'project:one', action: 'session.create', state: 'reconciling', createdAt: Date.now(), result: {} };
        }
        return null;
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
    binding: { version: 1, endpoint: 'http://192.168.1.2:8182', altEndpoint: 'http://imac.local:8182', hostKey: toHex(identity.publicKey), deviceId: 'phone-1', scopeEpoch: 1, scope: ['project:one', 's1'] },
  });
}

const ports = (): PlatformPorts => ({
  preferences: { get: async () => null, set: async () => {} },
  appInfo: { read: async () => ({ version: '0.1.0', build: '37' }) },
  lifecycle: { subscribe: async () => () => {}, leave: async () => {} },
  keyboard: { subscribe: async () => () => {}, subscribeFrame: async () => () => {}, hide: async () => {} },
  companion: { read: async () => savedWithBinding(), write: async () => {}, scan: async () => { throw new Error('unused'); }, post: async () => ({}) },
});

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
  Object.defineProperty(window.navigator, 'language', { value: 'zh-CN', configurable: true });
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); harness.mode = 'ok'; harness.created = false; harness.createSessionIds = []; cleanup(); });

/** 挂载到「已配对+已连接+库已加载、s1 已选中」——顶栏出现会话名即三者齐了。 */
async function mountConnected() {
  await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
  await waitFor(() => { expect((document.querySelector('.topbar strong') as HTMLElement).textContent).toBe('会话一'); }, { timeout: 3000 });
  return document.querySelector('.app') as HTMLElement;
}

/** 打开抽屉并点 +（data-testid="new-session"）。 */
async function tapNewSessionPlus() {
  fireEvent.click(document.querySelector('[data-testid="open-drawer"]') as HTMLElement);
  const plus = await waitFor(() => {
    const el = document.querySelector('[data-testid="new-session"]') as HTMLElement;
    expect(el).toBeTruthy();
    return el;
  });
  fireEvent.click(plus);
}

// 失败反馈落在输入区唯一状态位（N-MOBILE-STATUS-NOISE）。
const noticeText = () => (document.querySelector('[data-testid="status-slot"]') as HTMLElement | null)?.textContent ?? '';

describe('fix6-①：创建成功的可见结果', () => {
  it('点 + 收抽屉、顶栏切到新会话、进空会话就绪态（不再是无会话欢迎屏的原地不动）', async () => {
    await mountConnected();
    await tapNewSessionPlus();
    // 参数面锚点：title/provider/model + project scope——09-11 旧 Host 已认的形状
    await waitFor(() => { expect(harness.createSessionIds).toEqual(['project:one']); });
    await waitFor(() => { expect(document.querySelector('.drawer-layer')).toBeNull(); });
    await waitFor(() => { expect((document.querySelector('.topbar strong') as HTMLElement).textContent).toBe('新会话'); });
    // 空会话只留一句 + 项目选择器（design.md §12，爸 09-17）：与原会话可区分靠顶栏的新会话名与选择器上的项目
    await waitFor(() => { expect(document.querySelector('[data-testid="session-empty"]')).toBeTruthy(); });
    expect((document.querySelector('[data-testid="session-empty"] h1') as HTMLElement).textContent).toBe('有什么想交给 Neo？');
    expect(document.querySelector('[data-testid="session-empty"] [data-testid="project-pick"]')!.textContent).toBe('工作项目');
    expect(document.querySelector('[data-testid="session-empty"]')!.textContent).not.toContain('输入任务');
  });
});

describe('fix6-②：创建失败的可见反馈（manage 不再静默吞错）', () => {
  // N-MOBILE-STATUS-NOISE 之后：断连期间「会话没建成」是连带后果，只说断连那一条（原因诊断在连接电脑弹层里）。
  it('已断连时点 +：命令没发出去也不静默——收抽屉，状态位只说「连不上电脑」', async () => {
    await mountConnected();
    harness.mode = 'drop-sync';
    // 轮询（1s 一拍）踩空后状态位落到「连不上电脑」——此后抽屉照常可用，正是爸的现场
    await waitFor(() => { expect(noticeText()).toContain('连不上电脑'); }, { timeout: 4000 });
    await tapNewSessionPlus();
    await waitFor(() => { expect(harness.createSessionIds).toEqual([]); });   // 守卫挡下：根本没发
    await waitFor(() => { expect(document.querySelector('.drawer-layer')).toBeNull(); });
    expect(document.querySelectorAll('[data-testid="status-slot"]')).toHaveLength(1);
    expect(noticeText()).toBe('连不上电脑重新连接');
  });

  it('点 + 那一刻断连（命令在飞时掉线）：同样只说「连不上电脑」，不静默', async () => {
    await mountConnected();
    harness.mode = 'drop-command';
    await tapNewSessionPlus();
    await waitFor(() => { expect(harness.createSessionIds).toEqual(['project:one']); });
    await waitFor(() => { expect(document.querySelector('.drawer-layer')).toBeNull(); });
    await waitFor(() => { expect(noticeText()).toBe('连不上电脑重新连接'); });
  });

  it('Host 拒绝（如项目不可用）：提示点名是「会话没建成」，会话不换', async () => {
    await mountConnected();
    harness.mode = 'reject-project';
    await tapNewSessionPlus();
    await waitFor(() => { expect(harness.createSessionIds).toEqual(['project:one']); });
    await waitFor(() => { expect(document.querySelector('.drawer-layer')).toBeNull(); });
    await waitFor(() => { expect(noticeText()).toContain('会话没建成'); });
    expect(noticeText()).toContain('所选项目当前不可用');
    expect(document.querySelector('[data-testid="status-action"]')!.textContent).toBe('重试');
    expect((document.querySelector('.topbar strong') as HTMLElement).textContent).toBe('会话一');
  });

  it('上一条 session.create 还没结算（reconciling 占槽）：再点 + 报「上一条还没核对完」，不重复发', async () => {
    await mountConnected();
    harness.mode = 'reconciling';
    await tapNewSessionPlus();
    await waitFor(() => { expect(harness.createSessionIds).toHaveLength(1); });
    // 第二次点 +：守卫挡下但必须有反馈
    await tapNewSessionPlus();
    await waitFor(() => { expect(harness.createSessionIds).toHaveLength(1); });
    await waitFor(() => { expect(noticeText()).toContain('会话没建成'); });
    expect(noticeText()).toContain('上一条操作还没核对完');
  });

  it('旧版电脑端不标 isDefault（列表非空）：点 + 回落列表第一项建会话，不静默失败', async () => {
    harness.mode = 'old-host';
    await mountConnected();
    await tapNewSessionPlus();
    await waitFor(() => { expect(harness.createSessionIds).toEqual(['project:one']); });
    await waitFor(() => { expect((document.querySelector('.topbar strong') as HTMLElement).textContent).toBe('新会话'); });
    // 不显示「电脑上还没有能用的模型」——列表里明明有模型
    expect(noticeText()).not.toContain('电脑上还没有能用的模型');
  });
});
