// ============================================================================
// routingResolvedEvent —— routing_resolved 事件载荷的单一构造真源
// ----------------------------------------------------------------------------
// 背景（三层一致性批③）：orchestrator（IPC 路径）与 /api/agent/run（web 生产路径）
// 各自手写事件载荷，且显式选择被硬编码为 mode:'auto'、显式解析失败被静默兜底。
// 本模块统一载荷形状：mode 区分 auto/explicit，requestedAgentId 携带用户显式
// 请求的 agent id，renderer 据 requestedAgentId !== agentId 判定降级。
// ============================================================================
import { describe, expect, it } from 'vitest';
import { buildRoutingResolvedEventData } from '../../../src/host/agent/routingResolvedEvent';

const autoResolution = {
  agent: { id: 'coder', name: 'Coder' },
  score: 42,
  reason: 'Matched coding keywords',
};

describe('buildRoutingResolvedEventData', () => {
  it('自动路由命中 → mode auto，无 requestedAgentId', () => {
    const data = buildRoutingResolvedEventData(autoResolution, { timestamp: 1000 });
    expect(data).toEqual({
      mode: 'auto',
      agentId: 'coder',
      agentName: 'Coder',
      reason: 'Matched coding keywords',
      score: 42,
      fallbackToDefault: false,
      timestamp: 1000,
    });
  });

  it('显式选择命中 → mode explicit，requestedAgentId=实际 agentId', () => {
    const data = buildRoutingResolvedEventData(
      { agent: { id: 'explore', name: 'Explorer' }, score: 1000, reason: 'Explicit agent selected: explore' },
      { requestedAgentId: 'explore', timestamp: 2000 },
    );
    expect(data.mode).toBe('explicit');
    expect(data.agentId).toBe('explore');
    expect(data.requestedAgentId).toBe('explore');
    expect(data.fallbackToDefault).toBe(false);
  });

  it('显式解析失败 + 自动路由兜底命中 → mode auto 但保留 requestedAgentId（降级可判定）', () => {
    const data = buildRoutingResolvedEventData(autoResolution, {
      requestedAgentId: '__ghost__',
      timestamp: 3000,
    });
    expect(data.mode).toBe('auto');
    expect(data.agentId).toBe('coder');
    expect(data.requestedAgentId).toBe('__ghost__');
    expect(data.fallbackToDefault).toBe(false);
  });

  it('显式解析失败 + 无自动路由（web 生产路径）→ mode explicit + default + fallbackToDefault', () => {
    const data = buildRoutingResolvedEventData(null, {
      requestedAgentId: '__ghost__',
      timestamp: 4000,
    });
    expect(data.mode).toBe('explicit');
    expect(data.agentId).toBe('default');
    expect(data.agentName).toBe('default');
    expect(data.requestedAgentId).toBe('__ghost__');
    expect(data.fallbackToDefault).toBe(true);
    expect(data.reason).toContain('__ghost__');
  });

  it('外部引擎兜底：fallbackAgentName/fallbackReason 可覆写（agent 选择在引擎会话不适用）', () => {
    const data = buildRoutingResolvedEventData(null, {
      requestedAgentId: 'explore',
      timestamp: 6000,
      fallbackAgentName: 'codex_cli',
      fallbackReason: 'External engine session (codex_cli) does not support agent selection.',
    });
    expect(data.mode).toBe('explicit');
    expect(data.agentId).toBe('default');
    expect(data.agentName).toBe('codex_cli');
    expect(data.reason).toContain('codex_cli');
    expect(data.fallbackToDefault).toBe(true);
    expect(data.requestedAgentId).toBe('explore');
  });

  it('无显式请求 + 未命中 → mode auto + default 兜底（与 orchestrator 既有默认事件对齐）', () => {
    const data = buildRoutingResolvedEventData(null, { timestamp: 5000 });
    expect(data).toEqual({
      mode: 'auto',
      agentId: 'default',
      agentName: 'default',
      reason: 'No specialized agent matched; continue with the default conversation loop.',
      score: 0,
      fallbackToDefault: true,
      timestamp: 5000,
    });
  });
});
