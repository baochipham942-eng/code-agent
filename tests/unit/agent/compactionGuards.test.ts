// Item2 压缩系统 B 护栏的纯逻辑单测：剪枝测量 + 卡死计数状态转移。
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/host/mcp/logCollector', () => ({
  logCollector: { agent: vi.fn(), addLog: vi.fn(), tool: vi.fn(), browser: vi.fn() },
}));

import {
  estimatePrunedTranscriptTokens,
  nextCompactionGuardState,
} from '../../../src/host/agent/runtime/contextAssembly/compression';
import { estimateTokens } from '../../../src/host/context/tokenOptimizer';
import type { Message } from '../../../src/shared/contract';

function msg(id: string, role: Message['role'], content: string, toolCallId?: string): Message {
  return { id, role, content, timestamp: 1, ...(toolCallId ? { toolCallId } : {}) } as Message;
}

describe('nextCompactionGuardState', () => {
  it('resets the counter when pressure dropped below threshold', () => {
    expect(nextCompactionGuardState(5, 2, false)).toEqual({ consecutive: 0, shouldPause: false });
  });

  it('increments while still over and pauses on reaching the cap', () => {
    expect(nextCompactionGuardState(0, 2, true)).toEqual({ consecutive: 1, shouldPause: false });
    expect(nextCompactionGuardState(1, 2, true)).toEqual({ consecutive: 2, shouldPause: true });
  });
});

describe('estimatePrunedTranscriptTokens', () => {
  it('budgets oversized tool results down (non-destructive measurement)', () => {
    const hugeToolOutput = 'x '.repeat(20_000); // 远超 2000 token/结果
    const messages: Message[] = [
      msg('u1', 'user', 'do something'),
      msg('a1', 'assistant', 'calling tool'),
      msg('t1', 'tool', hugeToolOutput, 'call-1'),
    ];
    const rawTokens = messages.reduce((s, m) => s + estimateTokens(m.content || ''), 0);
    const pruned = estimatePrunedTranscriptTokens(messages);

    // 工具结果被预算化 → pruned 远小于 raw
    expect(pruned).toBeLessThan(rawTokens);
    // 但绝不 mutate 原始 transcript（系统 A 非破坏投影的真理源）
    expect(messages[2].content).toBe(hugeToolOutput);
  });

  it('leaves small transcripts unchanged', () => {
    const messages: Message[] = [
      msg('u1', 'user', 'hi'),
      msg('a1', 'assistant', 'hello'),
      msg('t1', 'tool', 'small ok', 'call-1'),
    ];
    const rawTokens = messages.reduce((s, m) => s + estimateTokens(m.content || ''), 0);
    expect(estimatePrunedTranscriptTokens(messages)).toBe(rawTokens);
  });
});
