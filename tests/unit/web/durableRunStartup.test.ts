import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveDurableRunRollout } from '../../../src/host/app/durableRunRollout';
import { startDurableRunStartup } from '../../../src/web/durableRunStartup';
import { isDurableRunGateOpen } from '../../../src/web/routes/agentDurableRouteLifecycle';

afterEach(() => {
  vi.useRealTimers();
});

describe('startDurableRunStartup', () => {
  it('opens the run gate after assembly without waiting five seconds for capabilities', async () => {
    vi.useFakeTimers();
    let ready = false;
    const recover = vi.fn(async () => 'recovered');
    const capabilityBootstrap = new Promise<void>((resolve) => {
      setTimeout(resolve, 5_000);
    });

    startDurableRunStartup({
      capabilityBootstrap,
      assemble: () => 'assembled',
      recover,
      onAssemblyReady: () => { ready = true; },
      onRecoveryComplete: vi.fn(),
      onAssemblyError: vi.fn(),
      onRecoveryError: vi.fn(),
    });

    expect(isDurableRunGateOpen({
      policy: resolveDurableRunRollout({}),
      ready,
    })).toBe(true);
    expect(recover).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(recover).toHaveBeenCalledWith('assembled');
  });

  it('keeps an assembled service ready when recovery fails', async () => {
    let ready = false;
    const onRecoveryError = vi.fn();

    startDurableRunStartup({
      capabilityBootstrap: Promise.resolve(),
      assemble: () => 'assembled',
      recover: async () => { throw new Error('recovery failed'); },
      onAssemblyReady: () => { ready = true; },
      onRecoveryComplete: vi.fn(),
      onAssemblyError: () => { ready = false; },
      onRecoveryError,
    });

    await vi.waitFor(() => expect(onRecoveryError).toHaveBeenCalledOnce());
    expect(ready).toBe(true);
  });
});
