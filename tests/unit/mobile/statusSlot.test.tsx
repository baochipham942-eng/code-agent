// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MobileRoot, composerModelLabel } from '../../../packages/mobile/src/app/MobileRoot';
import type { PlatformPorts } from '../../../packages/mobile/src/platform/ports';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../src/shared/companion/lanProtocol';
import { StatusSlot, commandNoticeCopy, composerStatusItems, type StatusItem } from '../../../packages/mobile/src/app/StatusSlot';
import type { CompanionLibrary } from '../../../src/shared/contract/companionLibrary';
import { messages } from '../../../packages/mobile/src/i18n';

const text = messages('zh');

/**
 * N-MOBILE-STATUS-NOISE（爸 2026-09-17 build 50 真机「什么乱七八糟的…一大堆噪音文字」，选 A）：
 * 输入框上方只有一个状态位，同一时刻一条、一条一个动作。前半钉纯函数与组件，后半钉 MobileRoot 接线。
 */
type Input = Parameters<typeof composerStatusItems>[1];
const quiet: Input = {
  saveError: false, nativeError: false, sendAttempted: false,
  binding: true, status: 'connected', paused: false, connectionError: null, busy: false,
  commandError: null, commandErrorAction: null, voiceFailureShown: false, sessionId: 's1',
  libraryError: false, pending: false, pendingAction: null, pendingSlow: false,
};
const acts = () => ({ flush: vi.fn(), reconnect: vi.fn(), scan: vi.fn(), openRemote: vi.fn(), retryCreate: vi.fn(), switchModel: vi.fn(), retrySend: vi.fn() });
const items = (patch: Partial<Input> = {}, act = acts()) => composerStatusItems(text, { ...quiet, ...patch }, act);
const voiceFailure: StatusItem = { rank: 3, message: text.microphoneDenied };

/** 每一档优先级各自的触发条件（语音那档在 Composer 里，用一条 rank 3 候选代替）。 */
const triggers: Record<number, { patch: Partial<Input>; voice?: true; message: string }> = {
  1: { patch: { saveError: true }, message: text.saveError },
  2: { patch: { status: 'offline', connectionError: 'connectionUnavailable' }, message: text.cannotReachComputer },
  3: { patch: {}, voice: true, message: text.microphoneDenied },
  4: { patch: { commandError: 'MODEL_AUTH', commandErrorAction: 'message.send' }, message: text.modelAuthMissing },
  5: { patch: { libraryError: true }, message: text.libraryError },
  6: { patch: { pending: true, pendingAction: 'message.send', pendingSlow: true }, message: text.pendingCommand },
  7: { patch: { pending: true, pendingAction: 'voice.transcribe' }, message: `${text.transcribing}…` },
};

afterEach(cleanup);

function shown(patch: Partial<Input>, voice = false) {
  const { container } = render(<StatusSlot items={[...items(patch), voice ? voiceFailure : null]} />);
  const slots = container.querySelectorAll('[data-testid="status-slot"]');
  cleanup();
  return { count: slots.length, text: slots[0]?.querySelector('.status-text')?.textContent ?? null };
}

describe('优先级：同时触发只露高的那条（逐对遍历）', () => {
  // 6 与 7 互斥（同一个待确认槽只可能是转写或别的命令），不成对。
  const pairs = [1, 2, 3, 4, 5, 6, 7].flatMap(high => [1, 2, 3, 4, 5, 6, 7].filter(low => low > high && !(high === 6 && low === 7)).map(low => [high, low] as const));
  it.each(pairs)('%i 压住 %i', (high, low) => {
    const a = triggers[high]; const b = triggers[low];
    // 前提自证：低的那条单独触发时确实会出现，否则「没露出来」是恒真判据
    expect(shown(b.patch, b.voice).text).toBe(b.message);
    expect(shown({ ...b.patch, ...a.patch }, a.voice || b.voice)).toEqual({ count: 1, text: a.message });
  });
});

describe('断连期间连带后果不说', () => {
  const consequences: Partial<Input> = {
    commandError: 'COMPANION_COMMAND_IN_FLIGHT', commandErrorAction: 'session.create',
    libraryError: true, pending: true, pendingAction: 'message.send', pendingSlow: true, sendAttempted: true,
  };
  it('断开：只剩连不上电脑那一条', () => {
    expect(items({ ...consequences, status: 'offline', connectionError: 'connectionUnavailable' }).map(item => item.message)).toEqual([text.cannotReachComputer]);
  });
  it('后台暂停（连接那条不出）时它们也不冒出来', () => {
    // 前提自证：同一组连带后果在连着时是会说的
    expect(items(consequences).length).toBeGreaterThan(0);
    expect(items({ ...consequences, status: 'offline', paused: true })).toEqual([]);
  });
  it('COMPANION_NOT_CONNECTED 永远不单独说——它说的就是断连', () => {
    expect(items({ commandError: 'COMPANION_NOT_CONNECTED', commandErrorAction: 'session.create' })).toEqual([]);
  });
});

describe('正常不说话', () => {
  it('已连接、没有别的事：没有状态，也不占位', () => {
    expect(items()).toEqual([]);
    const { container } = render(<StatusSlot items={items()} />);
    expect(container.innerHTML).toBe('');
  });
  it('待确认命令没慢过阈值不说；「请勿重复发送」这句不存在了', () => {
    expect(items({ pending: true, pendingAction: 'message.send', pendingSlow: false })).toEqual([]);
    expect(Object.values(messages('zh')).join('')).not.toContain('请勿重复发送');
  });
});

describe('连接那一条：一句话 + 一个动作，点文字打开连接电脑弹层', () => {
  it.each([
    [{ status: 'connecting' }, text.connecting, null],
    [{ status: 'offline', connectionError: 'connectionUnavailable' }, text.cannotReachComputer, text.reconnect],
    [{ status: 'offline', connectionError: 'connectionRefused' }, text.neoNotRunning, text.reconnect],
    [{ status: 'rejected', connectionError: 'connectionRejected' }, text.rescanNeeded, text.scanShort],
    [{ status: 'offline', connectionError: 'connectionQrInvalid' }, text.rescanNeeded, text.scanShort],
  ] as const)('%o → %s', (patch, message, action) => {
    const act = acts();
    const [item] = items(patch, act);
    expect(item.message).toBe(message);
    expect(item.action?.label ?? null).toBe(action);
    render(<StatusSlot items={[item]} />);
    fireEvent.click(document.querySelector('[data-testid="status-open"]')!);
    expect(act.openRemote).toHaveBeenCalledTimes(1);
    if (action === text.scanShort) { fireEvent.click(document.querySelector('[data-testid="status-action"]')!); expect(act.scan).toHaveBeenCalled(); }
    if (action === text.reconnect) { fireEvent.click(document.querySelector('[data-testid="status-action"]')!); expect(act.reconnect).toHaveBeenCalled(); }
  });
  it('没配对过就点发送：去连接电脑', () => {
    const act = acts();
    const [item] = items({ binding: false, status: 'unpaired', sendAttempted: true }, act);
    expect(item.message).toBe(text.cannotReachComputer);
    item.action!.run();
    expect(act.openRemote).toHaveBeenCalled();
  });
});

describe('刚才的操作没成功：按码一句 + 一个动作', () => {
  it('会话没建成：带前缀，动作是重试（重做建会话的那个动作）', () => {
    const act = acts();
    const [item] = items({ commandError: 'COMPANION_PROJECT_UNAVAILABLE', commandErrorAction: 'session.create' }, act);
    expect(item.message).toBe(`${text.sessionCreateFailed}：${text.projectUnavailable}`);
    item.action!.run();
    expect(act.retryCreate).toHaveBeenCalled();
  });
  it('槽被占着时不给重试（点了也是同一句）', () => {
    const [item] = items({ commandError: 'COMPANION_COMMAND_IN_FLIGHT', commandErrorAction: 'session.create', pending: true, pendingAction: 'session.create' });
    expect(item.message).toBe(`${text.sessionCreateFailed}：${text.commandInFlight}`);
    expect(item.action).toBeUndefined();
  });
  it('模型密钥用不了：动作是换模型', () => {
    const act = acts();
    const [item] = items({ commandError: 'MODEL_AUTH', commandErrorAction: 'message.send' }, act);
    expect(item.action!.label).toBe(text.switchModel);
    item.action!.run();
    expect(act.switchModel).toHaveBeenCalled();
  });
  it.each(['RUN_START_FAILED', 'HOST_UNAVAILABLE'] as const)('%s：全文是「这条消息没发出去」，动作是重试并会重发', (code) => {
    const act = acts();
    const [item] = items({ commandError: code, commandErrorAction: 'message.send' }, act);
    expect(item.message).toBe('这条消息没发出去');
    expect(item.action!.label).toBe(text.retry);
    render(<StatusSlot items={[item]} />);
    expect(document.querySelector('[data-testid="status-slot"]')!.textContent).toContain('这条消息没发出去');
    expect(document.querySelector('[data-testid="status-action"]')!.textContent).toBe('重试');
    fireEvent.click(document.querySelector('[data-testid="status-action"]')!);
    expect(act.retrySend).toHaveBeenCalledTimes(1);
  });
  it('错误码只进 data-reason，不进用户面', () => {
    render(<StatusSlot items={items({ commandError: 'RUN_FAILED', commandErrorAction: 'message.send' })} />);
    const slot = document.querySelector('[data-testid="status-slot"]') as HTMLElement;
    expect(slot.dataset.reason).toBe('RUN_FAILED');
    expect(slot.textContent).not.toContain('RUN_FAILED');
  });
});

describe('几何契约（真 WebKit 的量 rect 在模拟器验收里做；这里钉 CSS 数值本身）', () => {
  const css = readFileSync('packages/mobile/src/styles.css', 'utf8');
  const px = (rule: string, prop: string) => Number(css.match(new RegExp(`${rule.replace(/[.[\]]/g, '\\$&')} \\{[^}]*?${prop}: (?:0 0 0 )?(\\d+)px`))?.[1]);
  it('状态文字左沿 = 输入框内文字左沿；与输入框间距 ≥ 8px；动作点按区 ≥ 36px', () => {
    const areaLeft = Number(css.match(/\.composer-area \{[^}]*padding: \d+px (\d+)px/)?.[1]);
    const composerPad = Number(css.match(/\.composer \{[^}]*padding: \d+px (\d+)px/)?.[1]);
    const textareaPad = Number(css.match(/\ntextarea \{[^}]*padding: \d+px (\d+)px/)?.[1]);
    const slotText = areaLeft + px('.status-slot', 'padding') + px('.status-slot .dot', 'width') + px('.status-slot', 'gap');
    expect(slotText).toBe(areaLeft + 1 + composerPad + textareaPad);
    expect(Number(css.match(/\.status-slot \{[^}]*margin: 0 0 (\d+)px/)?.[1])).toBeGreaterThanOrEqual(8);
    expect(px('.status-slot .status-action', 'min-height')).toBeGreaterThanOrEqual(36);
  });
});

describe('commandNoticeCopy（预览面板也用它）', () => {
  const notice = (commandError: string | null, commandErrorAction: string | null, voiceFailureShown: boolean) =>
    commandNoticeCopy(text, { commandError, commandErrorAction }, voiceFailureShown);

  it.each([['COMPANION_TRANSCRIPTION_FAILED'], ['COMPANION_TRANSCRIPTION_UNAVAILABLE'], ['GROQ_RATE_LIMITED']])('转写失败码 %s 在输入区正显示它时让位', code => {
    expect(notice(code, 'voice.transcribe', true)).toBeNull();
  });
  it('输入区手里没有这条失败时不让位——否则它一个落点都没有', () => {
    expect(notice('COMPANION_TRANSCRIPTION_FAILED', 'voice.transcribe', false)).toBe(text.commandRejected);
  });
  it('Host 信任类失败与权限拒绝分开说', () => {
    expect(notice('PROJECT_SOURCE_MISSING', 'message.send', false)).toBe(text.projectSourceMissing);
    expect(notice('PROJECT_SOURCE_CHANGED', 'message.send', false)).toBe(text.projectSourceChanged);
    expect(notice('PROJECT_SOURCE_UNTRUSTED', 'message.send', false)).toBe(text.projectSourceUntrusted);
    expect(notice('scope_denied', 'message.send', false)).toBe(text.commandScopeDenied);
    expect(notice('COMPANION_SCOPE_DENIED', 'message.send', false)).toBe(text.commandScopeDenied);
    expect(notice('RUN_FAILED', 'message.send', false)).toBe(text.runFailed);
    expect(notice('RUN_START_FAILED', 'message.send', false)).toBe(text.runStartFailed);
    expect(notice('HOST_UNAVAILABLE', 'message.send', false)).toBe(text.runStartFailed);
    expect(notice('RUN_START_FAILED', 'message.send', false)).not.toBe(text.commandRejected);
  });
  it('只有 session.create 的失败加「会话没建成」前缀', () => {
    expect(notice('COMPANION_PROJECT_UNAVAILABLE', 'session.create', false)).toBe(`${text.sessionCreateFailed}：${text.projectUnavailable}`);
    expect(notice('COMPANION_PROJECT_UNAVAILABLE', 'session.rename', false)).toBe(text.projectUnavailable);
    expect(notice('COMPANION_UNSUPPORTED_ACTION', 'session.create', false)).toBe(`${text.sessionCreateFailed}：${text.hostTooOld}`);
  });
});

// 输入区模型胶囊：真机上会话用的模型不在电脑给的可用列表里时，胶囊曾整个消失（2026-09-12 build 24）。
const library = (patch: Partial<CompanionLibrary> = {}): CompanionLibrary => ({
  nextOffset: null, projects: [],
  sessions: [{ id: 's1', title: '会话', projectId: null, updatedAt: 0, archived: false, provider: 'custom-glm-coding', model: 'glm-5.3-flash' }],
  models: [{ provider: 'deepseek', model: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', providerLabel: 'DeepSeek', isDefault: true }],
  ...patch,
});

describe('composerModelLabel', () => {
  it('模型在列表里时用好看的名字', () => {
    expect(composerModelLabel(library({
      sessions: [{ id: 's1', title: '会话', projectId: null, updatedAt: 0, archived: false, provider: 'deepseek', model: 'deepseek-v4.1-flash' }],
    }), 's1')).toBe('DeepSeek V4.1 Flash');
  });
  it('模型不在列表里时退回会话自己的模型 id，不隐藏也不拿别的模型冒充', () => {
    expect(composerModelLabel(library(), 's1')).toBe('glm-5.3-flash');
  });
  it('没有会话或还没读到库时不显示', () => {
    expect(composerModelLabel(library(), null)).toBeNull();
    expect(composerModelLabel(null, 's1')).toBeNull();
  });
});

// 爸 2026-09-16：「不要特别强调电脑正在做什么」。执行/模型/上传类文案不点名电脑；连接与送达确认不在此列
// （「还没收到电脑确认」是 09-17 对齐页拍板的原文，说的是连接那一端）。
describe('卡片与状态位不写「另一端」', () => {
  it.each(['zh', 'en'])('%s copy has no 另一端 / elsewhere', language => {
    const copy = messages(language);
    expect(Object.values(copy).join('\n')).not.toMatch(/另一端|elsewhere/i);
  });
});

describe('执行与模型文案不绑定「电脑」', () => {
  const agentNeutralKeys = ['running', 'runFailed', 'runStartFailed', 'connectedNext', 'artifactWriting', 'sessionBusy', 'modelAuthMissing', 'modelAuthTitle',
    'modelAuthDetail', 'modelConfigured', 'modelNotConfigured', 'modelRecentlyFailed', 'modelUnavailable', 'modelScopeNote',
    'commandRejected', 'attachTransferring', 'attachComplete', 'attachDestinationHint', 'transferInterrupted',
    'historyTruncated', 'deleteConfirmation'] as const;
  it.each(['zh', 'en'])('%s', language => {
    const copy = messages(language);
    for (const key of agentNeutralKeys) {
      expect(copy[key], key).toBeTruthy();
      expect(copy[key], key).not.toMatch(/电脑|computer/i);
    }
  });
});

/**
 * N-MOBILE-STATUS-NOISE 接线层：MobileRoot 真的只挂一个状态位。纯函数的优先级逐对在 statusSlot.test.tsx。
 * build 50 真机 00:03：电脑没回应时输入框上方叠了四行（连接胶囊 / 未确认送达 / 读取失败 / 会话没建成）。
 */
const harness = vi.hoisted(() => ({ offline: false, failSend: false, sent: [] as string[] }));

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
        const command = (payload as { command: { commandId: string; deviceId: string; sessionId: string; action: string; payload?: { text?: string } } }).command;
        if (command.action === 'message.send' && typeof command.payload?.text === 'string') harness.sent.push(command.payload.text);
        if (harness.failSend && command.action === 'message.send') {
          return { kind: 'rejected', reason: 'RUN_START_FAILED' };
        }
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

const slots = () => [...document.querySelectorAll('[data-testid="status-slot"]')] as HTMLElement[];
/** 输入区里除了状态位之外，旧的那几种提示容器一个都不许再出现。 */
const legacyRows = () => document.querySelectorAll('.composer-area .notice, .composer-area .task-status, .composer-area .connection-pill, .composer-area .voice-notice').length;

describe('MobileRoot 接线', () => {
  beforeEach(() => {
    harness.offline = false;
    harness.failSend = false;
    harness.sent = [];
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }));
    Object.defineProperty(window.navigator, 'language', { value: 'zh-CN', configurable: true });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

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

  describe('这条消息没发出去要带重试', () => {
    it('RUN_START_FAILED：全文 + 重试，点了用原草稿重发', async () => {
      harness.failSend = true;
      await mountInSession();
      fireEvent.change(document.querySelector('[data-testid="draft"]') as HTMLTextAreaElement, { target: { value: '再加一页对比' } });
      fireEvent.click(document.querySelector('[data-testid="send"]') as HTMLElement);
      await waitFor(() => {
        expect(slots()[0]?.querySelector('.status-text')?.textContent).toBe('这条消息没发出去');
      });
      expect(slots()[0].querySelector('[data-testid="status-action"]')!.textContent).toBe(text.retry);
      expect((document.querySelector('[data-testid="draft"]') as HTMLTextAreaElement).value).toBe('再加一页对比');
      expect(harness.sent).toEqual(['再加一页对比']);
      harness.failSend = false;
      fireEvent.click(slots()[0].querySelector('[data-testid="status-action"]')!);
      await waitFor(() => { expect(harness.sent).toEqual(['再加一页对比', '再加一页对比']); });
    });
  });
});
