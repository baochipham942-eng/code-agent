import path from 'node:path';
import { getMCPClient, type MCPClient } from '../mcp/mcpClient';
import { McpTaskResultFileStore } from '../mcp/mcpTaskResultFileStore';
import type { RunKernelAdapter } from './durableRunKernel';
import {
  DurableRecoveryDispatcher,
  type DurableRecoveryDispatchResult,
  type DurableEngineRecoveryHandler,
  type DurableOperationRecoveryHandler,
} from './durableRecoveryDispatcher';
import {
  createAgentTeamRecoveryHandler,
  createDynamicWorkflowRecoveryHandler,
  createExternalEngineRecoveryHandler,
  createMcpOperationRecoveryHandler,
  createNativeRecoveryHandler,
  type ExternalResumeRunners,
} from './durableRecoveryHandlers';
import type { RunRegistry } from './runRegistry';
import type { DynamicWorkflowRecoveryHost } from './dynamicWorkflowRecovery';
import type { NativeRecoveryHostPorts } from './nativeRecoveryHost';
import type { AutoAgentRecoveryHost } from './autoAgentRecoveryHost';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('DurableRecoveryRuntime');
export interface DurableRecoveryHandlerOverrides {
  native?: DurableEngineRecoveryHandler;
  agentTeam?: DurableEngineRecoveryHandler;
  externalEngine?: DurableEngineRecoveryHandler;
  dynamicWorkflow?: DurableEngineRecoveryHandler;
  mcpOperation?: DurableOperationRecoveryHandler;
}

export interface DurableRecoveryRuntime {
  readonly dispatcher: DurableRecoveryDispatcher;
  recoverAndDispatch(now?: number): Promise<DurableRecoveryDispatchResult[]>;
  startSweeper(intervalMs: number, callbacks?: {
    onResults?: (results: DurableRecoveryDispatchResult[]) => void;
    onError?: (error: unknown) => void;
  }): void;
  shutdown(): Promise<void>;
}

export function createDurableRecoveryRuntime(input: {
  registry: RunRegistry;
  kernel: RunKernelAdapter;
  dataDir: string;
  getMcpClient?: () => MCPClient;
  trustedMcpServerIdentities?: ReadonlySet<string>;
  externalRunners?: ExternalResumeRunners;
  dynamicWorkflowHost?: DynamicWorkflowRecoveryHost;
  nativeRecoveryPorts?: NativeRecoveryHostPorts;
  autoAgentRecoveryHost?: AutoAgentRecoveryHost;
  /** Acceptance-only injection boundary; production bootstraps never set it. */
  handlerOverrides?: DurableRecoveryHandlerOverrides;
}): DurableRecoveryRuntime {
  const dispatcher = new DurableRecoveryDispatcher();
  dispatcher.registerEngineHandler(input.handlerOverrides?.native ?? createNativeRecoveryHandler({
    registry: input.registry,
    ports: input.nativeRecoveryPorts,
  }));
  dispatcher.registerEngineHandler(input.handlerOverrides?.agentTeam ?? createAgentTeamRecoveryHandler({
    registry: input.registry,
    autoAgentHost: input.autoAgentRecoveryHost,
  }));
  dispatcher.registerEngineHandler(input.handlerOverrides?.externalEngine ?? createExternalEngineRecoveryHandler({
    registry: input.registry,
    runners: input.externalRunners,
  }));
  dispatcher.registerEngineHandler(input.handlerOverrides?.dynamicWorkflow ?? createDynamicWorkflowRecoveryHandler({
    registry: input.registry,
    host: input.dynamicWorkflowHost,
  }));
  dispatcher.registerOperationHandler(input.handlerOverrides?.mcpOperation ?? createMcpOperationRecoveryHandler({
    kernel: input.kernel,
    resultStore: new McpTaskResultFileStore(path.join(input.dataDir, 'mcp-task-results')),
    getClient: input.getMcpClient ?? getMCPClient,
    trustedServerIdentities: input.trustedMcpServerIdentities ?? readTrustedMcpServerIdentities(),
  }));

  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let activeSweep: Promise<void> | undefined;
  let stopped = false;
  const recoverAndDispatch = async (now = Date.now()) => {
    if (stopped) throw new Error('Durable recovery runtime is stopped');
    // The sweeper stays on the canonical claim path:
    // recoverDurable -> recoverOnStartup -> stores.listRecoverable -> fenced claimLease.
    const plans = await input.registry.recoverDurable(now);
    return dispatcher.dispatch(plans, now);
  };
  return {
    dispatcher,
    recoverAndDispatch,
    startSweeper(intervalMs, callbacks = {}) {
      if (stopped) throw new Error('Durable recovery runtime is stopped');
      if (sweepTimer) clearInterval(sweepTimer);
      const tick = () => {
        if (stopped || activeSweep) return;
        activeSweep = recoverAndDispatch(Date.now())
          .then((results) => {
            for (const runId of new Set(results.map((result) => result.runId))) {
              logger.info(`[durable-sweeper] reclaimed runId=${runId}`);
            }
            callbacks.onResults?.(results);
          })
          .catch((error) => callbacks.onError?.(error))
          .finally(() => {
            activeSweep = undefined;
          });
      };
      sweepTimer = setInterval(tick, intervalMs);
      sweepTimer.unref?.();
    },
    async shutdown() {
      if (stopped) return;
      stopped = true;
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = undefined;
      await activeSweep;
      await dispatcher.shutdown();
    },
  };
}

function readTrustedMcpServerIdentities(): ReadonlySet<string> {
  return new Set((process.env.CODE_AGENT_MCP_DURABLE_TRUSTED_SERVER_IDENTITIES ?? '')
    .split(',')
    .map((identity) => identity.trim())
    .filter(Boolean));
}
