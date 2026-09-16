// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MobileRoot } from '../../../packages/mobile/src/app/MobileRoot';
import { defaultProjectId } from '../../../packages/mobile/src/features/sessions/projectRows';
import type { PlatformPorts } from '../../../packages/mobile/src/platform/ports';
import type { CompanionLibrary } from '../../../src/shared/contract/companionLibrary';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../src/shared/companion/lanProtocol';
import { messages } from '../../../packages/mobile/src/i18n';

/**
 * N-MOBILE-DEFAULT-PROJECT（爸 09-17 拍板 ①A，design.md §11）：新任务欢迎语下一枚项目选择器；
 * 默认 = 手选过的 > 最近一次（手机或电脑）用过的 > 未分类；没选会话点发送直接在所选项目建会话并发出，
 * 不拦截、不出报错行、不出裸「项目」按钮，草稿不丢。build 49 真机图 1/2 是 before。
 */
const text = messages('zh');
const HOST = 'aa'.repeat(32);

const session = (id: string, projectId: string | null, updatedAt: number) =>
  ({ id, title: id, projectId, updatedAt, archived: false, provider: 'deepseek', model: 'deepseek-chat' });
const project = (id: string, name: string, canCreate = true) => ({ id, name, canCreate, workspacePath: `/w/${id}` });

describe('defaultProjectId 三档', () => {
  const lib = (patch: Partial<CompanionLibrary>): CompanionLibrary => ({ nextOffset: null, models: [], projects: [], sessions: [], ...patch });
  const all = [project('one', 'One'), project('two', 'Two'), project('proj_unsorted', '未分类')];

  it('最近一次用过的项目（按 updatedAt，不按列表顺序）', () => {
    expect(defaultProjectId(lib({ projects: all, sessions: [session('a', 'two', 3), session('b', 'one', 9)] }), undefined)).toBe('one');
  });
  it('从未用过 / 最近那个项目建不了 → 未分类', () => {
    expect(defaultProjectId(lib({ projects: all }), undefined)).toBe('proj_unsorted');
    expect(defaultProjectId(lib({ projects: [project('one', 'One', false), ...all.slice(1)], sessions: [session('b', 'one', 9)] }), undefined)).toBe('proj_unsorted');
  });
  it('都建不了 → 不选', () => {
    expect(defaultProjectId(lib({ projects: all.map(p => ({ ...p, canCreate: false })), sessions: [session('b', 'one', 9)] }), undefined)).toBeNull();
  });
  it('手选过且还能建时以手选为准；手选的建不了了就回到规则', () => {
    const library = lib({ projects: all, sessions: [session('b', 'one', 9)] });
    expect(defaultProjectId(library, 'two')).toBe('two');
    expect(defaultProjectId(lib({ projects: [all[0], project('two', 'Two', false), all[2]], sessions: [session('b', 'one', 9)] }), 'two')).toBe('one');
  });
});

const harness = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'reject-create' | 'reconciling' | 'blocked',
  commands: [] as [string, string | null, string?][],
  statusPolls: 0,
  prefs: null as string | null,
  lastCreate: null as Record<string, unknown> | null,
}));

vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    async recover() {
      return { version: 1 as const, endpoint: 'http://192.168.1.2:8182', hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['project:one', 'project:two', 'project:proj_unsorted'] };
    }
    async request(payload: unknown) {
      const action = (payload as { action?: string }).action;
      if (action === 'read') {
        const query = (payload as { query?: { kind?: string; sessionId?: string } }).query;
        if (query?.kind === 'history') return { sessionId: query.sessionId, messages: [], nextOffset: null };
        if (query?.kind === 'artifacts') return { sessionId: query.sessionId, artifacts: [] };
        const blocked = harness.mode === 'blocked';
        return {
          nextOffset: null,
          projects: [
            { id: 'one', name: 'One', canCreate: !blocked, workspacePath: '/w/one' },
            { id: 'two', name: 'Two', canCreate: !blocked, workspacePath: '/w/two' },
            { id: 'proj_unsorted', name: '未分类', canCreate: !blocked },
          ],
          // 电脑上最近用的是 One（updatedAt 最大），列表顺序故意把 Two 放前面
          sessions: [
            { id: 'old', title: '旧会话', projectId: 'two', updatedAt: 3, archived: false, provider: 'deepseek', model: 'deepseek-chat' },
            { id: 'recent', title: '最近会话', projectId: 'one', updatedAt: 9, archived: false, provider: 'deepseek', model: 'deepseek-chat' },
          ],
          models: [
            { provider: 'moonshot', model: 'kimi-k2.6', label: 'Kimi', providerLabel: 'Kimi' },
            { provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek Chat', providerLabel: 'DeepSeek', isDefault: true },
          ],
        };
      }
      if (action === 'command') {
        const command = (payload as { command: { commandId: string; deviceId: string; sessionId: string; action: string; payload: { text?: string; model?: string } } }).command;
        // session.create 记模型（必须是电脑默认那个，不是列表第一项，FB-141），message.send 记正文
        harness.commands.push([command.action, command.sessionId, command.payload.text ?? command.payload.model]);
        const record = (state: string, result: Record<string, unknown>) => ({ commandId: command.commandId, deviceId: command.deviceId, sessionId: command.sessionId, action: command.action, state, createdAt: Date.now(), result });
        if (command.action === 'session.create') {
          if (harness.mode === 'reject-create') return { kind: 'rejected', reason: 'COMPANION_PROJECT_UNAVAILABLE' };
          // ack 先回「还在核对」，之后的 status 轮询才结算：send 必须等到那一刻
          if (harness.mode === 'reconciling') { harness.lastCreate = record('resolved', { sessionId: 'new-1' }); return { kind: 'accepted', command: record('reconciling', {}) }; }
          return { kind: 'accepted', command: record('resolved', { sessionId: 'new-1' }) };
        }
        return { kind: 'accepted', command: record('resolved', { runId: 'run-1' }) };
      }
      if (action === 'status') {
        harness.statusPolls += 1;
        return harness.statusPolls >= 2 ? harness.lastCreate : null;
      }
      return { kind: 'events', epoch: 1, nextSeq: 0, events: [] };
    }
    close() {}
  },
}));

function savedProjectsOnly(): string {
  const identity = createIdentity();
  return JSON.stringify({
    version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
    binding: { version: 1, endpoint: 'http://192.168.1.2:8182', hostKey: HOST, deviceId: 'phone-1', scopeEpoch: 1, scope: ['project:one', 'project:two', 'project:proj_unsorted'] },
  });
}

const ports = (): PlatformPorts => ({
  preferences: { get: async () => harness.prefs, set: async value => { harness.prefs = value; } },
  appInfo: { read: async () => ({ version: '0.1.0', build: '51' }) },
  lifecycle: { subscribe: async () => () => {}, leave: async () => {} },
  keyboard: { subscribe: async () => () => {}, subscribeFrame: async () => () => {}, hide: async () => {} },
  companion: { read: async () => savedProjectsOnly(), write: async () => {}, scan: async () => { throw new Error('unused'); }, post: async () => ({}) },
});

beforeEach(() => {
  harness.mode = 'ok'; harness.commands = []; harness.statusPolls = 0; harness.prefs = null; harness.lastCreate = null;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
  Object.defineProperty(window.navigator, 'language', { value: 'zh-CN', configurable: true });
});
afterEach(() => { vi.unstubAllGlobals(); cleanup(); });

const picker = () => document.querySelector('[data-testid="project-pick"]') as HTMLElement | null;
const draft = () => document.querySelector('[data-testid="draft"]') as HTMLTextAreaElement;

/** 挂到「连着、库读到、没选会话」的新任务屏。只授权项目时连上会自动弹项目弹层，先收掉。 */
async function mountNewTask() {
  await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
  await waitFor(() => { expect(document.querySelector('.project-list')).toBeTruthy(); });
  fireEvent.click(document.querySelector('.sheet-layer .scrim') as HTMLElement);
  await waitFor(() => { expect(picker()).toBeTruthy(); });
}

async function typeAndSend(value: string) {
  fireEvent.change(draft(), { target: { value } });
  fireEvent.click(document.querySelector('[data-testid="send"]') as HTMLElement);
}

describe('新任务的项目选择器', () => {
  it('欢迎语下方显示默认项目（最近用过的），点开是选择项目弹层', async () => {
    await mountNewTask();
    expect(document.querySelector('.welcome h1')!.textContent).toBe(text.welcome);
    expect(picker()!.textContent).toBe('One');
    fireEvent.click(picker()!);
    await waitFor(() => { expect(document.querySelector('.project-list')).toBeTruthy(); });
  });

  it('都建不了：选择器上说清，点发送不建会话、打开选择项目弹层，草稿不丢', async () => {
    harness.mode = 'blocked';
    await mountNewTask();
    expect(picker()!.textContent).toBe(text.noCreatableProject);
    await typeAndSend('帮我整理');
    await waitFor(() => { expect(document.querySelector('.project-list')).toBeTruthy(); });
    expect(harness.commands).toEqual([]);
    expect(document.querySelector('[data-testid="status-slot"]')).toBeNull();
  });

  it('弹层里手选的项目按这台电脑记住', async () => {
    await mountNewTask();
    fireEvent.click(picker()!);
    const two = await waitFor(() => { const el = document.querySelector('[data-testid="project-two"] .project-main') as HTMLElement; expect(el).toBeTruthy(); return el; });
    fireEvent.click(two);
    await waitFor(() => { expect(harness.commands[0]).toEqual(['session.create', 'project:two', 'deepseek-chat']); });
    await waitFor(() => { expect(JSON.parse(harness.prefs ?? '{}').projectPicks).toEqual({ [HOST]: 'two' }); });
  });
});

describe('没选会话点发送：建会话再发出', () => {
  it('在所选项目 create，建成后把这句作为第一条消息发到新会话；全程没有报错行', async () => {
    await mountNewTask();
    await typeAndSend('帮我整理三家的资料');
    await waitFor(() => { expect(harness.commands).toEqual([['session.create', 'project:one', 'deepseek-chat'], ['message.send', 'new-1', '帮我整理三家的资料']]); });
    expect(document.querySelector('[data-testid="status-slot"]')).toBeNull();
    expect(document.querySelector('.composer-area .notice')).toBeNull();
    await waitFor(() => { expect(draft().value).toBe(''); });
  });

  it('create 的结算晚到（先 reconciling）：send 等 sessionId 生效后才发，不抢命令槽', async () => {
    harness.mode = 'reconciling';
    await mountNewTask();
    await typeAndSend('晚一点结算');
    await waitFor(() => { expect(harness.commands).toHaveLength(1); });
    // 结算没到之前绝不发 send（命令槽只容一条）
    expect(harness.statusPolls).toBeLessThan(2);
    await waitFor(() => { expect(harness.commands).toEqual([['session.create', 'project:one', 'deepseek-chat'], ['message.send', 'new-1', '晚一点结算']]); }, { timeout: 4000 });
    expect(harness.statusPolls).toBeGreaterThanOrEqual(2);
  });

  it('建会话失败：状态位「会话没建成」+ 重试，草稿留着；重试成功后照样发出', async () => {
    harness.mode = 'reject-create';
    await mountNewTask();
    await typeAndSend('这句不能丢');
    const slot = await waitFor(() => { const el = document.querySelector('[data-testid="status-slot"]') as HTMLElement; expect(el?.textContent).toContain(text.sessionCreateFailed); return el; });
    expect(slot.textContent).toContain(text.projectUnavailable);
    expect(harness.commands).toEqual([['session.create', 'project:one', 'deepseek-chat']]);
    expect(draft().value).toBe('这句不能丢');
    harness.mode = 'ok';
    fireEvent.click(slot.querySelector('[data-testid="status-action"]')!);
    await waitFor(() => { expect(harness.commands.slice(1)).toEqual([['session.create', 'project:one', 'deepseek-chat'], ['message.send', 'new-1', '这句不能丢']]); });
  });
});
