import path from 'node:path';
import { getMCPClient, type MCPClient } from '../mcp/mcpClient';
import { McpTaskResultFileStore } from '../mcp/mcpTaskResultFileStore';
import type { RunKernelAdapter } from './durableRunKernel';
import {
  DurableRecoveryDispatcher,
  type DurableRecoveryDispatchResult,
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

export interface DurableRecoveryRuntime {
  readonly dispatcher: DurableRecoveryDispatcher;
  recoverAndDispatch(now?: number): Promise<DurableRecoveryDispatchResult[]>;
  scheduleDelayedScan(delayMs: number, callbacks?: {
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
}): DurableRecoveryRuntime {
  const dispatcher = new DurableRecoveryDispatcher();
  dispatcher.registerEngineHandler(createNativeRecoveryHandler());
  dispatcher.registerEngineHandler(createAgentTeamRecoveryHandler());
  dispatcher.registerEngineHandler(createExternalEngineRecoveryHandler({
    registry: input.registry,
    runners: input.externalRunners,
  }));
  dispatcher.registerEngineHandler(createDynamicWorkflowRecoveryHandler());
  dispatcher.registerOperationHandler(createMcpOperationRecoveryHandler({
    kernel: input.kernel,
    resultStore: new McpTaskResultFileStore(path.join(input.dataDir, 'mcp-task-results')),
    getClient: input.getMcpClient ?? getMCPClient,
    trustedServerIdentities: input.trustedMcpServerIdentities ?? readTrustedMcpServerIdentities(),
  }));

  let delayedTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  return {
    dispatcher,
    async recoverAndDispatch(now = Date.now()) {
      if (stopped) throw new Error('Durable recovery runtime is stopped');
      const plans = await input.registry.recoverDurable(now);
      return dispatcher.dispatch(plans, now);
    },
    scheduleDelayedScan(delayMs, callbacks = {}) {
      if (stopped) throw new Error('Durable recovery runtime is stopped');
      if (delayedTimer) clearTimeout(delayedTimer);
      delayedTimer = setTimeout(() => {
        delayedTimer = undefined;
        void this.recoverAndDispatch(Date.now())
          .then((results) => callbacks.onResults?.(results))
          .catch((error) => callbacks.onError?.(error));
      }, delayMs);
      delayedTimer.unref?.();
    },
    async shutdown() {
      if (stopped) return;
      stopped = true;
      if (delayedTimer) clearTimeout(delayedTimer);
      delayedTimer = undefined;
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
