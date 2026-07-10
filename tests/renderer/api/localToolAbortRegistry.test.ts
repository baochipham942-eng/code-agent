import { describe, expect, it, vi } from 'vitest';
import { LocalToolAbortRegistry } from '../../../src/renderer/api/localToolAbortRegistry';

describe('LocalToolAbortRegistry', () => {
  it('aborts only Bridge requests owned by the disconnected run', () => {
    const registry = new LocalToolAbortRegistry();
    const runAFirst = new AbortController();
    const runASecond = new AbortController();
    const runB = new AbortController();
    const runBAbort = vi.fn();
    runB.signal.addEventListener('abort', runBAbort);
    registry.register('tool-a-1', 'run-a', runAFirst);
    registry.register('tool-a-2', 'run-a', runASecond);
    registry.register('tool-b-1', 'run-b', runB);

    registry.abortRun('run-a');

    expect(runAFirst.signal.aborted).toBe(true);
    expect(runASecond.signal.aborted).toBe(true);
    expect(runB.signal.aborted).toBe(false);
    expect(runBAbort).not.toHaveBeenCalled();

    registry.abortCall('tool-b-1');
    expect(runB.signal.aborted).toBe(true);
  });
});
