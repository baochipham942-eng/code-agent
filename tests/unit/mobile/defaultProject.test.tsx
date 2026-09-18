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
  it('未分类建不了、授权的项目下还没有会话 → 列表里第一个能建的', () => {
    expect(defaultProjectId(lib({ projects: [project('one', 'One', false), project('two', 'Two'), project('proj_unsorted', '未分类', false)] }), undefined)).toBe('two');
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
  mode: 'ok' as 'ok' | 'reject-create' | 'blocked' | 'only-two' | 'no-models',
  commands: [] as [string, string | null, string?][],
  /** 宿主 companion_commands 的模拟：commandId → 命令。 */
  host: new Map<string, { commandId: string; deviceId: string; sessionId: string | null; action: string; payload: { text?: string } }>(),
  sentText: null as string | null,
  prefs: null as string | null,
  unpaired: false,
}));

vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    async pair() {
      return { version: 1 as const, endpoint: 'http://192.168.1.2:8182', hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['project:one', 'project:two', 'project:proj_unsorted'] };
    }
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
        // only-two：手机只被授权了 Two，且 Two 下还没有会话（One 与未分类都建不了）
        const onlyTwo = harness.mode === 'only-two';
        return {
          nextOffset: null,
          projects: [
            { id: 'one', name: 'One', canCreate: !blocked && !onlyTwo, workspacePath: '/w/one' },
            { id: 'two', name: 'Two', canCreate: !blocked, workspacePath: '/w/two' },
            { id: 'proj_unsorted', name: '未分类', canCreate: !blocked && !onlyTwo },
          ],
          // 电脑上最近用的是 One（updatedAt 最大），列表顺序故意把 Two 放前面
          sessions: onlyTwo ? [] : [
            { id: 'old', title: '旧会话', projectId: 'two', updatedAt: 3, archived: false, provider: 'deepseek', model: 'deepseek-chat' },
            { id: 'recent', title: '最近会话', projectId: 'one', updatedAt: 9, archived: false, provider: 'deepseek', model: 'deepseek-chat' },
          ],
          models: harness.mode === 'no-models' ? [] : [
            { provider: 'moonshot', model: 'kimi-k2.6', label: 'Kimi', providerLabel: 'Kimi' },
            { provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek Chat', providerLabel: 'DeepSeek', isDefault: true },
          ],
        };
      }
      // 以下照宿主真实形状（zj032 companion_commands 09-17 实查 + CompanionGateway.submit / web/app.ts dispatch）：
      // submit 先拒不在授权里的目标；session.* 与 message.send 一律先回 reconciling（COMMAND_RECONCILING / RUN_STARTING），
      // 之后 status 查询才拿到 accepted + {sessionId} / {runId}；新会话的消息从 sync 事件流来。
      const record = (command: { commandId: string; deviceId: string; sessionId: string | null; action: string }, state: string, result: Record<string, unknown>) =>
        ({ commandId: command.commandId, deviceId: command.deviceId, sessionId: command.sessionId, action: command.action, state, createdAt: Date.now(), result });
      if (action === 'command') {
        const command = (payload as { command: { commandId: string; deviceId: string; sessionId: string | null; action: string; payload: { text?: string; model?: string } } }).command;
        // session.create 记模型（必须是电脑默认那个，不是列表第一项，FB-141），message.send 记正文
        harness.commands.push([command.action, command.sessionId, command.payload.text ?? command.payload.model]);
        const target = command.sessionId ?? '';
        const allowed = command.action === 'session.create' ? target.startsWith('project:') : target === 'new-1';
        if (!allowed) return { kind: 'rejected', reason: 'scope_denied' };
        harness.host.set(command.commandId, command);
        return { kind: 'accepted', command: record(command, 'reconciling', { code: command.action === 'message.send' ? 'RUN_STARTING' : 'COMMAND_RECONCILING' }) };
      }
      if (action === 'status') {
        const command = harness.host.get((payload as { commandId: string }).commandId);
        if (!command) return null;
        if (command.action === 'session.create') {
          return harness.mode === 'reject-create'
            ? record(command, 'rejected', { code: 'COMPANION_PROJECT_UNAVAILABLE' })
            : record(command, 'accepted', { sessionId: 'new-1' });
        }
        harness.sentText = command.payload.text ?? '';
        return record(command, 'accepted', { runId: 'run-1' });
      }
      const afterSeq = (payload as { afterSeq?: number }).afterSeq ?? 0;
      if (action === 'sync' && harness.sentText !== null && afterSeq < 2) {
        const event = (seq: number, role: string, content: string) => ({ eventId: `e${seq}`, epoch: 1, seq, sessionId: 'new-1', kind: 'message', payload: { id: `m${seq}`, role, content, runId: 'run-1' }, createdAt: seq });
        return { kind: 'events', epoch: 1, nextSeq: 2, events: [event(1, 'user', harness.sentText), event(2, 'assistant', '好的，已经整理好了')] };
      }
      return { kind: 'events', epoch: 1, nextSeq: afterSeq, events: [] };
    }
    close() {}
  },
}));

/** 不带 verify 的邀请：跳过核对码页，直接走 finishPair。 */
function invitation(): string {
  return JSON.stringify({
    version: 1, endpoint: 'http://192.168.1.2:8182', inviteId: '123e4567-e89b-12d3-a456-426614174000',
    psk: 'aa'.repeat(32), hostKey: 'aa'.repeat(32), expiresAt: Date.now() + 60_000,
  });
}

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
  companion: { read: async () => harness.unpaired ? null : savedProjectsOnly(), write: async () => {}, scan: async () => invitation(), post: async () => ({}) },
});

beforeEach(() => {
  harness.mode = 'ok'; harness.commands = []; harness.prefs = null; harness.unpaired = false; harness.host.clear(); harness.sentText = null;
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

/** 挂到「连着、库读到、没选会话」的新任务屏（只授权项目的配对，连上不弹弹层）。 */
async function mountNewTask() {
  await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
  await waitFor(() => { expect(picker()).toBeTruthy(); });
}

async function typeAndSend(value: string) {
  fireEvent.change(draft(), { target: { value } });
  fireEvent.click(document.querySelector('[data-testid="send"]') as HTMLElement);
}

/**
 * 爸 09-17 拍板 ②A「项目要有默认、不强制选」：连上电脑而没有会话时不再自动弹「选择项目」拦一下，
 * 冷启动/重连与配对成功都停在欢迎页（一句 + 默认项目选择器）。
 */
describe('连上不拦：不自动弹选择项目', () => {
  it('冷启动连上、没有会话：弹层没开，欢迎页有默认项目选择器', async () => {
    await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
    await waitFor(() => { expect(picker()?.textContent).toBe('One'); });
    // 前提自证：确实连上且库读到了（模型胶囊之外，选择器写的是按规则算出的默认项目）
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
    expect(document.querySelector('[data-testid="sheet-host"]')).toBeNull();
    expect(document.querySelector('.welcome h1')!.textContent).toBe(text.welcome);
  });

  it('扫码配对成功（只授权项目）：弹层都收掉，落到欢迎页 + 默认项目选择器', async () => {
    harness.unpaired = true;
    await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
    fireEvent.click(await waitFor(() => { const el = document.querySelector('[data-testid="open-drawer"]') as HTMLElement; expect(el).toBeTruthy(); return el; }));
    fireEvent.click([...document.querySelectorAll('.drawer-functions button')].find(b => b.textContent === text.remote) as HTMLElement);
    const scan = await waitFor(() => { const el = document.querySelector('[data-testid="remote-unpaired"] button.primary') as HTMLElement; expect(el).toBeTruthy(); return el; });
    fireEvent.click(scan);
    await waitFor(() => { expect(picker()?.textContent).toBe('One'); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
    expect(document.querySelector('[data-testid="sheet-host"]')).toBeNull();
  });
});

/**
 * D9 登录引导（本单修正后的形态）：配对完成**不弹账号页**——配对从 remote 弹层发起，再 openSheet
 * 会把「弹层按原流程收掉」顶住（上方那条既有契约）。引导降级为欢迎页上一条可忽略提示：
 * 点「去登录」才进账号页，「稍后再说」整条消失。
 */
describe('配对后的登录引导：欢迎页可忽略提示', () => {
  async function pairToWelcome() {
    harness.unpaired = true;
    await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
    fireEvent.click(await waitFor(() => { const el = document.querySelector('[data-testid="open-drawer"]') as HTMLElement; expect(el).toBeTruthy(); return el; }));
    fireEvent.click([...document.querySelectorAll('.drawer-functions button')].find(b => b.textContent === text.remote) as HTMLElement);
    const scan = await waitFor(() => { const el = document.querySelector('[data-testid="remote-unpaired"] button.primary') as HTMLElement; expect(el).toBeTruthy(); return el; });
    fireEvent.click(scan);
    await waitFor(() => { expect(picker()?.textContent).toBe('One'); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
  }

  it('配对成功（未登录）：弹层收掉、欢迎页出登录提示；点「去登录」才进账号页', async () => {
    await pairToWelcome();
    expect(document.querySelector('[data-testid="sheet-host"]')).toBeNull();
    const notice = document.querySelector('[data-testid="welcome-login-notice"]');
    expect(notice).toBeTruthy();
    expect(notice?.textContent).toContain(text.needLoginTitle);
    fireEvent.click(notice!.querySelector('[data-testid="welcome-login-go"]')!);
    await waitFor(() => { expect(document.querySelector('[data-testid="account-login"]')).toBeTruthy(); });
  });

  it('「稍后再说」可跳过：提示整条消失，不自动弹账号页', async () => {
    await pairToWelcome();
    fireEvent.click(document.querySelector('[data-testid="welcome-login-dismiss"]')!);
    expect(document.querySelector('[data-testid="welcome-login-notice"]')).toBeNull();
    expect(document.querySelector('[data-testid="sheet-host"]')).toBeNull();
  });
});

describe('新任务的项目选择器', () => {
  it('欢迎语下方显示默认项目（最近用过的），点开是选择项目弹层', async () => {
    await mountNewTask();
    expect(document.querySelector('.welcome h1')!.textContent).toBe(text.welcome);
    expect(picker()!.textContent).toBe('One');
    fireEvent.click(picker()!);
    await waitFor(() => { expect(document.querySelector('.project-list')).toBeTruthy(); });
  });

  it('库读成功但没有模型：状态位全文+怎么配置；点发送草稿留着、不弹项目弹层', async () => {
    harness.mode = 'no-models';
    await mountNewTask();
    const slot = await waitFor(() => {
      const el = document.querySelector('[data-testid="status-slot"]') as HTMLElement | null;
      expect(el?.textContent).toContain('电脑上还没有能用的模型');
      return el!;
    });
    expect(slot.querySelector('[data-testid="status-action"]')!.textContent).toBe('怎么配置');
    await typeAndSend('帮我查一下明天上海的天气');
    expect(harness.commands).toEqual([]);
    expect(draft().value).toBe('帮我查一下明天上海的天气');
    expect(document.querySelector('[data-testid="sheet-host"]')).toBeNull();
    fireEvent.click(slot.querySelector('[data-testid="status-action"]')!);
    await waitFor(() => { expect(document.querySelector('[data-testid="model-setup"]')).toBeTruthy(); });
    expect(document.querySelector('#sheet-title')!.textContent).toBe('配置模型');
    expect(document.querySelector('[data-testid="model-setup"]')!.textContent).toContain('在电脑上打开 Neo');
    expect(document.querySelector('[data-testid="model-setup"]')!.textContent).toContain('设置 → 模型');
    expect(document.querySelector('[data-testid="model-setup"]')!.textContent).toContain('给任意一个模型填好密钥');
    expect(document.querySelector('[data-testid="model-setup-reload"]')!.textContent).toBe('配好了，重新读取');
  });

  it('配好了重新读取后状态位消失、发送能建会话', async () => {
    harness.mode = 'no-models';
    await mountNewTask();
    await waitFor(() => { expect(document.querySelector('[data-testid="status-slot"]')?.textContent).toContain('电脑上还没有能用的模型'); });
    fireEvent.click(document.querySelector('[data-testid="status-action"]')!);
    await waitFor(() => { expect(document.querySelector('[data-testid="model-setup-reload"]')).toBeTruthy(); });
    harness.mode = 'ok';
    fireEvent.click(document.querySelector('[data-testid="model-setup-reload"]') as HTMLElement);
    await waitFor(() => { expect(document.querySelector('[data-testid="status-slot"]')).toBeNull(); });
    expect(document.querySelector('[data-testid="sheet-host"]')).toBeNull();
    await typeAndSend('配好了再发');
    await waitFor(() => { expect(harness.commands[0]).toEqual(['session.create', 'project:one', 'deepseek-chat']); });
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

  it('只授权了一个项目、那里还没有会话：默认就是它，发送直接在它下面建会话', async () => {
    harness.mode = 'only-two';
    await mountNewTask();
    expect(picker()!.textContent).toBe('Two');
    await typeAndSend('先放这里');
    await waitFor(() => { expect(harness.commands[0]).toEqual(['session.create', 'project:two', 'deepseek-chat']); });
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
  it('在所选项目 create，结算后切进新会话再发出：看到这条消息和回复，草稿清空，状态位消失', async () => {
    await mountNewTask();
    await typeAndSend('帮我整理三家的资料');
    await waitFor(() => { expect(harness.commands).toHaveLength(1); });
    // create 还在 reconciling（宿主先回 COMMAND_RECONCILING）时绝不发 send：命令槽只容一条
    expect(harness.commands).toEqual([['session.create', 'project:one', 'deepseek-chat']]);
    await waitFor(() => { expect(harness.commands).toEqual([['session.create', 'project:one', 'deepseek-chat'], ['message.send', 'new-1', '帮我整理三家的资料']]); }, { timeout: 5000 });
    const conversation = await waitFor(() => { const el = document.querySelector('.lan-messages') as HTMLElement; expect(el?.textContent).toContain('好的，已经整理好了'); return el; }, { timeout: 5000 });
    expect(conversation.textContent).toContain('帮我整理三家的资料');
    expect(document.querySelector('[data-testid="session-empty"]')).toBeNull();
    await waitFor(() => { expect(draft().value).toBe(''); });
    expect(document.querySelector('[data-testid="status-slot"]')).toBeNull();
    expect(document.querySelector('.composer-area .notice')).toBeNull();
  });

  it('建会话失败：状态位「会话没建成」+ 重试，草稿留着；重试成功后照样发出', async () => {
    harness.mode = 'reject-create';
    await mountNewTask();
    await typeAndSend('这句不能丢');
    const slot = await waitFor(() => { const el = document.querySelector('[data-testid="status-slot"]') as HTMLElement; expect(el?.textContent).toContain(text.sessionCreateFailed); return el; }, { timeout: 5000 });
    expect(slot.textContent).toContain(text.projectUnavailable);
    expect(harness.commands).toEqual([['session.create', 'project:one', 'deepseek-chat']]);
    expect(draft().value).toBe('这句不能丢');
    harness.mode = 'ok';
    fireEvent.click(slot.querySelector('[data-testid="status-action"]')!);
    await waitFor(() => { expect(harness.commands.slice(1)).toEqual([['session.create', 'project:one', 'deepseek-chat'], ['message.send', 'new-1', '这句不能丢']]); }, { timeout: 6000 });
  });
});
