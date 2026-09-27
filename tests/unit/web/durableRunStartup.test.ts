import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveDurableRunRollout } from '../../../src/host/app/durableRunRollout';
import { startDurableRunStartup } from '../../../src/web/durableRunStartup';
import { isDurableRunGateOpen } from '../../../src/web/routes/agentDurableRouteLifecycle';
import { STARTUP_TIMEOUTS } from '../../../src/shared/constants';

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

  it('does not start recovery until the renderer window is ready', async () => {
    let releaseWindow!: () => void;
    const windowReady = new Promise<void>((resolve) => {
      releaseWindow = resolve;
    });
    const recover = vi.fn(async () => 'recovered');

    startDurableRunStartup({
      capabilityBootstrap: Promise.resolve(),
      windowReady,
      assemble: () => 'assembled',
      recover,
      onAssemblyReady: vi.fn(),
      onRecoveryComplete: vi.fn(),
      onAssemblyError: vi.fn(),
      onRecoveryError: vi.fn(),
    });

    await Promise.resolve();
    expect(recover).not.toHaveBeenCalled();

    releaseWindow();
    await vi.waitFor(() => expect(recover).toHaveBeenCalledWith('assembled'));
  });

  it('releases recovery after the renderer-ready signal timeout', async () => {
    vi.useFakeTimers();
    const recover = vi.fn(async () => 'recovered');

    startDurableRunStartup({
      capabilityBootstrap: Promise.resolve(),
      windowReady: new Promise<void>(() => {}),
      assemble: () => 'assembled',
      recover,
      onAssemblyReady: vi.fn(),
      onRecoveryComplete: vi.fn(),
      onAssemblyError: vi.fn(),
      onRecoveryError: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUTS.RENDERER_WINDOW_READY);
    await vi.waitFor(() => expect(recover).toHaveBeenCalledWith('assembled'));
  });
});
