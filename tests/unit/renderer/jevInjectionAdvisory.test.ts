import { describe, expect, it } from 'vitest';
import { hasCurrentTurnJevInjectionFlag } from '../../../src/renderer/utils/jevInjectionAdvisory';
import type { Message, ToolResult } from '../../../src/shared/contract';

function toolResult(flagged: boolean): ToolResult {
  return {
    toolCallId: 'tc-1',
    success: true,
    output: 'remote text',
    metadata: {
      jevInjectionScan: { skipped: false, flagged, injection: 0.99, exfilRequest: 0.99 },
    },
  };
}

function message(partial: Partial<Message> & Pick<Message, 'id' | 'role'>): Message {
  return { content: '', timestamp: 0, ...partial };
}

describe('hasCurrentTurnJevInjectionFlag', () => {
  it('本轮有 flagged 工具结果 → 显示 advisory', () => {
    const messages = [
      message({ id: 'u1', role: 'user', content: '帮我查一下安装步骤' }),
      message({ id: 'a1', role: 'assistant', toolResults: [toolResult(true)] }),
    ];
    expect(hasCurrentTurnJevInjectionFlag(messages)).toBe(true);
  });

  it('只有上一轮有标记 → 不显示', () => {
    const messages = [
      message({ id: 'u1', role: 'user' }),
      message({ id: 'a1', role: 'assistant', toolResults: [toolResult(true)] }),
      message({ id: 'u2', role: 'user', content: '继续' }),
      message({ id: 'a2', role: 'assistant', content: '好的' }),
    ];
    expect(hasCurrentTurnJevInjectionFlag(messages)).toBe(false);
  });

  it('本轮工具结果无标记 → 不显示', () => {
    const messages = [
      message({ id: 'u1', role: 'user' }),
      message({ id: 'a1', role: 'assistant', toolResults: [toolResult(false)] }),
    ];
    expect(hasCurrentTurnJevInjectionFlag(messages)).toBe(false);
  });

  it('没有任何工具结果 / 空会话 → 不显示', () => {
    expect(hasCurrentTurnJevInjectionFlag([])).toBe(false);
    expect(hasCurrentTurnJevInjectionFlag([
      message({ id: 'u1', role: 'user' }),
      message({ id: 'a1', role: 'assistant', content: '回复' }),
    ])).toBe(false);
  });

  it('runtimeSteer 用户消息不算新一轮：steer 之前的本轮标记仍显示', () => {
    const messages = [
      message({ id: 'u1', role: 'user' }),
      message({ id: 'a1', role: 'assistant', toolResults: [toolResult(true)] }),
      message({ id: 's1', role: 'user', metadata: { runtimeSteer: true } }),
    ];
    expect(hasCurrentTurnJevInjectionFlag(messages)).toBe(true);
  });

  it('metadata 形状坏掉（非对象 / 缺 flagged）不当作标记', () => {
    const broken: ToolResult = {
      toolCallId: 'tc-1',
      success: true,
      output: 'x',
      metadata: { jevInjectionScan: 'not-an-object' },
    };
    const missingFlag: ToolResult = {
      toolCallId: 'tc-2',
      success: true,
      output: 'x',
      metadata: { jevInjectionScan: { skipped: true, flagged: false, reason: 'disabled' } },
    };
    const messages = [
      message({ id: 'u1', role: 'user' }),
      message({ id: 'a1', role: 'assistant', toolResults: [broken, missingFlag] }),
    ];
    expect(hasCurrentTurnJevInjectionFlag(messages)).toBe(false);
  });
});

// R1 review fix 夹具：renderer 消息流里工具结果的两种真实形状
// （实时 toolCalls[].result / 落库 role:'tool' + toolResults）。
describe('hasCurrentTurnJevInjectionFlag 真实形状（R1）', () => {
  it('实时形状：tool_call_end 写进 assistant toolCalls[].result → 显示', () => {
    const messages = [
      message({ id: 'u1', role: 'user' }),
      message({
        id: 'a1',
        role: 'assistant',
        toolCalls: [{ id: 'tc-1', name: 'WebSearch', arguments: {}, result: toolResult(true) }],
      }),
    ];
    expect(hasCurrentTurnJevInjectionFlag(messages)).toBe(true);
  });

  it('落库形状：role:tool 消息的 toolResults 带标记 → 显示', () => {
    const messages = [
      message({ id: 'u1', role: 'user' }),
      message({
        id: 'a1',
        role: 'assistant',
        toolCalls: [{ id: 'tc-1', name: 'WebSearch', arguments: {} }],
      }),
      message({ id: 't1', role: 'tool', toolResults: [toolResult(true)] }),
    ];
    expect(hasCurrentTurnJevInjectionFlag(messages)).toBe(true);
  });

  it('实时形状只在上一轮标记 → 不显示', () => {
    const messages = [
      message({ id: 'u1', role: 'user' }),
      message({
        id: 'a1',
        role: 'assistant',
        toolCalls: [{ id: 'tc-1', name: 'WebSearch', arguments: {}, result: toolResult(true) }],
      }),
      message({ id: 'u2', role: 'user', content: '继续' }),
      message({ id: 'a2', role: 'assistant', content: '好的' }),
    ];
    expect(hasCurrentTurnJevInjectionFlag(messages)).toBe(false);
  });

  it('toolCalls 还没有 result（工具在跑/待审批）→ 不显示', () => {
    const messages = [
      message({ id: 'u1', role: 'user' }),
      message({
        id: 'a1',
        role: 'assistant',
        toolCalls: [{ id: 'tc-1', name: 'WebSearch', arguments: {} }],
      }),
    ];
    expect(hasCurrentTurnJevInjectionFlag(messages)).toBe(false);
  });

  it('实时形状 result.flagged=false → 不显示', () => {
    const messages = [
      message({ id: 'u1', role: 'user' }),
      message({
        id: 'a1',
        role: 'assistant',
        toolCalls: [{ id: 'tc-1', name: 'WebSearch', arguments: {}, result: toolResult(false) }],
      }),
    ];
    expect(hasCurrentTurnJevInjectionFlag(messages)).toBe(false);
  });
});
