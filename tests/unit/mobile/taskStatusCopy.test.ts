import { describe, expect, it } from 'vitest';
import { composerModelLabel, connectionCopy, taskStatusCopy } from '../../../packages/mobile/src/app/MobileRoot';
import type { CompanionLibrary } from '../../../src/shared/contract/companionLibrary';
import { messages } from '../../../packages/mobile/src/i18n';

const text = messages('zh');
const state = (patch: Partial<Parameters<typeof taskStatusCopy>[1]> = {}) => ({
  pending: false, pendingAction: null, runId: null, terminal: null, ...patch,
});

describe('task status copy', () => {
  it('语音转写期间说的是「正在转写」，不是给发送写的那句', () => {
    // 真机反馈：转写时状态行写「正在核对电脑是否已接收，请勿重复发送」——
    // 用户没发送什么，也不存在重复发送的风险。
    expect(taskStatusCopy(text, state({ pending: true, pendingAction: 'voice.transcribe' }))).toBe(text.transcribing);
    expect(taskStatusCopy(text, state({ pending: true, pendingAction: 'voice.transcribe' }))).not.toBe(text.pendingCommand);
  });

  it('其余命令仍然用原来的「正在核对电脑是否已接收」', () => {
    for (const action of ['message.send', 'run.cancel', 'approval.respond', 'session.create', null]) {
      expect(taskStatusCopy(text, state({ pending: true, pendingAction: action }))).toBe(text.pendingCommand);
    }
  });

  it('没有待确认命令时，运行中与终态的文案不受影响', () => {
    expect(taskStatusCopy(text, state({ runId: 'run-1' }))).toBe(text.running);
    expect(taskStatusCopy(text, state({ terminal: 'complete' }))).toBe(text.complete);
    expect(taskStatusCopy(text, state())).toBe('');
  });

  it('待确认命令压过运行中状态', () => {
    expect(taskStatusCopy(text, state({ pending: true, pendingAction: 'message.send', runId: 'run-1' }))).toBe(text.pendingCommand);
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
