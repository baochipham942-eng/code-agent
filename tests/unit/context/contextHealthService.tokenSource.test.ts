// ============================================================================
// ContextHealthService — provider 真源总量（N-CTXTRUTH 病B）
// 口径：provider 实报 input tokens（含 cacheRead/cacheCreation）作圆环总量真源，
// 本地估算只决定桶内比例（等比缩放到真总量）；未回报/回报 0 退回估算并标 estimated。
// 反向变异承重：update() 忽略 providerUsage 参数时，用例 1/4/5 必须红。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/session/sessionStateManager', () => ({
  getSessionStateManager: () => ({ updateContextHealth: vi.fn() }),
}));

import { ContextHealthService, type ContextMessage } from '../../../src/host/context/contextHealthService';

const MESSAGES: ContextMessage[] = [
  { role: 'user', content: '帮我重构这个模块的上下文组装逻辑' },
  { role: 'assistant', content: '好的，先看一下现有结构。' },
];

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
    service.recordSourceContribution(sessionId, { type: 'rule', name: 'AGENTS' }, 400, 'set');
    service.recordSourceContribution(sessionId, { type: 'fileRead' }, 200, 'set');

    // 消息体量要明显大于来源桶，conversation 扣减后仍为正——
    // 这样 bySource 各桶合计才恰好等于 messages 估算总量（与弹层九桶同口径）
    const bigMessages: ContextMessage[] = [
      { role: 'user', content: '帮我重构这个模块的上下文组装逻辑。'.repeat(200) },
      { role: 'assistant', content: '好的，先看一下现有结构，再逐步拆解。'.repeat(200) },
    ];

    const estimatedHealth = service.update(sessionId, bigMessages, '系统提示词'.repeat(50), 'kimi-k2.5');
    const estimatedTotal = estimatedHealth.currentTokens;
    const estBySource = estimatedHealth.breakdown.bySource!;
    expect(estBySource.rules).toBe(400);
    expect(estBySource.fileReads).toBe(200);
    expect(estBySource.conversation).toBeGreaterThan(0);

    const providerTotal = estimatedTotal * 2; // 放大 2 倍，缩放比例=2
    const health = service.update(sessionId, bigMessages, '系统提示词'.repeat(50), 'kimi-k2.5', undefined, undefined, undefined, {
      inputTokens: providerTotal,
    });

    expect(health.currentTokens).toBe(providerTotal);
    const bs = health.breakdown.bySource!;
    // 桶间比例不变（缩放=2，取整误差容忍 1 token）
    expect(bs.rules).toBe(800);
    expect(bs.fileReads).toBe(400);
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

  it('连续 provider 轮次不累加缩放：累加器保持估算口径，不复合漂移', () => {
    const sessionId = 's5';
    service.recordSourceContribution(sessionId, { type: 'rule', name: 'AGENTS' }, 100, 'set');

    const estimatedTotal = service.update(sessionId, MESSAGES, '', 'kimi-k2.5').currentTokens;
    const providerTotal = estimatedTotal * 2;

    // 第一轮 provider：rules 100 → 200
    const first = service.update(sessionId, MESSAGES, '', 'kimi-k2.5', undefined, undefined, undefined, {
      inputTokens: providerTotal,
    });
    expect(first.breakdown.bySource!.rules).toBe(200);

    // 第二轮 provider（同样的估算基底）：若拿缩放快照当累加基底会漂成 400，正确是不变
    const second = service.update(sessionId, MESSAGES, '', 'kimi-k2.5', undefined, undefined, undefined, {
      inputTokens: providerTotal,
    });
    expect(second.breakdown.bySource!.rules).toBe(200);

    // 两轮之间新增的估算贡献只按当轮比例缩一次：100 + 50 = 150 → 300
    service.recordSourceContribution(sessionId, { type: 'rule', name: 'AGENTS' }, 50);
    const third = service.update(sessionId, MESSAGES, '', 'kimi-k2.5', undefined, undefined, undefined, {
      inputTokens: providerTotal,
    });
    expect(third.breakdown.bySource!.rules).toBe(300);
  });

  it('provider 轮后断流回估算：tokenSource 落回 estimated，桶回到未缩放口径', () => {
    const sessionId = 's6';
    service.recordSourceContribution(sessionId, { type: 'rule', name: 'AGENTS' }, 100, 'set');
    const estimatedTotal = service.update(sessionId, MESSAGES, '', 'kimi-k2.5').currentTokens;

    service.update(sessionId, MESSAGES, '', 'kimi-k2.5', undefined, undefined, undefined, {
      inputTokens: estimatedTotal * 2,
    });
    const fallback = service.update(sessionId, MESSAGES, '', 'kimi-k2.5');

    expect(fallback.tokenSource).toBe('estimated');
    expect(fallback.currentTokens).toBe(estimatedTotal);
    expect(fallback.breakdown.bySource!.rules).toBe(100);
  });
});
