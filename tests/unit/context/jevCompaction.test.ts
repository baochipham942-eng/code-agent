import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyJevCompaction,
} from '../../../src/host/context/jevCompaction';
import {
  JEV_COMPACTION_PINNED_RECENT_MESSAGES,
  JEV_COMPACTION_THRESHOLDS,
  type JevSystemOneCall,
} from '../../../src/shared/constants/jevQuestions';
import { estimateTokens } from '../../../src/host/context/tokenEstimator';
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
        // 验收①判定表：整对删除要求 call 与 result 双双低于阈值，故 result-0 也压到 0.1。
        const isPair0 = entryKey.includes('call-0') || entryKey.includes('result-0');
        const isCall1Result = entryKey.includes('result-1');
        answers[key] = { noul: isPair0 ? 0.1 : isCall1Result ? 0.1 : 0.9 };
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

// ---------------------------------------------------------------------------
// N-JEV-COMPACTION-MOCK：母单验收①②③④⑤差口的补缺单测。判官一律 mock。
// ---------------------------------------------------------------------------

function toolTranscriptN(pairs: number): ProjectableMessage[] {
  const messages: ProjectableMessage[] = [];
  for (let index = 0; index < pairs; index++) {
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

/** 判官替身：所有问题统一回同一个 noul。 */
function judgeAll(noul: number): JevSystemOneCall {
  return (async (_state: Record<string, unknown>, questions: Record<string, unknown>) => {
    const answers: Record<string, { noul: number }> = {};
    for (const key of Object.keys(questions)) answers[key] = { noul };
    return answers;
  }) as unknown as JevSystemOneCall;
}

/** 高熵但安全的夹具正文：规避注入/密钥正则，BPE 不按重复单字符塌缩。 */
function variedText(seed: number, length: number): string {
  const words = [
    'lorem', 'ipsum', 'dolor', 'amet', 'consectetur', 'adipiscing', 'elit',
    'sed', 'tempor', 'labore', 'dolore', 'magna', 'aliqua', 'enim', 'veniam',
    'nostrud', 'ullamco', 'laboris', 'aliquip', 'commodo',
  ];
  let text = `chunk ${seed} `;
  let state = seed + 1;
  while (text.length < length) {
    state = (state * 1103515245 + 12345) % 2147483648;
    text += `${words[state % words.length]}${state % 997} `;
  }
  return text.slice(0, length);
}

describe('jevCompaction 判定表四格（验收①）', () => {
  beforeEach(() => vi.unstubAllEnvs());

  it('双双过低整对删 / 只 result 过线原文保留 / 只 call 过线截断 result / 双高原样', async () => {
    vi.stubEnv('CODE_AGENT_JEV_COMPACTION', '1');
    // 12 对：钉死窗口（最后 10 条消息）与最后 6 条工具条目只覆盖 pair 7-11，pair 0-3 全部在判。
    const messages = toolTranscriptN(12);
    const originals = new Map(messages.map((message) => [message.id, message.content]));
    const low = 0.1;
    const high = 0.9;
    const systemOne = keepAllExcept({
      'keep_call_entry_call-0': low,
      'keep_result_entry_result-0': low,
      'keep_call_entry_call-1': low,
      'keep_result_entry_result-1': high,
      'keep_call_entry_call-2': high,
      'keep_result_entry_result-2': low,
      'keep_call_entry_call-3': high,
      'keep_result_entry_result-3': high,
    });
    const result = await applyJevCompaction(messages, systemOne);
    expect(result.skipped).toBe(false);
    // 格1：call 与 result 都低于阈值 → 整对删除。
    expect(messages.some((message) => message.id === 'call-0')).toBe(false);
    expect(messages.some((message) => message.id === 'result-0')).toBe(false);
    expect(result.droppedMessages).toBe(2);
    // 格2：result ≥ 阈值 → call+result 原文保留（即使 call 低于阈值）。
    expect(messages.find((message) => message.id === 'call-1')?.content).toBe(originals.get('call-1'));
    expect(messages.find((message) => message.id === 'result-1')?.content).toBe(originals.get('result-1'));
    // 格3：只 call 过线 → result 截断到 truncatedResultChars。
    expect(messages.find((message) => message.id === 'call-2')?.content).toBe(originals.get('call-2'));
    expect(messages.find((message) => message.id === 'result-2')?.content.length)
      .toBe(JEV_COMPACTION_THRESHOLDS.truncatedResultChars);
    expect(result.truncatedResults).toBe(1);
    // 格4：双高 → 原样。
    expect(messages.find((message) => message.id === 'call-3')?.content).toBe(originals.get('call-3'));
    expect(messages.find((message) => message.id === 'result-3')?.content).toBe(originals.get('result-3'));
    expectNoOrphans(messages);
  });
});

describe('jevCompaction 钉死集合（验收②）', () => {
  beforeEach(() => vi.unstubAllEnvs());

  it('pinnedRecentMessages = 10，对齐 autoCompressor/compactionService 的 preserveRecentCount 默认值', () => {
    expect(JEV_COMPACTION_PINNED_RECENT_MESSAGES).toBe(10);
  });

  it('钉死集合 = 最后 10 条消息里的工具消息 ∪ 最后 6 条工具条目（只增不减）', async () => {
    vi.stubEnv('CODE_AGENT_JEV_COMPACTION', '1');
    const messages = toolTranscript();
    const originals = new Map(messages.map((message) => [message.id, message.content]));
    // 尾部 3 条 user 消息让「最后 10 条消息」窗口(索引 9-18，含 result-4)比
    // 「最后 6 条工具条目」(索引 10-15)多钉一条 result-4。
    messages.push({ id: 'user-tail-0', role: 'user', content: 'tail user 0' });
    messages.push({ id: 'user-tail-1', role: 'user', content: 'tail user 1' });
    messages.push({ id: 'user-tail-2', role: 'user', content: 'tail user 2' });
    const result = await applyJevCompaction(messages, judgeAll(0.1));
    expect(result.skipped).toBe(false);
    // result-4 被窗口钉死 → 原文保留；pair 完整性顺带保住 call-4。
    expect(messages.find((message) => message.id === 'result-4')?.content).toBe(originals.get('result-4'));
    expect(messages.find((message) => message.id === 'call-4')?.content).toBe(originals.get('call-4'));
    // 窗口之外的 pair 0-3 整对删除。
    for (const index of [0, 1, 2, 3]) {
      expect(messages.some((message) => message.id === `call-${index}`)).toBe(false);
      expect(messages.some((message) => message.id === `result-${index}`)).toBe(false);
    }
    expect(result.droppedMessages).toBe(8);
    // 只增不减：现行最后 6 条工具条目（pair 5-7）依旧钉死。
    for (const index of [5, 6, 7]) {
      expect(messages.find((message) => message.id === `call-${index}`)?.content).toBe(originals.get(`call-${index}`));
      expect(messages.find((message) => message.id === `result-${index}`)?.content).toBe(originals.get(`result-${index}`));
    }
    expect(messages.find((message) => message.id === 'user-tail-2')?.content).toBe('tail user 2');
    expectNoOrphans(messages);
  });
});

describe('jevCompaction fail-open（验收③）', () => {
  beforeEach(() => vi.unstubAllEnvs());

  it('开关开但无 TYPESAFE_API_KEY 且未注入判官 → skipped/unavailable，transcript 逐字节不变', async () => {
    vi.stubEnv('CODE_AGENT_JEV_COMPACTION', '1');
    vi.stubEnv('TYPESAFE_API_KEY', '');
    const messages = toolTranscript();
    const snapshot = JSON.stringify(messages);
    const result = await applyJevCompaction(messages);
    expect(result).toMatchObject({ skipped: true, reason: 'unavailable' });
    expect(JSON.stringify(messages)).toBe(snapshot);
  });

  it('判官超时 → fail-open unavailable，transcript 逐字节不变', async () => {
    vi.stubEnv('CODE_AGENT_JEV_COMPACTION', '1');
    const messages = toolTranscript();
    const snapshot = JSON.stringify(messages);
    const systemOne = vi.fn(async () => {
      const error = new Error('systemOne 超时（5000ms）或被外部中止');
      error.name = 'AbortError';
      throw error;
    }) as unknown as JevSystemOneCall;
    const result = await applyJevCompaction(messages, systemOne);
    expect(result).toMatchObject({ skipped: true, reason: 'unavailable' });
    expect(JSON.stringify(messages)).toBe(snapshot);
  });

  it('判官坏形状 → bad_shape，transcript 逐字节不变', async () => {
    vi.stubEnv('CODE_AGENT_JEV_COMPACTION', '1');
    const messages = toolTranscript();
    const snapshot = JSON.stringify(messages);
    const systemOne = vi.fn(async (_state: Record<string, unknown>, questions: Record<string, unknown>) => {
      const answers: Record<string, unknown> = {};
      for (const key of Object.keys(questions)) answers[key] = { noul: 'high' };
      return answers;
    }) as unknown as JevSystemOneCall;
    const result = await applyJevCompaction(messages, systemOne);
    expect(result).toMatchObject({ skipped: true, reason: 'bad_shape' });
    expect(JSON.stringify(messages)).toBe(snapshot);
  });
});

describe('jevCompaction state 形状与批次预算（验收④）', () => {
  beforeEach(() => vi.unstubAllEnvs());

  it('state 只用命名键 entry_*，问句不含数组下标', async () => {
    vi.stubEnv('CODE_AGENT_JEV_COMPACTION', '1');
    const messages = toolTranscript();
    let capturedState: Record<string, unknown> | undefined;
    let capturedQuestions: Record<string, unknown> | undefined;
    const systemOne = (async (state: Record<string, unknown>, questions: Record<string, unknown>) => {
      capturedState = state;
      capturedQuestions = questions;
      const answers: Record<string, { noul: number }> = {};
      for (const key of Object.keys(questions)) answers[key] = { noul: 0.9 };
      return answers;
    }) as unknown as JevSystemOneCall;
    await applyJevCompaction(messages, systemOne);
    const entries = capturedState?.entries as Record<string, unknown>;
    expect(entries).toBeTruthy();
    expect(Array.isArray(entries)).toBe(false);
    for (const key of Object.keys(entries)) {
      expect(key).toMatch(/^entry_[A-Za-z0-9_-]+$/);
    }
    for (const key of Object.keys(capturedQuestions ?? {})) {
      expect(key).toMatch(/^keep_(call|result)_entry_[A-Za-z0-9_-]+$/);
      expect(key).not.toMatch(/[\[\]]/);
      expect(key).not.toMatch(/\.\d+/);
    }
    expect(JSON.stringify(capturedState)).not.toMatch(/\[\d+\]/);
  });

  it('大量大条目夹具：任一批次 state+问句估算 ≤ 25k token，且分批真实发生', async () => {
    vi.stubEnv('CODE_AGENT_JEV_COMPACTION', '1');
    const messages: ProjectableMessage[] = [];
    for (let index = 0; index < 30; index++) {
      messages.push({
        id: `bulk-call-${index}`,
        role: 'assistant',
        content: `bulk call ${index}`,
        toolCalls: [{ id: `bulk-tool-${index}`, name: 'Read' }],
      });
      messages.push({
        id: `bulk-result-${index}`,
        role: 'tool',
        content: variedText(index, 4500),
        toolCallId: `bulk-tool-${index}`,
      });
    }
    const batches: Array<{ state: Record<string, unknown>; questions: Record<string, unknown> }> = [];
    const systemOne = (async (state: Record<string, unknown>, questions: Record<string, unknown>) => {
      batches.push({ state, questions });
      const answers: Record<string, { noul: number }> = {};
      for (const key of Object.keys(questions)) answers[key] = { noul: 0.9 };
      return answers;
    }) as unknown as JevSystemOneCall;
    const result = await applyJevCompaction(messages, systemOne);
    expect(result.skipped).toBe(false);
    expect(batches.length).toBeGreaterThan(1);
    for (const { state, questions } of batches) {
      const estimate = estimateTokens(JSON.stringify(state)) + estimateTokens(JSON.stringify(questions));
      expect(estimate).toBeLessThanOrEqual(JEV_COMPACTION_THRESHOLDS.maxBatchTokens);
    }
  });
});

describe('jevCompaction 反向变异锚点（验收⑤）', () => {
  beforeEach(() => vi.unstubAllEnvs());

  it('keep 恒 0：最新 N 条钉死与全部 system/user 消息原样保留', async () => {
    vi.stubEnv('CODE_AGENT_JEV_COMPACTION', '1');
    const messages: ProjectableMessage[] = [
      { id: 'sys', role: 'system', content: 'system prompt stays' },
      { id: 'user-0', role: 'user', content: 'first user turn' },
      ...toolTranscript(),
      { id: 'user-tail', role: 'user', content: 'last user turn' },
    ];
    const originals = new Map(messages.map((message) => [message.id, message.content]));
    const result = await applyJevCompaction(messages, judgeAll(0));
    expect(result.skipped).toBe(false);
    // system/user 消息从不进候选，逐字节保留。
    for (const id of ['sys', 'user-0', 'user-tail']) {
      expect(messages.find((message) => message.id === id)?.content).toBe(originals.get(id));
    }
    // 钉死集合（窗口 result-3 + pair 4-7）原样保留；pair 3 的 call 因 result-3 钉死而保住。
    for (const id of ['result-3', 'call-3', 'call-4', 'result-4', 'call-5', 'result-5', 'call-6', 'result-6', 'call-7', 'result-7']) {
      expect(messages.find((message) => message.id === id)?.content).toBe(originals.get(id));
    }
    // 窗口外的 pair 0-2 整对删除。
    for (const index of [0, 1, 2]) {
      expect(messages.some((message) => message.id === `call-${index}`)).toBe(false);
      expect(messages.some((message) => message.id === `result-${index}`)).toBe(false);
    }
    expect(result.droppedMessages).toBe(6);
    expectNoOrphans(messages);
  });

  it('keep 恒 1：送给判官的 state 不含夹具 key/密码原文（guardSensitiveText 先行），transcript 原样', async () => {
    vi.stubEnv('CODE_AGENT_JEV_COMPACTION', '1');
    const fakeKey = 'sk-FAKE000111222333444555';
    const fakePassword = 'hunter2fake';
    const messages = toolTranscript();
    const result1 = messages.find((message) => message.id === 'result-1');
    if (!result1) throw new Error('fixture missing result-1');
    result1.content = `result 1 output\napi_key=${fakeKey}\npassword: ${fakePassword}\n${'x'.repeat(500)}`;
    const originals = new Map(messages.map((message) => [message.id, message.content]));
    let capturedState: Record<string, unknown> | undefined;
    const systemOne = (async (state: Record<string, unknown>, questions: Record<string, unknown>) => {
      capturedState = state;
      const answers: Record<string, { noul: number }> = {};
      for (const key of Object.keys(questions)) answers[key] = { noul: 1 };
      return answers;
    }) as unknown as JevSystemOneCall;
    const result = await applyJevCompaction(messages, systemOne);
    expect(result.skipped).toBe(false);
    expect(result.changed).toBe(false);
    const sent = JSON.stringify(capturedState);
    expect(sent).not.toContain(fakeKey);
    expect(sent).not.toContain(fakePassword);
    expect(sent).toContain('***REDACTED***');
    // 脱敏只作用于送给判官的副本；transcript 本体逐字节不动。
    for (const message of messages) {
      expect(message.content).toBe(originals.get(message.id));
    }
  });
});
