// ============================================================================
// ContextHealthService — provider 真源总量（N-CTXTRUTH 病B）
// 口径：provider 实报 input tokens（含 cacheRead/cacheCreation）作圆环总量真源，
// 本地估算只决定桶内比例（等比缩放到真总量）；未回报/回报 0 退回估算并标 estimated。
// 反向变异承重：update() 忽略 providerUsage 参数时，用例 1/4/5 必须红。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateTokens } from '../../../src/host/context/tokenEstimator';

vi.mock('../../../src/host/session/sessionStateManager', () => ({
  getSessionStateManager: () => ({ updateContextHealth: vi.fn() }),
}));

import { ContextHealthService, type ContextMessage } from '../../../src/host/context/contextHealthService';

const MESSAGES: ContextMessage[] = [
  { role: 'user', content: '帮我重构这个模块的上下文组装逻辑' },
  { role: 'assistant', content: '好的，先看一下现有结构。' },
];

// N-CTXCURRENT: rules/fileReads 不再走 record 累计账，由构成函数从消息重算。
// rules = 持久化 system 消息里的 <agents-instructions> 段；fileReads = Read 调用+结果。
const AGENTS_BLOCK = [
  '<agents-instructions>',
  'The following AGENTS.md instructions were discovered in the project:',
  '',
  '# AGENTS.md',
  '',
  '构建前先跑 npm run typecheck。',
  '</agents-instructions>',
].join('\n');
const RULES_TOKENS = estimateTokens(AGENTS_BLOCK);
const READ_ARGS = { file_path: '/tmp/a.ts' };
const READ_CALL_TOKENS = estimateTokens(`Read\n${JSON.stringify(READ_ARGS)}`);
const READ_OUTPUT = 'const answer = 42;\n'.repeat(20);
const FILE_READ_TOKENS = READ_CALL_TOKENS + estimateTokens(READ_OUTPUT);

function messagesWithSources(bigConversation: ContextMessage[]): ContextMessage[] {
  return [
    { role: 'system', content: `<session-start-hook>\n${AGENTS_BLOCK}\n</session-start-hook>` },
    ...bigConversation,
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'r1', name: 'Read', arguments: READ_ARGS }],
    },
    {
      role: 'tool',
      content: JSON.stringify([{ toolCallId: 'r1', output: READ_OUTPUT }]),
      toolResults: [{ toolCallId: 'r1', output: READ_OUTPUT }],
    },
  ];
}

function localEstimate(service: ContextHealthService, sessionId: string): number {
  // 不传 providerUsage 走纯估算，拿到同一批消息的本地估算总量作基准
  return service.update(sessionId, MESSAGES, '', 'kimi-k2.5').currentTokens;
}

describe('ContextHealthService — provider 真源总量（N-CTXTRUTH）', () => {
  let service: ContextHealthService;

  beforeEach(() => {
    service = new ContextHealthService();
  });

  it('provider 回报时：currentTokens=实报总量（含 cache），tokenSource=provider，带估算对照', () => {
    const estimated = localEstimate(service, 'base');
    expect(estimated).toBeGreaterThan(0);

    const health = service.update('s1', MESSAGES, '', 'kimi-k2.5', undefined, undefined, undefined, {
      inputTokens: 8000,
      cacheReadTokens: 1500,
      cacheCreationTokens: 500,
    });

    expect(health.tokenSource).toBe('provider');
    // 实报总量 = inputTokens + cacheRead + cacheCreation
    expect(health.currentTokens).toBe(10000);
    expect(health.usagePercent).toBe(Math.round((10000 / health.maxTokens) * 1000) / 10);
    // 估算对照保留（缩放前总量），供弹层显示估/实偏差
    expect(health.estimatedTokens).toBe(estimated);
  });

  it('provider 未回报（不传参）时：全走估算，tokenSource=estimated，无估算对照', () => {
    const health = service.update('s2', MESSAGES, '', 'kimi-k2.5');

    expect(health.tokenSource).toBe('estimated');
    expect(health.estimatedTokens).toBeUndefined();
    expect(health.currentTokens).toBe(localEstimate(service, 'base2'));
  });

  it('provider 回报 0（如 SSE 断流）时：退回估算并标 estimated', () => {
    const health = service.update('s3', MESSAGES, '', 'kimi-k2.5', undefined, undefined, undefined, {
      inputTokens: 0,
      cacheReadTokens: 0,
    });

    expect(health.tokenSource).toBe('estimated');
    expect(health.estimatedTokens).toBeUndefined();
    expect(health.currentTokens).toBe(localEstimate(service, 'base3'));
  });

  it('等比缩放：各桶比例不变，总量=真源', () => {
    const sessionId = 's4';

    // 消息体量要明显大于来源桶，conversation 扣减后仍为正——
    // 这样 bySource 各桶合计才恰好等于 messages 估算总量（与弹层九桶同口径）
    const bigMessages = messagesWithSources([
      { role: 'user', content: '帮我重构这个模块的上下文组装逻辑。'.repeat(200) },
      { role: 'assistant', content: '好的，先看一下现有结构，再逐步拆解。'.repeat(200) },
    ]);

    const estimatedHealth = service.update(sessionId, bigMessages, '系统提示词'.repeat(50), 'kimi-k2.5');
    const estimatedTotal = estimatedHealth.currentTokens;
    const estBySource = estimatedHealth.breakdown.bySource!;
    expect(estBySource.rules).toBe(RULES_TOKENS);
    expect(estBySource.fileReads).toBe(FILE_READ_TOKENS);
    expect(estBySource.conversation).toBeGreaterThan(0);

    const providerTotal = estimatedTotal * 2; // 放大 2 倍，缩放比例=2
    const health = service.update(sessionId, bigMessages, '系统提示词'.repeat(50), 'kimi-k2.5', undefined, undefined, undefined, {
      inputTokens: providerTotal,
    });

    expect(health.currentTokens).toBe(providerTotal);
    const bs = health.breakdown.bySource!;
    // 桶间比例不变（缩放=2，取整误差容忍 1 token）
    expect(bs.rules).toBe(RULES_TOKENS * 2);
    expect(bs.fileReads).toBe(FILE_READ_TOKENS * 2);
    expect(bs.conversation).toBe(Math.round(estBySource.conversation * 2));
    // 结构维度桶同样缩放
    expect(health.breakdown.systemPrompt).toBe(
      Math.round(estimatedHealth.breakdown.systemPrompt * 2),
    );
    // 弹层九桶合计贴合真总量（rounding 漂移每桶 ≤0.5 token）
    const bucketSum =
      health.breakdown.systemPrompt +
      (health.breakdown.toolDefinitions ?? 0) +
      bs.rules +
      Object.values(bs.skills).reduce((a, b) => a + b, 0) +
      Object.values(bs.mcp).reduce((a, b) => a + b, 0) +
      Object.values(bs.subagents).reduce((a, b) => a + b, 0) +
      bs.fileReads +
      bs.summary +
      bs.conversation;
    expect(Math.abs(bucketSum - providerTotal)).toBeLessThanOrEqual(5);
  });

  it('连续 provider 轮次不复合缩放：bySource 每轮从消息重算，与上轮快照无关', () => {
    const sessionId = 's5';
    const messages = messagesWithSources(MESSAGES);

    const estimatedTotal = service.update(sessionId, messages, '', 'kimi-k2.5').currentTokens;
    const providerTotal = estimatedTotal * 2;

    // 第一轮 provider：rules 估算值 ×2
    const first = service.update(sessionId, messages, '', 'kimi-k2.5', undefined, undefined, undefined, {
      inputTokens: providerTotal,
    });
    expect(first.breakdown.bySource!.rules).toBe(RULES_TOKENS * 2);

    // 第二轮 provider（同样的消息）：当前态重算，不存在「拿缩放快照当基底」的漂移
    const second = service.update(sessionId, messages, '', 'kimi-k2.5', undefined, undefined, undefined, {
      inputTokens: providerTotal,
    });
    expect(second.breakdown.bySource!.rules).toBe(RULES_TOKENS * 2);

    // 第三轮消息里少了 Read 调用：fileReads 立即归零（当前态，不是累计残留）
    const third = service.update(sessionId, MESSAGES, '', 'kimi-k2.5', undefined, undefined, undefined, {
      inputTokens: providerTotal,
    });
    expect(third.breakdown.bySource!.fileReads).toBe(0);
  });

  it('provider 轮后断流回估算：tokenSource 落回 estimated，桶回到未缩放口径', () => {
    const sessionId = 's6';
    const messages = messagesWithSources(MESSAGES);
    const estimatedTotal = service.update(sessionId, messages, '', 'kimi-k2.5').currentTokens;

    service.update(sessionId, messages, '', 'kimi-k2.5', undefined, undefined, undefined, {
      inputTokens: estimatedTotal * 2,
    });
    const fallback = service.update(sessionId, messages, '', 'kimi-k2.5');

    expect(fallback.tokenSource).toBe('estimated');
    expect(fallback.currentTokens).toBe(estimatedTotal);
    expect(fallback.breakdown.bySource!.rules).toBe(RULES_TOKENS);
  });
});
