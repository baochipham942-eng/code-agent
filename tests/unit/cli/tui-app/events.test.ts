// ============================================================================
// tui-app/events.ts — AgentEvent → 消息模型 reducer 单测
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../../src/shared/contract';
import {
  appendUserMessage,
  createChatState,
  formatDuration,
  markRunStarted,
  reduceAgentEvent,
  summarizeToolArgs,
  type ChatState,
  type ToolGroupMessage,
} from '../../../../src/cli/tui-app/events';

function ev(type: string, data: unknown = null): AgentEvent {
  return { type, data } as AgentEvent;
}

function reduceAll(state: ChatState, events: AgentEvent[], now = 1000): ChatState {
  return events.reduce((s, event) => reduceAgentEvent(s, event, now), state);
}

function lastGroup(state: ChatState): ToolGroupMessage {
  const last = state.messages[state.messages.length - 1];
  if (last?.kind !== 'tool_group') throw new Error('last message is not a tool_group');
  return last;
}

describe('appendUserMessage / markRunStarted', () => {
  it('追加用户消息并标记运行中', () => {
    let state = createChatState();
    state = appendUserMessage(state, '帮我改个 bug');
    state = markRunStarted(state, 500);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ kind: 'user', text: '帮我改个 bug' });
    expect(state.running).toBe(true);
    expect(state.turnStartedAt).toBe(500);
  });
});

describe('assistant 流式消息', () => {
  it('stream_chunk 累积进同一条，message 事件封口', () => {
    let state = createChatState();
    state = reduceAll(state, [
      ev('stream_chunk', { content: '你好' }),
      ev('stream_chunk', { content: '，世界' }),
    ]);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ kind: 'assistant', text: '你好，世界', streaming: true });

    state = reduceAgentEvent(state, ev('message', { role: 'assistant', content: '你好，世界' }));
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ kind: 'assistant', text: '你好，世界', streaming: false });
  });

  it('非流式 provider：message 事件直接生成已封口的 assistant 消息', () => {
    const state = reduceAgentEvent(createChatState(), ev('message', { role: 'assistant', content: '完整回复' }));
    expect(state.messages[0]).toMatchObject({ kind: 'assistant', text: '完整回复', streaming: false });
  });
});

describe('thinking 三态', () => {
  it('stream_reasoning 累积，tool_call_start 到来时封口并保留耗时', () => {
    let state = createChatState();
    state = reduceAgentEvent(state, ev('stream_reasoning', { content: '先想想' }), 1000);
    state = reduceAgentEvent(state, ev('stream_reasoning', { content: '再想想' }), 2000);
    expect(state.messages[0]).toMatchObject({ kind: 'thinking', text: '先想想再想想', startedAt: 1000 });
    expect(state.messages[0].kind === 'thinking' && state.messages[0].endedAt).toBeUndefined();

    state = reduceAgentEvent(state, ev('tool_call_start', { id: 'c1', name: 'bash', arguments: { command: 'ls' } }), 3000);
    const thinking = state.messages[0];
    expect(thinking).toMatchObject({ kind: 'thinking', endedAt: 3000 });
    // 耗时 = endedAt - startedAt = 2000ms（渲染层 formatDuration → 2.0s）
    expect(thinking.kind === 'thinking' && thinking.endedAt! - thinking.startedAt).toBe(2000);
  });
});

describe('tool_use 归组', () => {
  it('同类连续 read_file 调用并入一组（Read 3 files）', () => {
    let state = createChatState();
    state = reduceAll(state, [
      ev('tool_call_start', { id: 'c1', name: 'read_file', arguments: { path: '/a.ts' } }),
      ev('tool_call_start', { id: 'c2', name: 'read_file', arguments: { path: '/b.ts' } }),
      ev('tool_call_start', { id: 'c3', name: 'read_file', arguments: { path: '/c.ts' } }),
    ]);
    expect(state.messages).toHaveLength(1);
    const group = lastGroup(state);
    expect(group.calls).toHaveLength(3);
    expect(group.groupNoun).toBe('file');
    expect(group.doneVerb).toBe('Read');
    expect(group.status).toBe('running');
  });

  it('动作类工具（bash）不参与归组，每次独立成组', () => {
    const state = reduceAll(createChatState(), [
      ev('tool_call_start', { id: 'c1', name: 'bash', arguments: { command: 'ls' } }),
      ev('tool_call_start', { id: 'c2', name: 'bash', arguments: { command: 'pwd' } }),
    ]);
    expect(state.messages).toHaveLength(2);
  });

  it('中间插入 assistant 文本后，后续同类调用另起新组', () => {
    const state = reduceAll(createChatState(), [
      ev('tool_call_start', { id: 'c1', name: 'read_file', arguments: { path: '/a.ts' } }),
      ev('stream_chunk', { content: '看一下' }),
      ev('tool_call_start', { id: 'c2', name: 'read_file', arguments: { path: '/b.ts' } }),
    ]);
    expect(state.messages).toHaveLength(3);
    expect(lastGroup(state).calls).toHaveLength(1);
  });

  it('tool_call_end 更新调用状态并归组收敛', () => {
    let state = createChatState();
    state = reduceAll(state, [
      ev('tool_call_start', { id: 'c1', name: 'read_file', arguments: { path: '/a.ts' } }),
      ev('tool_call_start', { id: 'c2', name: 'read_file', arguments: { path: '/b.ts' } }),
      ev('tool_call_end', { toolCallId: 'c1', success: true, output: 'file a content' }),
    ]);
    expect(lastGroup(state).status).toBe('running');

    state = reduceAgentEvent(state, ev('tool_call_end', { toolCallId: 'c2', success: false, error: 'permission denied' }));
    const group = lastGroup(state);
    expect(group.status).toBe('error');
    expect(group.calls[1].resultPreview).toBe('permission denied');
  });
});

describe('error / agent_complete', () => {
  it('error 事件产出 system 错误消息', () => {
    const state = reduceAgentEvent(createChatState(), ev('error', { message: 'boom' }));
    expect(state.messages[0]).toMatchObject({ kind: 'system', tone: 'error', text: 'boom' });
  });

  it('agent_complete 收口：流式 assistant 封口 + running 复位', () => {
    let state = markRunStarted(createChatState(), 100);
    state = reduceAgentEvent(state, ev('stream_chunk', { content: 'done' }));
    state = reduceAgentEvent(state, ev('agent_complete'));
    expect(state.running).toBe(false);
    expect(state.activity).toBeNull();
    expect(state.messages[0]).toMatchObject({ kind: 'assistant', streaming: false });
  });
});

describe('token 与 model 累积', () => {
  it('stream_usage / model_response 累计 token，model_response 记录模型', () => {
    const state = reduceAll(createChatState(), [
      ev('model_response', { model: 'kimi-k2.5', inputTokens: 100, outputTokens: 50 }),
      ev('stream_usage', { inputTokens: 10, outputTokens: 5 }),
    ]);
    expect(state.inputTokens).toBe(110);
    expect(state.outputTokens).toBe(55);
    expect(state.model).toBe('kimi-k2.5');
  });
});

describe('参数摘要', () => {
  it('command 截断到 60 字符', () => {
    const summary = summarizeToolArgs({ command: 'x'.repeat(100) });
    expect(summary.length).toBe(60);
    expect(summary.endsWith('...')).toBe(true);
  });

  it('HOME 前缀压缩为 ~', () => {
    const home = process.env.HOME;
    if (!home) return;
    expect(summarizeToolArgs({ path: `${home}/repo/a.ts` })).toBe('~/repo/a.ts');
  });
});

describe('appendSystemMessage / formatDuration', () => {
  it('formatDuration：秒级与分钟级', () => {
    expect(formatDuration(12300)).toBe('12.3s');
    expect(formatDuration(80_000)).toBe('1m20s');
  });
});

describe('task_progress 活动标签不闪', () => {
  it('分析请求中 归一成 Thinking…，不与 Thinking 来回切', () => {
    let state = markRunStarted(createChatState(), 1);
    state = reduceAgentEvent(state, ev('task_progress', { phase: 'thinking', step: '分析请求中...' }));
    expect(state.activity).toBe('Thinking…');
    const next = reduceAgentEvent(state, ev('task_progress', { phase: 'thinking' }));
    expect(next.activity).toBe('Thinking…');
    expect(next).toBe(state);
  });

  it('具体 step 不被后续无 step / 分析请求中 盖掉', () => {
    let state = markRunStarted(createChatState(), 1);
    state = reduceAgentEvent(state, ev('task_progress', { phase: 'tool_running', step: 'Searching codebase' }));
    expect(state.activity).toBe('Searching codebase');
    state = reduceAgentEvent(state, ev('task_progress', { phase: 'thinking' }));
    expect(state.activity).toBe('Searching codebase');
    state = reduceAgentEvent(state, ev('task_progress', { phase: 'thinking', step: '分析请求中...' }));
    expect(state.activity).toBe('Searching codebase');
  });

  it('completed 不把运行中的标签清空', () => {
    let state = markRunStarted(createChatState(), 1);
    state = reduceAgentEvent(state, ev('task_progress', { phase: 'thinking', step: 'Searching codebase' }));
    state = reduceAgentEvent(state, ev('task_progress', { phase: 'completed', step: '回复完成' }));
    expect(state.running).toBe(true);
    expect(state.activity).toBe('Searching codebase');
  });
});
