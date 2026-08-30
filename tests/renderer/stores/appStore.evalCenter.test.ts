import { beforeEach, describe, expect, it } from 'vitest';
import { useEvalCenterStore } from '@internal-evaluation/renderer/stores/evalCenterStore';

describe('internal evaluation center store', () => {
  beforeEach(() => {
    useEvalCenterStore.setState({ tab: 'replay', replaySessionId: null });
  });

  it('defaults to replay and supports tab changes', () => {
    expect(useEvalCenterStore.getState().tab).toBe('replay');
    useEvalCenterStore.getState().setTab('validation');
    expect(useEvalCenterStore.getState().tab).toBe('validation');
  });

  it('opens and clears a replay deep link inside the package', () => {
    useEvalCenterStore.getState().openReplay('session-1');
    expect(useEvalCenterStore.getState()).toMatchObject({ tab: 'replay', replaySessionId: 'session-1' });
    useEvalCenterStore.getState().clearReplayTarget();
    expect(useEvalCenterStore.getState().replaySessionId).toBeNull();
  });
});
