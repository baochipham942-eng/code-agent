import { describe, expect, it } from 'vitest';
import { getSessionStatusPresentation } from '../../../src/renderer/utils/sessionPresentation';

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
          backgroundTask: { status: 'running' } as any,
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

    it('DB status completed → done', () => {
      expect(
        getSessionStatusPresentation({
          sessionStatus: 'completed',
          messageCount: 12,
        }).kind,
      ).toBe('done');
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
    it('idle DB status + has messages → done (history implies prior completion)', () => {
      expect(
        getSessionStatusPresentation({
          sessionStatus: 'idle',
          messageCount: 4,
        }).kind,
      ).toBe('done');
    });

    it('no sessionStatus + has messages → done', () => {
      expect(
        getSessionStatusPresentation({
          messageCount: 2,
        }).kind,
      ).toBe('done');
    });

    it('no messages + no in-memory runtime → idle (truly fresh session)', () => {
      expect(
        getSessionStatusPresentation({
          messageCount: 0,
        }).kind,
      ).toBe('idle');
    });

    it('idle DB status + zero messages → idle', () => {
      expect(
        getSessionStatusPresentation({
          sessionStatus: 'idle',
          messageCount: 0,
        }).kind,
      ).toBe('idle');
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
          backgroundTask: undefined,
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
