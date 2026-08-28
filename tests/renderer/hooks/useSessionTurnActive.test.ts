// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSessionTurnActive } from '../../../src/renderer/hooks/useSessionTurnActive';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';

const SESSION_ID = 'shared-truth-session';

function resetRuntimeTruth(): void {
  useAppStore.setState({ processingSessionIds: new Set() });
  useSessionStore.setState({ runningSessionIds: new Set() });
  useTaskStore.setState({ sessionStates: {} });
}

describe('useSessionTurnActive — shared terminal truth', () => {
  beforeEach(resetRuntimeTruth);
  afterEach(() => {
    cleanup();
    resetRuntimeTruth();
  });

  it('keeps the turn active while any canonical runtime source is active', () => {
    useAppStore.setState({ processingSessionIds: new Set([SESSION_ID]) });
    expect(renderHook(() => useSessionTurnActive(SESSION_ID)).result.current).toBe(true);

    resetRuntimeTruth();
    useSessionStore.setState({ runningSessionIds: new Set([SESSION_ID]) });
    expect(renderHook(() => useSessionTurnActive(SESSION_ID)).result.current).toBe(true);

    resetRuntimeTruth();
    useTaskStore.setState({ sessionStates: { [SESSION_ID]: { status: 'queued' } } });
    expect(renderHook(() => useSessionTurnActive(SESSION_ID)).result.current).toBe(true);
  });

  it('settles only after all canonical runtime sources have settled', () => {
    useTaskStore.setState({ sessionStates: { [SESSION_ID]: { status: 'idle' } } });
    expect(renderHook(() => useSessionTurnActive(SESSION_ID)).result.current).toBe(false);

    resetRuntimeTruth();
    expect(renderHook(() => useSessionTurnActive(SESSION_ID)).result.current).toBe(false);
  });
});
