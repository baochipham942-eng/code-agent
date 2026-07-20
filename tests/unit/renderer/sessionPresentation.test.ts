import { describe, expect, it } from 'vitest';
import {
  getSessionStatusPresentation,
  matchesSessionStatusFilter,
} from '../../../src/renderer/utils/sessionPresentation';

describe('getSessionStatusPresentation', () => {
  describe('P1: live in-memory signals win first', () => {
    it('taskState error → error (even if DB says completed)', () => {
      expect(
        getSessionStatusPresentation({
          taskState: { status: 'error' } as any,
          sessionStatus: 'completed',
          messageCount: 5,
        }).kind,
      ).toBe('error');
    });

    it('backgroundTask running → background (even if DB says idle)', () => {
      expect(
        getSessionStatusPresentation({
          backgroundSession: { status: 'running' } as any,
          sessionStatus: 'idle',
        }).kind,
      ).toBe('background');
    });

    it('runtime paused → paused', () => {
      expect(
        getSessionStatusPresentation({
          runtime: { status: 'paused' } as any,
        }).kind,
      ).toBe('paused');
    });

    it('taskState running → live', () => {
      expect(
        getSessionStatusPresentation({
          taskState: { status: 'running' } as any,
        }).kind,
      ).toBe('live');
    });

    it('runtime running → live (even if DB says completed)', () => {
      expect(
        getSessionStatusPresentation({
          runtime: { status: 'running' } as any,
          sessionStatus: 'completed',
        }).kind,
      ).toBe('live');
    });
  });

  describe('P2: persisted DB status survives restart', () => {
    it('DB status running + no in-memory runtime → live (zombie / resumed)', () => {
      expect(
        getSessionStatusPresentation({
          sessionStatus: 'running',
          messageCount: 3,
        }).kind,
      ).toBe('live');
    });

    it('DB status completed → done without a sidebar badge', () => {
      const status = getSessionStatusPresentation({
        sessionStatus: 'completed',
        messageCount: 12,
      });

      expect(status.kind).toBe('done');
      expect(status.showBadge).toBe(false);
    });

    it('DB status error → error', () => {
      expect(
        getSessionStatusPresentation({
          sessionStatus: 'error',
          messageCount: 2,
        }).kind,
      ).toBe('error');
    });
  });

  describe('P3: messageCount fallback for sessions lacking explicit status', () => {
    it('idle DB status + has messages → done without an action badge', () => {
      const status = getSessionStatusPresentation({
        sessionStatus: 'idle',
        messageCount: 4,
      });

      expect(status.kind).toBe('done');
      expect(status.showBadge).toBe(false);
    });

    it('no sessionStatus + has messages → done without an action badge', () => {
      const status = getSessionStatusPresentation({
        messageCount: 2,
      });

      expect(status.kind).toBe('done');
      expect(status.showBadge).toBe(false);
    });

    it('no messages + no in-memory runtime → idle without an action badge', () => {
      const status = getSessionStatusPresentation({
        messageCount: 0,
      });

      expect(status.kind).toBe('idle');
      expect(status.showBadge).toBe(false);
    });

    it('idle DB status + zero messages → idle without an action badge', () => {
      const status = getSessionStatusPresentation({
        sessionStatus: 'idle',
        messageCount: 0,
      });

      expect(status.kind).toBe('idle');
      expect(status.showBadge).toBe(false);
    });

    it('prompt-only session → incomplete attention badge', () => {
      const status = getSessionStatusPresentation({
        sessionStatus: 'idle',
        messageCount: 1,
        turnCount: 1,
      });

      expect(status.kind).toBe('incomplete');
      expect(status.label).toBe('未完成');
      expect(status.showBadge).toBe(true);
    });

    it('pending approval → approval attention badge', () => {
      const status = getSessionStatusPresentation({
        hasPendingApproval: true,
        sessionStatus: 'running',
        messageCount: 3,
      });

      expect(status.kind).toBe('approval');
      expect(status.label).toBe('待确认');
      expect(status.showBadge).toBe(true);
    });

    it('needs input → approval bucket without changing stored session status', () => {
      const status = getSessionStatusPresentation({
        hasNeedsInput: true,
        sessionStatus: 'running',
        messageCount: 3,
      });

      expect(status.kind).toBe('approval');
      expect(status.label).toBe('待确认');
      expect(matchesSessionStatusFilter('approval', status.kind)).toBe(true);
    });
  });

  describe('regression: restored sessions no longer stuck on idle', () => {
    // Repro: on app restart, runtime/taskState/backgroundTask are all null
    // because they live in-memory. Before this fix, such sessions fell through
    // to 'idle' regardless of messageCount. Now they classify correctly.
    it('restored completed session → done, not idle', () => {
      expect(
        getSessionStatusPresentation({
          // No in-memory state
          backgroundSession: undefined,
          runtime: undefined,
          taskState: null,
          // DB remembers
          sessionStatus: 'completed',
          messageCount: 8,
        }).kind,
      ).toBe('done');
    });

    it('restored session with history but stale idle status → done', () => {
      // Some sessions have messageCount>0 but status='idle' because the status
      // write lagged the message writes. These must not regress to 'idle'.
      expect(
        getSessionStatusPresentation({
          sessionStatus: 'idle',
          messageCount: 5,
        }).kind,
      ).toBe('done');
    });

    it('restored session that was mid-run (DB running, no in-memory) → live', () => {
      expect(
        getSessionStatusPresentation({
          sessionStatus: 'running',
          messageCount: 3,
        }).kind,
      ).toBe('live');
    });
  });
});

describe('matchesSessionStatusFilter', () => {
  it('keeps all sessions in the all filter', () => {
    expect(matchesSessionStatusFilter('all', 'done')).toBe(true);
    expect(matchesSessionStatusFilter('all', 'approval')).toBe(true);
  });

  it('groups actionable sessions under unfinished', () => {
    for (const kind of ['approval', 'background', 'live', 'paused', 'error', 'incomplete'] as const) {
      expect(matchesSessionStatusFilter('unfinished', kind)).toBe(true);
    }

    expect(matchesSessionStatusFilter('unfinished', 'done')).toBe(false);
    expect(matchesSessionStatusFilter('unfinished', 'idle')).toBe(false);
  });

  it('separates approval, running, and attention filters', () => {
    expect(matchesSessionStatusFilter('approval', 'approval')).toBe(true);
    expect(matchesSessionStatusFilter('approval', 'live')).toBe(false);

    expect(matchesSessionStatusFilter('running', 'background')).toBe(true);
    expect(matchesSessionStatusFilter('running', 'live')).toBe(true);
    expect(matchesSessionStatusFilter('running', 'paused')).toBe(false);

    expect(matchesSessionStatusFilter('attention', 'paused')).toBe(true);
    expect(matchesSessionStatusFilter('attention', 'error')).toBe(true);
    expect(matchesSessionStatusFilter('attention', 'incomplete')).toBe(true);
    expect(matchesSessionStatusFilter('attention', 'approval')).toBe(false);
  });

  it('filters pending review sessions from review evidence instead of runtime status', () => {
    expect(matchesSessionStatusFilter('review', 'done', { hasPendingReview: true })).toBe(true);
    expect(matchesSessionStatusFilter('review', 'approval', { hasPendingReview: true })).toBe(true);
    expect(matchesSessionStatusFilter('review', 'approval', { hasPendingReview: false })).toBe(false);
    expect(matchesSessionStatusFilter('review', 'done')).toBe(false);
  });

  it('filters delivery-signal sessions from recovery evidence instead of runtime status', () => {
    expect(matchesSessionStatusFilter('artifact', 'done', { hasDeliverySignals: true })).toBe(true);
    expect(matchesSessionStatusFilter('artifact', 'approval', { hasDeliverySignals: true })).toBe(true);
    expect(matchesSessionStatusFilter('artifact', 'approval', { hasDeliverySignals: false })).toBe(false);
    expect(matchesSessionStatusFilter('artifact', 'done')).toBe(false);
  });
});
