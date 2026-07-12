import type { DurableRunRepository } from '../services/core/repositories/DurableRunRepository';
import type { DynamicWorkflowRecoveryHost } from '../runtime/dynamicWorkflowRecovery';
import type { ExternalResumeRunners } from '../runtime/durableRecoveryHandlers';
import type { MCPClient } from '../mcp/mcpClient';
import {
  createDurableRecoveryRuntime,
  type DurableRecoveryHandlerOverrides,
  type DurableRecoveryRuntime,
} from '../runtime/durableRecoveryRuntime';
import { DurableRunKernel } from '../runtime/durableRunKernel';
import type { RunRegistry } from '../runtime/runRegistry';
import {
  resolveDurableRunRollout,
  type DurableRunRolloutPolicy,
} from './durableRunRollout';

export class DurableRunRolloutInitializationError extends Error {
  readonly code = 'DURABLE_RUN_ROLLOUT_INITIALIZATION_FAILED';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DurableRunRolloutInitializationError';
  }
}

export interface DurableRunApplicationRuntime {
  policy: DurableRunRolloutPolicy;
  kernel: DurableRunKernel | null;
  recoveryRuntime: DurableRecoveryRuntime | null;
  recoveryResults: Awaited<ReturnType<DurableRecoveryRuntime['recoverAndDispatch']>>;
  shutdown(): Promise<void>;
}

/** Shared Web/Tauri Durable rollout wiring and the acceptance bootstrap. */
export async function initializeDurableRun(input: {
  registry: RunRegistry;
  repository: DurableRunRepository | null;
  dataDir: string;
  ownerId: string;
  processInstanceId: string;
  env?: NodeJS.ProcessEnv;
  leaseDurationMs?: number;
  now?: number;
  dynamicWorkflowHost?: DynamicWorkflowRecoveryHost;
  externalRunners?: ExternalResumeRunners;
  getMcpClient?: () => MCPClient;
  trustedMcpServerIdentities?: ReadonlySet<string>;
  /** Used only by the child-process acceptance entry point. */
  recoveryHandlerOverrides?: DurableRecoveryHandlerOverrides
    | ((kernel: DurableRunKernel) => DurableRecoveryHandlerOverrides);
  onDelayedResults?: (results: DurableRunApplicationRuntime['recoveryResults']) => void;
  onDelayedError?: (error: unknown) => void;
}): Promise<DurableRunApplicationRuntime> {
  const policy = resolveDurableRunRollout(input.env);
  if (!policy.durableActivation) {
    return {
      policy,
      kernel: null,
      recoveryRuntime: null,
      recoveryResults: [],
      shutdown: async () => undefined,
    };
  }
  if (!input.repository) {
    throw new DurableRunRolloutInitializationError(
      `${policy.mode} requires initialized Durable Run migration and repository`,
    );
  }

  const leaseDurationMs = input.leaseDurationMs ?? 15_000;
  try {
    const kernel = new DurableRunKernel({
      stores: input.repository,
      ownerId: input.ownerId,
      processInstanceId: input.processInstanceId,
      leaseDurationMs,
    });
    input.registry.configureDurableKernel(kernel);
    const handlerOverrides = typeof input.recoveryHandlerOverrides === 'function'
      ? input.recoveryHandlerOverrides(kernel)
      : input.recoveryHandlerOverrides;
    const recoveryRuntime = createDurableRecoveryRuntime({
      registry: input.registry,
      kernel,
      dataDir: input.dataDir,
      dynamicWorkflowHost: input.dynamicWorkflowHost,
      externalRunners: input.externalRunners,
      getMcpClient: input.getMcpClient,
      trustedMcpServerIdentities: input.trustedMcpServerIdentities,
      handlerOverrides,
    });
    const recoveryResults = await recoveryRuntime.recoverAndDispatch(input.now ?? Date.now());
    recoveryRuntime.scheduleDelayedScan(leaseDurationMs + 100, {
      onResults: input.onDelayedResults,
      onError: input.onDelayedError,
    });
    return {
      policy,
      kernel,
      recoveryRuntime,
      recoveryResults,
      shutdown: () => recoveryRuntime.shutdown(),
    };
  } catch (error) {
    if (error instanceof DurableRunRolloutInitializationError) throw error;
    throw new DurableRunRolloutInitializationError(
      `Failed to initialize ${policy.mode} Durable Run runtime`,
      { cause: error },
    );
  }
}
