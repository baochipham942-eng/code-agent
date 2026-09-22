import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyJevCompaction,
} from '../../../src/host/context/jevCompaction';
import type { JevSystemOneCall } from '../../../src/shared/constants/jevQuestions';
import type { ProjectableMessage } from '../../../src/host/context/projectionEngine';

function toolTranscript(): ProjectableMessage[] {
  const messages: ProjectableMessage[] = [];
  for (let index = 0; index < 8; index++) {
    messages.push({
      id: `call-${index}`,
      role: 'assistant',
      content: `call ${index}`,
      toolCalls: [{ id: `tool-${index}`, name: 'Read' }],
    });
    messages.push({
      id: `result-${index}`,
      role: 'tool',
      content: `result ${index} ${'x'.repeat(500)}`,
      toolCallId: `tool-${index}`,
    });
  }
  return messages;
}

function keepAllExcept(overrides: Record<string, number>): JevSystemOneCall {
  return (async (_state: Record<string, unknown>, questions: Record<string, unknown>) => {
    const answers: Record<string, { noul: number }> = {};
    for (const key of Object.keys(questions)) {
      answers[key] = { noul: overrides[key] ?? 0.9 };
    }
    return answers;
  }) as unknown as JevSystemOneCall;
}

function expectNoOrphans(messages: ProjectableMessage[]): void {
  const survivingCallIds = new Set<string>();
  for (const message of messages) {
    for (const call of (Array.isArray(message.toolCalls) ? message.toolCalls : []) as Array<{ id?: unknown }>) {
      if (typeof call.id === 'string') survivingCallIds.add(call.id);
    }
  }
  const survivingResultCallIds = new Set<string>();
  for (const message of messages) {
    if (typeof message.toolCallId === 'string') {
      expect(survivingCallIds.has(message.toolCallId)).toBe(true);
      survivingResultCallIds.add(message.toolCallId);
    }
  }
  for (const callId of survivingCallIds) {
    expect(survivingResultCallIds.has(callId)).toBe(true);
  }
}

describe('jevCompaction', () => {
  beforeEach(() => vi.unstubAllEnvs());

  it('is default off and does not mutate the transcript', async () => {
    const messages = toolTranscript();
    const before = messages.map((message) => message.content);
    const systemOne = vi.fn() as unknown as JevSystemOneCall;
    const result = await applyJevCompaction(messages, systemOne);
    expect(result).toMatchObject({ skipped: true, reason: 'disabled' });
    expect(messages.map((message) => message.content)).toEqual(before);
    expect(systemOne).not.toHaveBeenCalled();
  });

  it('pins the latest six entries, drops neither pair nor orphan, and truncates result only', async () => {
    vi.stubEnv('CODE_AGENT_JEV_COMPACTION', '1');
    const messages = toolTranscript();
    let capturedState: Record<string, unknown> | undefined;
    const systemOne = vi.fn(async (state: Record<string, unknown>, questions: Record<string, unknown>) => {
      capturedState = state;
      const answers: Record<string, { noul: number }> = {};
      for (const key of Object.keys(questions)) {
        const entryKey = key.replace(/^keep_(?:call|result)_/, '');
        const entry = (state.entries as Record<string, { kind: string }>)[entryKey];
        const isCall0 = entryKey.includes('call-0');
        const isCall1Result = entryKey.includes('result-1');
        answers[key] = { noul: isCall0 ? 0.1 : isCall1Result ? 0.1 : 0.9 };
        if (entry?.kind === 'call' && isCall1Result) answers[key] = { noul: 0.9 };
      }
      return answers;
    }) as unknown as JevSystemOneCall;
    const result = await applyJevCompaction(messages, systemOne);
    expect(result.skipped).toBe(false);
    expect(result.droppedMessages).toBe(2);
    expect(result.truncatedResults).toBe(1);
    expect(messages.some((message) => message.id === 'call-0')).toBe(false);
    expect(messages.some((message) => message.id === 'result-0')).toBe(false);
    expect(messages.find((message) => message.id === 'result-1')?.content.length).toBe(300);
    expect(messages.find((message) => message.id === 'call-7')).toBeTruthy();
    expect(capturedState && Array.isArray(capturedState.entries)).toBe(false);
    expect(result.spotCheckPassed).toBe(true);
  });

  it('results carrying a real L1 spill notice are never truncated (ai-review R2/R3)', async () => {
    vi.stubEnv('CODE_AGENT_JEV_COMPACTION', '1');
    const messages = toolTranscript();
    const { buildSpillNotice } = await import('../../../src/host/utils/toolResultSpill');
    const archivePath = '/private/tmp/neo-spill/session-1/result-abc123.txt';
    const result1 = messages.find((message) => message.id === 'result-1');
    if (!result1) throw new Error('fixture missing result-1');
    // 真实 L1 形状：截短正文 + buildSpillNotice（marker 在尾部）
    result1.content = 'x'.repeat(500) + buildSpillNotice(archivePath);
    const systemOne = vi.fn(async (_state: Record<string, unknown>, questions: Record<string, unknown>) => {
      const answers: Record<string, { noul: number }> = {};
      for (const key of Object.keys(questions)) {
        answers[key] = { noul: key.includes('result-1') && key.startsWith('keep_result') ? 0.1 : 0.9 };
      }
      return answers;
    }) as unknown as JevSystemOneCall;
    const outcome = await applyJevCompaction(messages, systemOne);
    const surviving = messages.find((message) => message.id === 'result-1')?.content ?? '';
    // 带归档指针的结果整段排除出截断：内容原样保留，指针永不丢
    expect(surviving).toContain(archivePath);
    expect(surviving.length).toBeGreaterThan(300);
    expect(outcome.truncatedResults).toBe(0);
  });

  it('truncation preserves a trailing pointer-shaped tail for plain results (head+tail)', async () => {
    vi.stubEnv('CODE_AGENT_JEV_COMPACTION', '1');
    const messages = toolTranscript();
    const archivePath = '/private/tmp/neo-spill/session-1/result-abc123.txt';
    const spillTail = `\n[archived] 完整输出已归档：${archivePath}\n取回方式：用 Read 工具读上面的 archive 路径。`;
    const result1 = messages.find((message) => message.id === 'result-1');
    if (!result1) throw new Error('fixture missing result-1');
    result1.content = 'x'.repeat(500) + spillTail;
    const systemOne = vi.fn(async (_state: Record<string, unknown>, questions: Record<string, unknown>) => {
      const answers: Record<string, { noul: number }> = {};
      for (const key of Object.keys(questions)) {
        answers[key] = { noul: key.includes('result-1') && key.startsWith('keep_result') ? 0.1 : 0.9 };
      }
      return answers;
    }) as unknown as JevSystemOneCall;
    await applyJevCompaction(messages, systemOne);
    const truncated = messages.find((message) => message.id === 'result-1')?.content ?? '';
    expect(truncated.length).toBeLessThanOrEqual(300);
    expect(truncated).toContain(archivePath);
    expect(truncated).toContain('[jev-truncated]');
  });

  it('fails closed when Jev is unavailable', async () => {
    vi.stubEnv('CODE_AGENT_JEV_COMPACTION', '1');
    const messages = toolTranscript();
    const before = messages.length;
    const systemOne = vi.fn(async () => { throw new Error('jev down'); }) as unknown as JevSystemOneCall;
    const result = await applyJevCompaction(messages, systemOne);
    expect(result).toMatchObject({ skipped: true, reason: 'unavailable' });
    expect(messages.length).toBe(before);
  });

  it('never judges, drops, or truncates protected messages', async () => {
    vi.stubEnv('CODE_AGENT_JEV_COMPACTION', '1');
    const messages = toolTranscript();
    const askedKeys: string[] = [];
    const systemOne = vi.fn(async (_state: Record<string, unknown>, questions: Record<string, unknown>) => {
      askedKeys.push(...Object.keys(questions));
      const answers: Record<string, { noul: number }> = {};
      for (const key of Object.keys(questions)) answers[key] = { noul: 0.1 };
      return answers;
    }) as unknown as JevSystemOneCall;
    const result = await applyJevCompaction(messages, systemOne, {
      protectedMessageIds: new Set(['call-0', 'result-0']),
    });
    expect(result.skipped).toBe(false);
    expect(askedKeys.some((key) => key.includes('entry_call-0') || key.includes('entry_result-0'))).toBe(false);
    expect(messages.find((message) => message.id === 'call-0')).toBeTruthy();
    expect(messages.find((message) => message.id === 'result-0')?.content).toBe(`result 0 ${'x'.repeat(500)}`);
    // Unprotected pairs judged drop are still removed as whole pairs.
    expect(messages.some((message) => message.id === 'call-1')).toBe(false);
    expect(messages.some((message) => message.id === 'result-1')).toBe(false);
    expectNoOrphans(messages);
  });

  it('keeps the call when Jev would drop it but its result is protected', async () => {
    vi.stubEnv('CODE_AGENT_JEV_COMPACTION', '1');
    const messages = toolTranscript();
    const systemOne = keepAllExcept({ 'keep_call_entry_call-0': 0.1 });
    const result = await applyJevCompaction(messages, systemOne, {
      protectedMessageIds: new Set(['result-0']),
    });
    expect(result.skipped).toBe(false);
    expect(result.droppedMessages).toBe(0);
    expect(messages.find((message) => message.id === 'call-0')).toBeTruthy();
    expect(messages.find((message) => message.id === 'result-0')?.content.length).toBe(`result 0 ${'x'.repeat(500)}`.length);
    expectNoOrphans(messages);
  });

  it('truncates but never drops the result of a protected call', async () => {
    vi.stubEnv('CODE_AGENT_JEV_COMPACTION', '1');
    const messages = toolTranscript();
    const systemOne = keepAllExcept({
      'keep_call_entry_call-0': 0.1,
      'keep_result_entry_result-0': 0.1,
    });
    const result = await applyJevCompaction(messages, systemOne, {
      protectedMessageIds: new Set(['call-0']),
    });
    expect(result.skipped).toBe(false);
    const resultMessage = messages.find((message) => message.id === 'result-0');
    expect(resultMessage).toBeTruthy();
    expect(resultMessage?.content.length).toBe(300);
    expect(result.truncatedResults).toBe(1);
    expect(result.droppedMessages).toBe(0);
    expectNoOrphans(messages);
  });

  it('keeps the call when a pinned boundary result would otherwise be orphaned', async () => {
    vi.stubEnv('CODE_AGENT_JEV_COMPACTION', '1');
    const messages = toolTranscript();
    // call-0 issues a second tool call whose result arrives at the very end of
    // the transcript, so the late result is pinned while call-0 is not.
    (messages[0].toolCalls as Array<{ id: string; name: string }>).push({ id: 'tool-0b', name: 'Read' });
    messages.push({
      id: 'result-0b',
      role: 'tool',
      content: `late result ${'x'.repeat(500)}`,
      toolCallId: 'tool-0b',
    });
    const systemOne = keepAllExcept({ 'keep_call_entry_call-0': 0.1 });
    const result = await applyJevCompaction(messages, systemOne);
    expect(result.skipped).toBe(false);
    expect(result.droppedMessages).toBe(0);
    expect(messages.find((message) => message.id === 'call-0')).toBeTruthy();
    expect(messages.find((message) => message.id === 'result-0b')).toBeTruthy();
    expectNoOrphans(messages);
  });

  it('passes the spot check when a low-scored result is already under the truncation length', async () => {
    vi.stubEnv('CODE_AGENT_JEV_COMPACTION', '1');
    const messages = toolTranscript();
    messages[1].content = 'short result';
    const systemOne = keepAllExcept({ 'keep_result_entry_result-0': 0.1 });
    const result = await applyJevCompaction(messages, systemOne);
    expect(result.truncatedResults).toBe(0);
    expect(result.spotCheckPassed).toBe(true);
    expect(messages.find((message) => message.id === 'result-0')?.content).toBe('short result');
  });
});
