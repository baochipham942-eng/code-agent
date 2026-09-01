interface DurableRunStartupInput<Assembly, Runtime> {
  capabilityBootstrap: Promise<unknown>;
  assemble(): Assembly;
  recover(assembly: Assembly): Promise<Runtime>;
  onAssemblyReady(assembly: Assembly): void;
  onRecoveryComplete(runtime: Runtime): void;
  onAssemblyError(error: unknown): void;
  onRecoveryError(error: unknown): void;
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

  void input.capabilityBootstrap
    .then(() => input.recover(assembly))
    .then(input.onRecoveryComplete)
    .catch(input.onRecoveryError);
}
