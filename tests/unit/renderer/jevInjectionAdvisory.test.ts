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
