import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { commandNoticeCopy, composerModelLabel, connectionCopy, taskStatusCopy } from '../../../packages/mobile/src/app/MobileRoot';
import type { CompanionLibrary } from '../../../src/shared/contract/companionLibrary';
import { messages } from '../../../packages/mobile/src/i18n';

const text = messages('zh');
const state = (patch: Partial<Parameters<typeof taskStatusCopy>[1]> = {}) => ({
  pending: false, pendingAction: null, ...patch,
});

describe('task status copy', () => {
  it('语音转写期间说的是「正在转写」，不是给发送写的那句', () => {
    // 真机反馈：转写时状态行写「正在核对电脑是否已接收，请勿重复发送」——
    // 用户没发送什么，也不存在重复发送的风险。
    // 转写不受延迟闸门约束：「正在转写」是进度不是警告，越早说越有用。
    for (const slow of [false, true]) {
      expect(taskStatusCopy(text, state({ pending: true, pendingAction: 'voice.transcribe' }), slow)).toBe(text.transcribing);
      expect(taskStatusCopy(text, state({ pending: true, pendingAction: 'voice.transcribe' }), slow)).not.toBe(text.pendingCommand);
    }
  });

  it('其余命令慢过阈值才说「正在核对电脑是否已接收」', () => {
    for (const action of ['message.send', 'run.cancel', 'approval.respond', 'session.create', null]) {
      expect(taskStatusCopy(text, state({ pending: true, pendingAction: action }), true)).toBe(text.pendingCommand);
    }
  });

  /**
   * N-MOBILE-PENDING-NOISE（爸 2026-09-16 build 43 真机「刚点消息发送，为什么要出这样一句提示」）：
   * 那句话是防重复发送的**异常**兜底语，正常 ack 几十毫秒就回来。一发就显示等于每条消息都
   * 提醒用户「别乱点」，而且只闪一下——用户只来得及看见警告、看不见原因。
   * 逐 action 遍历：别只测 message.send 那一个，本单前身就是「只照顾被点名的那一个」。
   */
  it('阈值之内一律闭嘴——正常发送不该看到任何提示', () => {
    for (const action of ['message.send', 'run.cancel', 'approval.respond', 'session.create', null]) {
      expect(taskStatusCopy(text, state({ pending: true, pendingAction: action }), false)).toBe('');
    }
  });

  it('运行中与终态不进底栏：它们挂在会话里那次执行下面（N-MOBILE-EXEC-STATUS ①②）', () => {
    // build 40 真机：底栏「电脑正在处理…停止任务」离消息流远；「任务已完成」「没有完成」按到达顺序堆在底部互相矛盾。
    for (const live of [
      { pending: false, pendingAction: null, runId: 'run-1', terminal: null },
      { pending: false, pendingAction: null, runId: null, terminal: 'complete' as const },
      { pending: false, pendingAction: null, runId: null, terminal: 'failed' as const },
    ]) for (const slow of [false, true]) expect(taskStatusCopy(text, live, slow)).toBe('');
  });

  it('待确认命令（已慢过阈值）照旧说，与有没有在跑无关', () => {
    const live = { pending: true, pendingAction: 'message.send', runId: 'run-1', terminal: null };
    expect(taskStatusCopy(text, live, true)).toBe(text.pendingCommand);
  });
});

// 输入区模型胶囊：真机上这条会话用的是 custom-glm-coding/glm-5.3-flash，而电脑给手机的可用
// 模型列表把没配 key 的 provider 剔掉了——胶囊因此整个消失（2026-09-12 build 24 实测）。
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
    expect(composerModelLabel(library(), '不存在的会话')).toBeNull();
    expect(composerModelLabel(null, 's1')).toBeNull();
  });
});

// 爸 2026-09-12 真机反馈两条，同一个根：
// ① Neo 还没关，应用切换器的卡片上就写着「电脑尚未连接，草稿已保留」——app 一退到后台
//    我们主动 pause() 把连接停了，界面立刻翻成报错形态，而 iOS 的快照正是那一刻拍的。
// ② 即使真的断了，也不该出现两行提示（胶囊说「重新连接」+ 下面一行说「电脑尚未连接…重试」）。
describe('connectionCopy', () => {
  const state = (patch: Partial<Parameters<typeof connectionCopy>[1]> = {}) =>
    ({ status: 'connected', paused: false, connectionError: null, ...patch });

  it('后台暂停期间不报错、不给重试——那时用户没有任何事可做', () => {
    expect(connectionCopy(text, state({ status: 'offline', paused: true })))
      .toEqual({ label: text.connected, connected: true, retry: false });
  });

  it('真的断了才报原因并给重试，且只有一条文案', () => {
    expect(connectionCopy(text, state({ status: 'offline', paused: false })))
      .toEqual({ label: text.unconnected, connected: false, retry: true });
    expect(connectionCopy(text, state({ status: 'offline', connectionError: 'connectionUnavailable' })))
      .toEqual({ label: text.connectionUnavailable, connected: false, retry: true });
    expect(connectionCopy(text, state({ status: 'storageError' })))
      .toEqual({ label: text.secureStorageError, connected: false, retry: true });
    expect(connectionCopy(text, state({ status: 'rejected' })))
      .toEqual({ label: text.rejected, connected: false, retry: true });
  });

  it('暂停期间的占位文案不能与胶囊打架：连着就不说「连接后再发送」', () => {
    // 输入框的 offline 口子吃的就是这个 connected：暂停期胶囊说已连接、占位却说
    // 「先写下来，连接后再发送」，同一张后台快照里自相矛盾（grok ai-review Nit）。
    expect(connectionCopy(text, state({ status: 'offline', paused: true })).connected).toBe(true);
    expect(connectionCopy(text, state({ status: 'offline', paused: false })).connected).toBe(false);
  });

  it('正在连接时不给重试按钮（点了也是重来一遍）', () => {
    expect(connectionCopy(text, state({ status: 'connecting' })))
      .toEqual({ label: text.connecting, connected: false, retry: false });
  });

  it('文案里不出现「重新连接」那个动作词——它当初就是与下面那行重复的那半', () => {
    for (const status of ['offline', 'storageError', 'rejected'] as const) {
      expect(connectionCopy(text, state({ status })).label).not.toBe(text.reconnect);
    }
  });
});

describe('通用提示条：转写失败不许和输入区那条叠成两句', () => {
  const notice = (commandError: string | null, commandErrorAction: string | null, voiceFailureShown: boolean,
    patch: Partial<Parameters<typeof commandNoticeCopy>[1]> = {}) =>
    commandNoticeCopy(text, { commandError, commandErrorAction, status: 'connected', paused: false, connectionError: null, ...patch }, voiceFailureShown);

  it.each([
    ['COMPANION_TRANSCRIPTION_FAILED'],
    // 结算原样带回真实错误码之后，这些都会出现在 commandError 上——按码名列白名单必漏
    ['COMPANION_TRANSCRIPTION_UNAVAILABLE'],
    ['GROQ_RATE_LIMITED'],
  ])('转写失败码 %s 在输入区正显示它时让位', (code) => {
    expect(notice(code, 'voice.transcribe', true)).toBeNull();
  });

  it('输入区手里没有这条失败时不让位——否则它一个落点都没有', () => {
    expect(notice('COMPANION_TRANSCRIPTION_FAILED', 'voice.transcribe', false)).toBe(text.commandRejected);
  });

  it('别的动作失败照常报，不被语音那条判据误伤', () => {
    expect(notice('COMPANION_COMMAND_REJECTED', 'message.send', true)).toBe(text.commandRejected);
    expect(notice('UPLOAD_TOO_LARGE', 'files.upload', true)).toBe(text.uploadTooLarge);
  });

  it('Host 信任类失败与权限拒绝分开说，不混成「电脑拒绝了这条操作」', () => {
    expect(notice('PROJECT_SOURCE_MISSING', 'message.send', false)).toBe(text.projectSourceMissing);
    expect(notice('PROJECT_SOURCE_CHANGED', 'message.send', false)).toBe(text.projectSourceChanged);
    expect(notice('PROJECT_SOURCE_UNTRUSTED', 'message.send', false)).toBe(text.projectSourceUntrusted);
    expect(notice('MODEL_AUTH', 'message.send', false)).toBe(text.modelAuthMissing);
    expect(notice('scope_denied', 'message.send', false)).toBe(text.commandScopeDenied);
    expect(notice('COMPANION_SCOPE_DENIED', 'message.send', false)).toBe(text.commandScopeDenied);
    expect(notice('RUN_FAILED', 'message.send', false)).toBe(text.runFailed);
    expect(notice('PROJECT_SOURCE_MISSING', 'message.send', false)).not.toBe(text.commandRejected);
  });

  it('session.create 的失败点名「会话没建成」（fix6-②，build 37「点了没反应」）：原因照旧，但用户得知道是什么没成', () => {
    expect(notice('scope_denied', 'session.create', false)).toBe(`${text.sessionCreateFailed}：${text.commandScopeDenied}`);
    expect(notice('COMPANION_SCOPE_DENIED', 'session.create', false)).toBe(`${text.sessionCreateFailed}：${text.commandScopeDenied}`);
    expect(notice('COMPANION_PROJECT_UNAVAILABLE', 'session.create', false)).toBe(`${text.sessionCreateFailed}：${text.projectUnavailable}`);
    // 别的动作失败不加前缀（重命名失败不是「会话没建成」）
    expect(notice('COMPANION_PROJECT_UNAVAILABLE', 'session.rename', false)).toBe(text.projectUnavailable);
  });

  it('连接不在时（manage 守卫挡下）：按连接胶囊同一套三分类给诊断句，不另造连接文案', () => {
    expect(notice('COMPANION_NOT_CONNECTED', 'session.create', false, { status: 'offline', connectionError: 'connectionRefused' }))
      .toBe(`${text.sessionCreateFailed}：${text.connectionRefused}`);
    expect(notice('COMPANION_NOT_CONNECTED', 'session.create', false, { status: 'offline', connectionError: 'connectionUnavailable' }))
      .toBe(`${text.sessionCreateFailed}：${text.connectionUnavailable}`);
    expect(notice('COMPANION_NOT_CONNECTED', 'session.create', false, { status: 'connecting' }))
      .toBe(`${text.sessionCreateFailed}：${text.connecting}`);
    // 非创建动作的同类失败不加前缀
    expect(notice('COMPANION_NOT_CONNECTED', 'session.rename', false, { status: 'offline', connectionError: 'connectionRefused' }))
      .toBe(text.connectionRefused);
  });

  it('槽被上一条未结算命令占着 / 旧 Host 不认这条命令：各给一句点名的人话', () => {
    expect(notice('COMPANION_COMMAND_IN_FLIGHT', 'session.create', false))
      .toBe(`${text.sessionCreateFailed}：${text.commandInFlight}`);
    expect(notice('COMPANION_UNSUPPORTED_ACTION', 'session.create', false))
      .toBe(`${text.sessionCreateFailed}：${text.hostTooOld}`);
  });
});

describe('重试贴文案行尾，且是可点可辨的小 pill（2026-09-14 反馈②）', () => {
  const css = readFileSync('packages/mobile/src/styles.css', 'utf8');
  it('overrides the 48px button min-height so retry does not take its own row, and is a ≥32px pill', () => {
    expect(css).toMatch(/\.connection-line\s*\{[^}]*align-items:\s*baseline/);
    expect(css).toMatch(/button\.inline-retry\s*\{[^}]*min-height:\s*32px/);
    expect(css).toMatch(/button\.inline-retry\s*\{[^}]*border-radius:\s*16px/);
    expect(css).toMatch(/button\.inline-retry\s*\{[^}]*border:\s*1px solid var\(--line\)/);
    expect(css).toMatch(/\.notice\s*\{[^}]*display:\s*flex/);
  });
});

// 爸 2026-09-16：「不要特别强调电脑正在做什么，将来移动端是可以直接连接云端 Agent 的」。
// 运行状态、执行结果、模型、上传这些跟「谁在执行」有关的文案不点名电脑；连接/配对，以及「去电脑上怎么修」的指引不在此列。
describe('执行与模型文案不绑定「电脑」', () => {
  const agentNeutralKeys = ['running', 'runFailed', 'connectedNext', 'artifactWriting', 'sessionBusy', 'modelAuthMissing', 'modelAuthTitle',
    'modelAuthDetail', 'modelConfigured', 'modelNotConfigured', 'modelRecentlyFailed', 'modelUnavailable', 'modelScopeNote',
    'commandRejected', 'pendingCommand', 'attachTransferring', 'attachComplete', 'attachDestinationHint', 'transferInterrupted',
    'historyTruncated', 'deleteConfirmation'] as const;
  it.each(['zh', 'en'])('%s', language => {
    const copy = messages(language);
    for (const key of agentNeutralKeys) {
      expect(copy[key], key).toBeTruthy();
      expect(copy[key], key).not.toMatch(/电脑|computer/i);
    }
  });
});
