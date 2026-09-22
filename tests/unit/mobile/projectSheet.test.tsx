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
 * fix5-③（2026-09-15 build 36 反馈⑦）：项目 sheet 重做成「选择项目」——主层=选择器
 * （名称+副标题+同名路径消歧+底部 note），项目会话=同弹层前进页（带返回），
 * 新建会话名称默认留空。LanCompanionClient 整个 mock 掉（sheetLibraryWait 的形态）。
 */
const harness = vi.hoisted(() => ({ createSessionIds: [] as string[] }));

vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    async recover() {
      return { version: 1 as const, endpoint: 'http://192.168.1.2:8182', altEndpoint: 'http://imac.local:8182', hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['project:one', 'project:two'] };
    }
    async request(payload: unknown) {
      const action = (payload as { action?: string }).action;
      if (action === 'read') return {
        nextOffset: null,
        projects: [
          { id: 'one', name: 'workspace', canCreate: true, workspacePath: '/Users/neo/Downloads/ai/workspace' },
          { id: 'two', name: 'workspace', canCreate: false, workspacePath: '/private/tmp/neo-verify/workspace' },
        ],
        sessions: [
          { id: 's1', title: '品牌定位研究', projectId: 'two', updatedAt: 2, archived: false, provider: 'deepseek', model: 'deepseek-chat' },
        ],
        models: [{ provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek Chat', providerLabel: 'DeepSeek', isDefault: true }],
      };
      if (action === 'command') {
        const command = (payload as { command?: { commandId?: string; deviceId?: string; sessionId?: string | null; action?: string } }).command;
        if (command?.action === 'session.create') harness.createSessionIds.push(String(command.sessionId));
        // 结算记录必须带原命令的身份（companionAckMatches 认 commandId/deviceId/sessionId/action）
        return { kind: 'accepted', command: { commandId: command?.commandId ?? '', deviceId: command?.deviceId ?? 'phone-1', sessionId: command?.sessionId ?? null, action: command?.action ?? '', state: 'resolved', createdAt: 1, result: command?.action === 'session.create' ? { sessionId: 'mobile-new-1' } : {} } };
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
    binding: { version: 1, endpoint: 'http://192.168.1.2:8182', altEndpoint: 'http://imac.local:8182', hostKey: toHex(identity.publicKey), deviceId: 'phone-1', scopeEpoch: 1, scope: ['project:one', 'project:two'] },
  });
}

const ports = (): PlatformPorts => ({
  preferences: { get: async () => null, set: async () => {} },
  appInfo: { read: async () => ({ version: '0.1.0', build: '36' }) },
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

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); harness.createSessionIds = []; cleanup(); });

/** 只授权项目 ⇒ 连上停在欢迎页；点项目选择器打开「选择项目」主层（N-MOBILE-DEFAULT-PROJECT：不再自动弹）。 */
async function mountOnProjectPicker() {
  await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
  fireEvent.click(await waitFor(() => { const el = document.querySelector('[data-testid="project-pick"]') as HTMLElement; expect(el).toBeTruthy(); return el; }));
  await waitFor(() => { expect(document.querySelector('.project-list')).toBeTruthy(); });
  return document.querySelector('.sheet-layer') as HTMLElement;
}

describe('项目选择器主层（fix5-③）', () => {
  it('主层是选择器：每行名称+副标题，同名项目用父目录路径消歧，底部一行 note', async () => {
    await mountOnProjectPicker();
    expect((document.querySelector('#sheet-title') as HTMLElement).textContent).toBe(text.chooseProject);
    expect(document.querySelector('[data-testid="project-one"]')!.textContent).toContain('workspace · ~/Downloads/ai');
    expect(document.querySelector('[data-testid="project-one"]')!.textContent).toContain('0 个会话');
    expect(document.querySelector('[data-testid="project-two"]')!.textContent).toContain('workspace · /private/tmp/neo-verify');
    expect(document.querySelector('[data-testid="project-two"]')!.textContent).toContain('最近使用 · 1 个会话');
    expect(document.querySelector('.sheet-note')!.textContent).toBe(text.projectScopeNote);
    // 主层不再堆会话列表/新建表单/高级选项
    expect(document.querySelector('.project-list')!.querySelector('[data-testid="session-s1"]')).toBeNull();
    expect(document.querySelector('.project-list')!.querySelector('.advanced')).toBeNull();
  });

  it('点可建项目 = 选中即在该项目起新会话并返回输入框（sheet 关、草稿键切到新会话）', async () => {
    await mountOnProjectPicker();
    // 先在输入框打半句话——「草稿不丢」要在会话建立后跟过去
    const composer = document.querySelector('.composer textarea, .composer input') as HTMLInputElement | null;
    if (composer) fireEvent.change(composer, { target: { value: '帮我整理' } });
    fireEvent.click(document.querySelector('[data-testid="project-one"] .project-main') as HTMLElement);
    await waitFor(() => { expect(harness.createSessionIds).toEqual(['project:one']); });
    // 命令结算后 sessionId 置上、sheet 收掉、回到输入框
    await waitFor(() => { expect(document.querySelector('.sheet-layer')).toBeNull(); });
    await waitFor(() => { expect((document.querySelector('.topbar strong') as HTMLElement).textContent).toContain(text.sharedSession); });
  });

  it('不能新建的项目点行进前进页（继续已有工作），chevron 同样进前进页', async () => {
    await mountOnProjectPicker();
    fireEvent.click(document.querySelector('[data-testid="project-two"] .project-main') as HTMLElement);
    await waitFor(() => { expect(document.querySelector('[data-page="projectSessions"]')).toBeTruthy(); });
    expect((document.querySelector('#sheet-title') as HTMLElement).textContent).toBe('workspace · /private/tmp/neo-verify');
    expect(document.querySelector('[data-testid="session-s1"]')).toBeTruthy();
    expect(document.querySelector('.project-list')).toBeNull();
    // 返回弹回主层，主层还在
    fireEvent.click(document.querySelector('.sheet-header button[aria-label="返回上一级"]') as HTMLElement);
    await waitFor(() => { expect(document.querySelector('.project-list')).toBeTruthy(); });
    // 主层 chevron 也能进前进页（可建项目走这条继续已有工作）
    fireEvent.click(document.querySelector('[data-testid="project-one"] .project-more') as HTMLElement);
    await waitFor(() => { expect(document.querySelector('[data-page="projectSessions"]')).toBeTruthy(); });
  });
});

describe('项目会话前进页（projectSessions）', () => {
  async function openForwardPage(projectId: string) {
    await mountOnProjectPicker();
    fireEvent.click(document.querySelector(`[data-testid="project-${projectId}"] .project-more`) as HTMLElement);
    await waitFor(() => { expect(document.querySelector('[data-page="projectSessions"]')).toBeTruthy(); });
  }

  it('继续已有工作：点会话行 = 选中并回输入框（sheet 收、会话切换）', async () => {
    await openForwardPage('two');
    fireEvent.click(document.querySelector('[data-testid="session-s1"]') as HTMLElement);
    await waitFor(() => { expect(document.querySelector('.sheet-layer')).toBeNull(); });
    expect((document.querySelector('.topbar strong') as HTMLElement).textContent).toBe('品牌定位研究');
  });

  it('新建会话名称默认留空（placeholder 引导），不预填任何旧会话的标题', async () => {
    await openForwardPage('one');
    const input = document.querySelector('#new-title') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.placeholder).toBe(text.sessionName);
  });

  it('可建项目给「新会话」一步起 + 高级选项二级；点它在该项目建会话', async () => {
    await openForwardPage('one');
    expect(document.querySelector('[data-testid="start-session"]')).toBeTruthy();
    expect(document.querySelector('.advanced summary')!.textContent).toBe(text.advancedOptions);
    fireEvent.click(document.querySelector('[data-testid="start-session"]') as HTMLElement);
    await waitFor(() => { expect(harness.createSessionIds).toEqual(['project:one']); });
    await waitFor(() => { expect(document.querySelector('.sheet-layer')).toBeNull(); });
  });
});
