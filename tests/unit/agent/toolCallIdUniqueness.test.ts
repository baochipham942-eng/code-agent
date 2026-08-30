// ============================================================================
// toolCallId 唯一性护栏回归测试
//
// 事故背景（glm-5.3-flash 场景验证）：弱模型同批次/跨轮重复发同一个 toolCallId，
// 下游一律以 toolCallId 为 Map 键配对（transcriptProjector 导出、telemetryCollector、
// messageHydration 等），同 id 后写覆盖前写——表现为「Bash 的 tool_result 被
// 同 id 的 MemoryWrite 确认门错误替换」「已成功的工具成果被覆盖成 success:false」。
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { Message, ToolCall } from '../../../src/shared/contract';
import { ensureUniqueToolCallIds } from '../../../src/host/agent/runtime/toolCallIdUniqueness';

function makeCall(id: string, name: string): ToolCall {
  return { id, name, arguments: {} };
}

function makeAssistantMessage(toolCalls: ToolCall[]): Message {
  return {
    id: `msg-${Math.random().toString(16).slice(2)}`,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    toolCalls,
  };
}

function makeToolMessage(results: Array<{ toolCallId: string; success: boolean }>): Message {
  return {
    id: `msg-${Math.random().toString(16).slice(2)}`,
    role: 'tool',
    content: '',
    timestamp: Date.now(),
    toolResults: results.map((r) => ({ ...r, duration: 1 })),
  };
}

describe('ensureUniqueToolCallIds', () => {
  it('无重复时原样返回（同引用，零改写）', () => {
    const calls = [makeCall('call_1', 'Bash'), makeCall('call_2', 'MemoryWrite')];
    const { toolCalls, rewrites } = ensureUniqueToolCallIds(calls, []);

    expect(rewrites).toEqual([]);
    expect(toolCalls[0]).toBe(calls[0]);
    expect(toolCalls[1]).toBe(calls[1]);
  });

  it('同批次重复 id：后者改写为唯一 id，结果配对不再串线', () => {
    // glm-5.3-flash 真实形态：Bash 与 MemoryWrite 共享同一个 id
    const calls = [makeCall('call_1', 'Bash'), makeCall('call_1', 'MemoryWrite')];
    const { toolCalls, rewrites } = ensureUniqueToolCallIds(calls, []);

    expect(rewrites).toHaveLength(1);
    expect(rewrites[0]).toMatchObject({ toolName: 'MemoryWrite', from: 'call_1' });
    expect(toolCalls[0].id).toBe('call_1');
    expect(toolCalls[1].id).not.toBe('call_1');
    expect(new Set(toolCalls.map((c) => c.id)).size).toBe(2);
    // 改写只动 id，不动参数
    expect(toolCalls[1].name).toBe('MemoryWrite');
  });

  it('跨轮重复 id（模型每轮都叫 call_1）：与历史冲突的 id 被改写', () => {
    const history: Message[] = [
      makeAssistantMessage([makeCall('call_1', 'Bash')]),
      makeToolMessage([{ toolCallId: 'call_1', success: true }]),
    ];
    const calls = [makeCall('call_1', 'MemoryWrite')];
    const { toolCalls, rewrites } = ensureUniqueToolCallIds(calls, history);

    expect(rewrites).toHaveLength(1);
    expect(toolCalls[0].id).not.toBe('call_1');
  });

  it('历史 toolResults 里的 id 同样占位（失败轮的结果也算历史）', () => {
    const history: Message[] = [
      makeToolMessage([{ toolCallId: 'call_1', success: false }]),
    ];
    const calls = [makeCall('call_1', 'Bash'), makeCall('call_1', 'Read')];
    const { toolCalls } = ensureUniqueToolCallIds(calls, history);

    expect(toolCalls[0].id).not.toBe('call_1');
    expect(toolCalls[1].id).not.toBe('call_1');
    expect(toolCalls[0].id).not.toBe(toolCalls[1].id);
  });

  it('空 id 也会分配到唯一 id', () => {
    const calls = [makeCall('', 'Bash'), makeCall('', 'Read')];
    const { toolCalls, rewrites } = ensureUniqueToolCallIds(calls, []);

    expect(rewrites).toHaveLength(2);
    expect(toolCalls[0].id).toBeTruthy();
    expect(toolCalls[1].id).toBeTruthy();
    expect(toolCalls[0].id).not.toBe(toolCalls[1].id);
  });
});
