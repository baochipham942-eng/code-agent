// @vitest-environment jsdom
// ============================================================================
// routingDegradation —— routing_resolved 降级信号的 renderer 侧处理（S2 显式化）
// ----------------------------------------------------------------------------
// 显式选择的 agent 未生效（requestedAgentId ≠ agentId）时：
// 1) 清除该会话的 activeAgentId（chip 不再谎报「当前 agent: X」）
// 2) 当前会话可见 toast 警示（静默兜底 → 显式降级信号）
// ============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useToastStore } from '../../../src/renderer/hooks/useToast';
import { applyRoutingDegradationSignal } from '../../../src/renderer/utils/routingDegradation';

describe('applyRoutingDegradationSignal', () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({ activeAgentId: null, activeAgentSessionKey: null });
    useSessionStore.setState({ currentSessionId: 'session-a' });
    useToastStore.setState({ toasts: [] });
  });

  it('降级（requested ≠ actual）→ 清除该会话选择 + 当前会话 toast 警示', () => {
    useAppStore.getState().syncActiveAgentForSession('session-a');
    useAppStore.getState().setActiveAgentId('ghost-agent');

    const handled = applyRoutingDegradationSignal('session-a', {
      mode: 'explicit',
      agentId: 'default',
      agentName: 'default',
      reason: 'unavailable',
      score: 0,
      fallbackToDefault: true,
      requestedAgentId: 'ghost-agent',
    });

    expect(handled).toBe(true);
    expect(useAppStore.getState().activeAgentId).toBeNull();
    const toasts = useToastStore.getState().toasts;
    expect(toasts.length).toBe(1);
    expect(toasts[0].type).toBe('warning');
    expect(toasts[0].message).toContain('ghost-agent');
  });

  it('非当前会话的降级 → 不弹 toast，但不误清当前会话选择', () => {
    useAppStore.getState().syncActiveAgentForSession('session-a');
    useAppStore.getState().setActiveAgentId('coder');

    const handled = applyRoutingDegradationSignal('session-b', {
      mode: 'explicit',
      agentId: 'default',
      agentName: 'default',
      reason: 'unavailable',
      score: 0,
      fallbackToDefault: true,
      requestedAgentId: 'ghost-agent',
    });

    expect(handled).toBe(true);
    expect(useAppStore.getState().activeAgentId).toBe('coder');
    expect(useToastStore.getState().toasts.length).toBe(0);
  });

  it('降级会话的存量选择与 requested 不一致（用户已改选）→ 不误清新选择', () => {
    localStorage.setItem('app:activeAgentIdBySession', JSON.stringify({ 'session-b': 'coder' }));

    applyRoutingDegradationSignal('session-b', {
      mode: 'explicit',
      agentId: 'default',
      agentName: 'default',
      reason: 'unavailable',
      score: 0,
      fallbackToDefault: true,
      requestedAgentId: 'ghost-agent',
    });

    const stored = JSON.parse(localStorage.getItem('app:activeAgentIdBySession') || '{}') as Record<string, string>;
    expect(stored['session-b']).toBe('coder');
  });

  it('降级会话的存量选择等于 requested → 清除该会话 map 条目', () => {
    localStorage.setItem('app:activeAgentIdBySession', JSON.stringify({ 'session-b': 'ghost-agent' }));

    applyRoutingDegradationSignal('session-b', {
      mode: 'explicit',
      agentId: 'default',
      agentName: 'default',
      reason: 'unavailable',
      score: 0,
      fallbackToDefault: true,
      requestedAgentId: 'ghost-agent',
    });

    const stored = JSON.parse(localStorage.getItem('app:activeAgentIdBySession') || '{}') as Record<string, string>;
    expect(stored['session-b']).toBeUndefined();
  });

  it('显式命中（requested === actual）→ 不触发降级处理', () => {
    useAppStore.getState().syncActiveAgentForSession('session-a');
    useAppStore.getState().setActiveAgentId('explore');

    const handled = applyRoutingDegradationSignal('session-a', {
      mode: 'explicit',
      agentId: 'explore',
      agentName: 'Explorer',
      reason: 'Explicit agent selected: explore',
      score: 1000,
      fallbackToDefault: false,
      requestedAgentId: 'explore',
    });

    expect(handled).toBe(false);
    expect(useAppStore.getState().activeAgentId).toBe('explore');
    expect(useToastStore.getState().toasts.length).toBe(0);
  });

  it('自动路由（无 requestedAgentId）→ 不触发', () => {
    const handled = applyRoutingDegradationSignal('session-a', {
      mode: 'auto',
      agentId: 'coder',
      agentName: 'Coder',
      reason: 'matched',
      score: 42,
      fallbackToDefault: false,
    });
    expect(handled).toBe(false);
  });
});
