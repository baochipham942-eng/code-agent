// ============================================================================
// `!` shell 直通的消息块 + bash 成功输出截断展示（events.ts）单测
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../../src/shared/contract';
import {
  appendShellCommand,
  createChatState,
  reduceAgentEvent,
  resolveShellCommand,
  type ChatState,
  type ToolGroupMessage,
} from '../../../../src/cli/tui-app/events';

function ev(type: string, data: unknown = null): AgentEvent {
  return { type, data } as AgentEvent;
}

function lastGroup(state: ChatState): ToolGroupMessage {
  const last = state.messages[state.messages.length - 1];
  if (last?.kind !== 'tool_group') throw new Error('last message is not a tool_group');
  return last;
}

describe('bash 成功输出截断展示（tool_call_end）', () => {
  it('bash 成功输出留下前 2 + 后 3 展示行', () => {
    const output = Array.from({ length: 8 }, (_, i) => `out${i + 1}`).join('\n');
    const state = [
      ev('tool_call_start', { id: 'c1', name: 'bash', arguments: { command: 'ls -la' } }),
      ev('tool_call_end', { toolCallId: 'c1', success: true, output }),
    ].reduce((s, event) => reduceAgentEvent(s, event, 1000), createChatState());
    const call = lastGroup(state).calls[0];
    expect(call.outputLines).toEqual(['out1', 'out2', '… (3 more lines)', 'out6', 'out7', 'out8']);
  });

  it('非 bash 工具不留 outputLines（避免把文件内容灌进消息区）', () => {
    const state = [
      ev('tool_call_start', { id: 'c1', name: 'read_file', arguments: { path: '/a.ts' } }),
      ev('tool_call_end', { toolCallId: 'c1', success: true, output: '1\n2\n3\n4\n5\n6\n7\n8' }),
    ].reduce((s, event) => reduceAgentEvent(s, event, 1000), createChatState());
    expect(lastGroup(state).calls[0].outputLines).toBeUndefined();
  });

  it('bash 失败只留单行错误预览，不留 outputLines', () => {
    const state = [
      ev('tool_call_start', { id: 'c1', name: 'bash', arguments: { command: 'false' } }),
      ev('tool_call_end', { toolCallId: 'c1', success: false, error: 'exit code 1\nsome detail' }),
    ].reduce((s, event) => reduceAgentEvent(s, event, 1000), createChatState());
    const call = lastGroup(state).calls[0];
    expect(call.outputLines).toBeUndefined();
    expect(call.resultPreview).toBe('exit code 1 some detail');
  });
});

describe('appendShellCommand / resolveShellCommand（`!` 直通消息块）', () => {
  it('追加进行中 bash 工具块并用成功结果收口', () => {
    const appended = appendShellCommand(createChatState(), 'ls -la', 1000);
    let state = appended[0];
    const messageId = appended[1];
    let group = lastGroup(state);
    expect(group.name).toBe('bash');
    expect(group.status).toBe('running');
    expect(group.calls[0]).toMatchObject({ summary: 'ls -la', status: 'running' });

    state = resolveShellCommand(state, messageId, { success: true, output: 'a\nb\nc\nd\ne\nf\ng' }, 2500);
    group = lastGroup(state);
    expect(group.status).toBe('done');
    expect(group.calls[0].outputLines).toEqual(['a', 'b', '… (2 more lines)', 'e', 'f', 'g']);
    expect(group.calls[0].durationMs).toBe(1500);
  });

  it('失败结果收口为 error + 单行预览', () => {
    const [appended, messageId] = appendShellCommand(createChatState(), 'false', 1000);
    const state = resolveShellCommand(appended, messageId, { success: false, error: 'exit code 1' }, 1100);
    const group = lastGroup(state);
    expect(group.status).toBe('error');
    expect(group.calls[0].resultPreview).toBe('exit code 1');
    expect(group.calls[0].outputLines).toBeUndefined();
  });

  it('未知 messageId / 已收口的消息原样返回', () => {
    const [state, messageId] = appendShellCommand(createChatState(), 'pwd', 1000);
    expect(resolveShellCommand(state, 'nope', { success: true })).toBe(state);
    const resolved = resolveShellCommand(state, messageId, { success: true, output: '/tmp' });
    expect(resolveShellCommand(resolved, messageId, { success: false, error: 'x' })).toBe(resolved);
  });
});
