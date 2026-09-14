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
import { armBackgroundSubagentDurableLedger } from '../agent/backgroundSubagentDurableLedger';

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

interface DurableRunAssemblyInput {
  registry: RunRegistry;
  repository: DurableRunRepository | null;
  ownerId: string;
  processInstanceId: string;
  env?: NodeJS.ProcessEnv;
  leaseDurationMs?: number;
}

interface DurableRunRecoveryInput {
  dataDir: string;
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
}

interface DurableRunApplicationAssembly {
  policy: DurableRunRolloutPolicy;
  kernel: DurableRunKernel | null;
  readService: DurableRunReadService;
  recover(input: DurableRunRecoveryInput): Promise<DurableRunApplicationRuntime>;
}

/**
 * Installs the Durable kernel into the registry. Once this returns, new runs can be
 * accepted; interrupted-run recovery is deliberately deferred to recover().
 */
export function assembleDurableRun(
  input: DurableRunAssemblyInput,
): DurableRunApplicationAssembly {
  const policy = resolveDurableRunRollout(input.env);
  const readService = new DurableRunReadService(policy, input.repository);
  if (!policy.durableActivation) {
    return {
      policy,
      kernel: null,
      readService,
      recover: async () => ({
        policy,
        kernel: null,
        recoveryRuntime: null,
        readService,
        recoveryResults: [],
        shutdown: async () => undefined,
      }),
    };
  }
  // durable 激活分支才 arm；legacy 分支永不 arm，spawn 行为与改造前一致。
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
    // ai-review 修复（2026-09-14）：arm 只许在 kernel 配置成功之后。assemble 全程同步，
    // 先 arm 并没有可守的窗口；而一旦 kernel/configureDurableKernel 抛错（调用方记日志
    // 走 legacy/retry），残留的 armed 会让后续后台 spawn 死等一个永远不会 configure 的
    // 账本（waitFor 30s 超时后失败），尽管此时进程实为 legacy 纯内存、任务本可以跑。
    // armed 的终态只能是「configure 成功」或「从未 arm（legacy 纯内存）」，不许停在中间。
    armBackgroundSubagentDurableLedger();
    return {
      policy,
      kernel,
      readService,
      recover: async (recoveryInput) => {
        try {
          const handlerOverrides = typeof recoveryInput.recoveryHandlerOverrides === 'function'
            ? recoveryInput.recoveryHandlerOverrides(kernel)
            : recoveryInput.recoveryHandlerOverrides;
          const recoveryRuntime = createDurableRecoveryRuntime({
            registry: input.registry,
            kernel,
            dataDir: recoveryInput.dataDir,
            dynamicWorkflowHost: recoveryInput.dynamicWorkflowHost,
            nativeRecoveryPorts: recoveryInput.nativeRecoveryPorts,
            autoAgentRecoveryHost: recoveryInput.autoAgentRecoveryHost,
            externalRunners: recoveryInput.externalRunners,
            getMcpClient: recoveryInput.getMcpClient,
            trustedMcpServerIdentities: recoveryInput.trustedMcpServerIdentities,
            handlerOverrides,
          });
          const recoveryResults = await recoveryRuntime.recoverAndDispatch(
            recoveryInput.now ?? Date.now(),
          );
          recoveryRuntime.startSweeper(Math.max(
            1,
            Math.floor(leaseDurationMs / DURABLE_RECOVERY_SWEEP_INTERVAL_DIVISOR),
          ), {
            onResults: recoveryInput.onSweepResults,
            onError: recoveryInput.onSweepError,
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
          throw new DurableRunRolloutInitializationError(
            `Failed to recover ${policy.mode} Durable Run runtime`,
            { cause: error },
          );
        }
      },
    };
  } catch (error) {
    if (error instanceof DurableRunRolloutInitializationError) throw error;
    throw new DurableRunRolloutInitializationError(
      `Failed to initialize ${policy.mode} Durable Run runtime`,
      { cause: error },
    );
  }
}

/** Shared Web/Tauri Durable rollout wiring and the acceptance bootstrap. */
export async function initializeDurableRun(
  input: DurableRunAssemblyInput & DurableRunRecoveryInput,
): Promise<DurableRunApplicationRuntime> {
  const assembly = assembleDurableRun(input);
  return assembly.recover(input);
}
