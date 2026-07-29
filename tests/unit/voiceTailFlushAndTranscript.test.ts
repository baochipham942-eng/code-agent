// P0-2 handoff 带字幕近窗 / P0-3 挂断 tail flush 的接线门（2026-07-28）。
//
// 治的是真机 dogfood 那条最严重的现象：模型口头说「正在为你创建 a.txt」，
// 一次工具都没调，磁盘上什么都没发生。两件事分别从两头兜：
//   · 派活时把通话近窗的**原始字幕**一起交给执行侧（brain 改写会丢信息，
//     而「改写正确」原本是这条链上唯一的一条路）；
//   · 挂断时若整通电话一件活都没派出来，把尾巴交给执行侧再判一次。
//
// 判据钉在「执行侧那一轮真的拿到了什么」——startTask 的 message 与
// turnSystemContext，不是「函数返回了对的字符串」。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentRunOptions } from '../../src/host/research/types';

type FakeEvent = { type: string; sessionId: string; data?: unknown };

const runtime = vi.hoisted(() => ({
  listeners: new Set<(event: FakeEvent) => void>(),
  status: 'idle' as string,
  startTask: vi.fn(async (
    _sessionId: string,
    _message: string,
    _attachments: unknown,
    _options: AgentRunOptions,
  ) => undefined),
}));

vi.mock('../../src/host/task', () => ({
  getTaskManager: () => ({
    on: (_event: string, listener: (event: FakeEvent) => void) => { runtime.listeners.add(listener); },
    off: (_event: string, listener: (event: FakeEvent) => void) => { runtime.listeners.delete(listener); },
    getSessionState: () => ({ status: runtime.status }),
    startTask: runtime.startTask,
    interruptAndContinue: vi.fn(),
    cancelTask: vi.fn(),
  }),
}));
vi.mock('../../src/host/services/roleAssets/roleAssetService', () => ({
  buildRoleContextBlock: vi.fn(async () => null),
}));
vi.mock('../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ voice: { live: {} } }) }),
}));
vi.mock('../../src/host/services/planning/taskStore', () => ({ getIncompleteTasks: () => [] }));
vi.mock('../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ getSession: async () => ({ messages: [] }) }),
}));
vi.mock('../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../src/host/agent/agentRegistry', () => ({ resolveAgent: () => undefined }));
vi.mock('../../src/host/connectors', () => ({
  getConnectorRegistry: () => ({ get: () => undefined }),
}));

const {
  beginVoiceDispatch,
  endVoiceDispatch,
  flushVoiceTail,
  pushVoiceTranscript,
} = await import('../../src/host/services/voice/voiceAgentCoordinator');
const { executeVoiceTool } = await import('../../src/host/services/voice/voiceTools');

const endCalls: number[] = [];

function bind(): void {
  beginVoiceDispatch({
    neoSessionId: 'session-1',
    onWorkItem: () => {},
    onWorkFailed: () => {},
    onEndCall: () => endCalls.push(1),
    onWorkNarration: () => {},
  });
}

function lastRun(): { message: string; options: AgentRunOptions } {
  const call = runtime.startTask.mock.calls.at(-1);
  if (!call) throw new Error('startTask was never called');
  return { message: call[1], options: call[3] };
}

function systemContext(): string {
  return (lastRun().options.turnSystemContext ?? []).join('\n');
}

/** 真机 19:54 那通电话的原始字幕（碎句 + ASR 把 a.txt 写成「a点text」）。 */
function pushRealCallTranscript(): void {
  pushVoiceTranscript({ role: 'user', text: '帮我在。' });
  pushVoiceTranscript({ role: 'assistant', text: '好的，请告诉我你想让我帮你做什么？' });
  pushVoiceTranscript({ role: 'user', text: '下载目录里边。' });
  pushVoiceTranscript({ role: 'user', text: '创建一个。' });
  pushVoiceTranscript({ role: 'user', text: 'a点text的文件。' });
}

describe('P0-2 派活载荷带通话近窗字幕', () => {
  beforeEach(() => {
    runtime.startTask.mockClear();
    runtime.status = 'idle';
    endVoiceDispatch();
    bind();
  });

  it('spawn_task 那一轮把近窗原文送进 turnSystemContext', async () => {
    pushRealCallTranscript();

    await executeVoiceTool('spawn_task', JSON.stringify({ title: '创建文件', prompt: '创建 a.txt' }));

    const context = systemContext();
    expect(context).toContain('通话近窗字幕原文');
    // 执行侧必须看得到用户的原话，包括 brain 改写时丢掉的「下载目录」和 ASR 的错字
    expect(context).toContain('下载目录里边');
    expect(context).toContain('a点text的文件');
    // 原文只走 system 上下文，不许混进会显示给用户的那条消息
    expect(lastRun().message).toBe('创建 a.txt');
    expect(lastRun().message).not.toContain('通话近窗');
  });

  it('近窗封顶，只保留最近 12 条', async () => {
    for (let i = 1; i <= 15; i += 1) pushVoiceTranscript({ role: 'user', text: `第${i}句` });

    await executeVoiceTool('spawn_task', JSON.stringify({ title: 't', prompt: 'p' }));

    const context = systemContext();
    expect(context).not.toContain('第3句');
    expect(context).toContain('第4句');
    expect(context).toContain('第15句');
  });

  it('空窗时不塞空块', async () => {
    await executeVoiceTool('spawn_task', JSON.stringify({ title: 't', prompt: 'p' }));

    expect(systemContext()).not.toContain('通话近窗字幕原文');
  });
});

describe('P0-3 挂断 tail flush', () => {
  beforeEach(() => {
    runtime.startTask.mockClear();
    runtime.status = 'idle';
    endVoiceDispatch();
    bind();
  });

  it('整通电话零派活时，把尾巴交给执行侧再判一次', async () => {
    pushRealCallTranscript();

    await expect(flushVoiceTail()).resolves.toBe(true);

    expect(runtime.startTask).toHaveBeenCalledTimes(1);
    expect(lastRun().message).toContain('一件任务都没有派出来');
    // 补派那一轮同样要拿到原文，否则执行侧无从判断有没有待办
    expect(systemContext()).toContain('a点text的文件');
  });

  it('已经派过活就不补派——没派的那部分多半是用户自己放弃的', async () => {
    pushRealCallTranscript();
    await executeVoiceTool('spawn_task', JSON.stringify({ title: 't', prompt: 'p' }));
    runtime.startTask.mockClear();

    await expect(flushVoiceTail()).resolves.toBe(false);
    expect(runtime.startTask).not.toHaveBeenCalled();
  });

  it('用户一句话没说过的空通话不补派', async () => {
    pushVoiceTranscript({ role: 'assistant', text: '喂？' });

    await expect(flushVoiceTail()).resolves.toBe(false);
    expect(runtime.startTask).not.toHaveBeenCalled();
  });

  it('会话里还有活在跑时不插队', async () => {
    pushRealCallTranscript();
    runtime.status = 'running';

    await expect(flushVoiceTail()).resolves.toBe(false);
    expect(runtime.startTask).not.toHaveBeenCalled();
  });

  it('通话账本已经断开后不补派', async () => {
    pushRealCallTranscript();
    endVoiceDispatch();

    await expect(flushVoiceTail()).resolves.toBe(false);
    expect(runtime.startTask).not.toHaveBeenCalled();
  });
});

describe('收线与时间（2026-07-28 真机补的两只窄工具）', () => {
  beforeEach(() => {
    endCalls.length = 0;
    endVoiceDispatch();
    bind();
  });

  it('end_call 真的请求了挂断，不是只回一句话', async () => {
    const reply = await executeVoiceTool('end_call', '{}');

    // 真机那次它说「好，通话已挂断」，而日志 reason 是 client-end——嘴上说不算数，
    // 判据必须钉在「挂断动作被请求了」这件事上。
    expect(endCalls).toHaveLength(1);
    expect(reply).toContain('挂断');
  });

  it('get_current_time 给出真时间，而不是「我看不到」', async () => {
    const reply = await executeVoiceTool('get_current_time', '{}');

    expect(reply).toContain(String(new Date().getFullYear()));
    expect(reply).not.toContain('看不到');
  });
});
