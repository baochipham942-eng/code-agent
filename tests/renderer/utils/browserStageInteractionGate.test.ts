import { describe, expect, it } from 'vitest';
import {
  resolveBrowserStageInteractionGate,
  shouldDispatchBrowserStageInteraction,
} from '../../../src/renderer/utils/browserStageInteractionGate';

describe('browserStageInteractionGate', () => {
  const base = {
    ownedByCurrentSession: true,
    annotateMode: false,
    ready: true,
    agentSurfaceBusy: false,
    interactionPreempted: false,
  };

  it('用户 run / 空闲直接允许透传', () => {
    expect(resolveBrowserStageInteractionGate(base)).toBe('allowed');
    expect(shouldDispatchBrowserStageInteraction('allowed')).toBe(true);
  });

  it('agent 忙且未确认 → 需要抢占确认', () => {
    const reason = resolveBrowserStageInteractionGate({
      ...base,
      agentSurfaceBusy: true,
    });
    expect(reason).toBe('needs-preempt-confirm');
    expect(shouldDispatchBrowserStageInteraction(reason)).toBe(false);
  });

  it('agent 忙但已确认 → 透传', () => {
    const reason = resolveBrowserStageInteractionGate({
      ...base,
      agentSurfaceBusy: true,
      interactionPreempted: true,
    });
    expect(reason).toBe('preempt-confirmed');
    expect(shouldDispatchBrowserStageInteraction(reason)).toBe(true);
  });

  it('外会话禁止透传', () => {
    expect(resolveBrowserStageInteractionGate({
      ...base,
      ownedByCurrentSession: false,
    })).toBe('foreign-session');
  });

  it('批注模式互斥：点击归批注，不透传', () => {
    expect(resolveBrowserStageInteractionGate({
      ...base,
      annotateMode: true,
    })).toBe('annotate-mode');
  });

  it('无画面/未就绪不透传', () => {
    expect(resolveBrowserStageInteractionGate({
      ...base,
      ready: false,
    })).toBe('not-ready');
  });
});
