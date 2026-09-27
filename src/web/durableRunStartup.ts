import { STARTUP_TIMEOUTS } from '../shared/constants';

interface DurableRunStartupInput<Assembly, Runtime> {
  capabilityBootstrap: Promise<unknown>;
  /** Recovery must not dispatch into a hidden/unhydrated desktop window. */
  windowReady?: Promise<unknown>;
  assemble(): Assembly;
  recover(assembly: Assembly): Promise<Runtime>;
  onAssemblyReady(assembly: Assembly): void;
  onRecoveryComplete(runtime: Runtime): void;
  onAssemblyError(error: unknown): void;
  onRecoveryError(error: unknown): void;
}

function waitForWindowReady(windowReady: Promise<unknown> | undefined): Promise<unknown> {
  if (!windowReady) return Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, STARTUP_TIMEOUTS.RENDERER_WINDOW_READY);
    timer.unref?.();
  });
  return Promise.race([windowReady, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Opens the acceptance path after local assembly, while keeping recovery behind
 * capability bootstrap because replayed runs may need remote MCP tools.
 */
export function startDurableRunStartup<Assembly, Runtime>(
  input: DurableRunStartupInput<Assembly, Runtime>,
): void {
  let assembly: Assembly;
  try {
    assembly = input.assemble();
    input.onAssemblyReady(assembly);
  } catch (error) {
    input.onAssemblyError(error);
    return;
  }

  void Promise.all([
    input.capabilityBootstrap,
    waitForWindowReady(input.windowReady),
  ])
    .then(() => input.recover(assembly))
    .then(input.onRecoveryComplete)
    .catch(input.onRecoveryError);
}
