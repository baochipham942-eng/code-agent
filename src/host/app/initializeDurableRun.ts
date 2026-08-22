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
import type { NativeRecoveryHostPorts } from '../runtime/nativeRecoveryHost';
import type { AutoAgentRecoveryHost } from '../runtime/autoAgentRecoveryHost';
import {
  resolveDurableRunRollout,
  type DurableRunRolloutPolicy,
} from './durableRunRollout';
import { DurableRunReadService } from './durableRunReadService';

export class DurableRunRolloutInitializationError extends Error {
  readonly code = 'DURABLE_RUN_ROLLOUT_INITIALIZATION_FAILED';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DurableRunRolloutInitializationError';
  }
}

const DEFAULT_DURABLE_RUN_LEASE_DURATION_MS = 15_000;
const DURABLE_RECOVERY_SWEEP_INTERVAL_DIVISOR = 2;

export interface DurableRunApplicationRuntime {
  policy: DurableRunRolloutPolicy;
  kernel: DurableRunKernel | null;
  recoveryRuntime: DurableRecoveryRuntime | null;
  readService: DurableRunReadService;
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
  nativeRecoveryPorts?: NativeRecoveryHostPorts;
  autoAgentRecoveryHost?: AutoAgentRecoveryHost;
  externalRunners?: ExternalResumeRunners;
  getMcpClient?: () => MCPClient;
  trustedMcpServerIdentities?: ReadonlySet<string>;
  /** Used only by the child-process acceptance entry point. */
  recoveryHandlerOverrides?: DurableRecoveryHandlerOverrides
    | ((kernel: DurableRunKernel) => DurableRecoveryHandlerOverrides);
  onSweepResults?: (results: DurableRunApplicationRuntime['recoveryResults']) => void;
  onSweepError?: (error: unknown) => void;
}): Promise<DurableRunApplicationRuntime> {
  const policy = resolveDurableRunRollout(input.env);
  const readService = new DurableRunReadService(policy, input.repository);
  if (!policy.durableActivation) {
    return {
      policy,
      kernel: null,
      recoveryRuntime: null,
      readService,
      recoveryResults: [],
      shutdown: async () => undefined,
    };
  }
  if (!input.repository) {
    throw new DurableRunRolloutInitializationError(
      `${policy.mode} requires initialized Durable Run migration and repository`,
    );
  }

  const leaseDurationMs = input.leaseDurationMs ?? DEFAULT_DURABLE_RUN_LEASE_DURATION_MS;
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
      nativeRecoveryPorts: input.nativeRecoveryPorts,
      autoAgentRecoveryHost: input.autoAgentRecoveryHost,
      externalRunners: input.externalRunners,
      getMcpClient: input.getMcpClient,
      trustedMcpServerIdentities: input.trustedMcpServerIdentities,
      handlerOverrides,
    });
    const recoveryResults = await recoveryRuntime.recoverAndDispatch(input.now ?? Date.now());
    recoveryRuntime.startSweeper(Math.max(
      1,
      Math.floor(leaseDurationMs / DURABLE_RECOVERY_SWEEP_INTERVAL_DIVISOR),
    ), {
      onResults: input.onSweepResults,
      onError: input.onSweepError,
    });
    return {
      policy,
      kernel,
      recoveryRuntime,
      readService,
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
