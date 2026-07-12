import type { ModelConfig } from '../../shared/contract';
import type { ScriptRunHostDeps, ScriptRunJournal } from '../agent/scriptRuntime';
import type { SubagentExecutionContext } from '../agent/subagentExecutorTypes';
import { GraphEventCompatibilityAdapter } from '../orchestration';
import { resolveToolProfile } from '../agent/scriptRuntime/toolProfiles';
import { getWorkflowJournalRepository } from '../services/core/repositories/WorkflowJournalRepository';
import { getSessionManager } from '../services';
import { resolveSessionDefaultModelConfig } from '../services/core/sessionDefaults';
import { getEventBus } from '../services/eventing/bus';
import { getToolResolver } from '../tools/dispatch/toolResolver';
import { fingerprintRunWorkspace } from '../telemetry/runTraceContext';
import { isRunPathInsideWorkspace, resolveCanonicalRunPath } from '../runtime/runContext';
import type { RunRegistry } from '../runtime/runRegistry';
import type {
  DynamicWorkflowDurableState,
  DynamicWorkflowRecoveryHost,
} from '../runtime/dynamicWorkflowRecovery';

export function createApplicationDynamicWorkflowRecoveryHost(input: {
  registry: RunRegistry;
}): DynamicWorkflowRecoveryHost {
  const compatibility = new GraphEventCompatibilityAdapter({
    agent: (event) => getEventBus().publish('agent', event.type, event, { bridgeToRenderer: false }),
    script: (event) => getEventBus().publish('workflow', event.type, event, {
      sessionId: event.sessionId,
      bridgeToRenderer: false,
    }),
    session: (event) => getEventBus().publish('session', event.eventType, event, {
      sessionId: event.sessionId,
      bridgeToRenderer: false,
    }),
  });
  return {
    emitGraphEvent: (event) => compatibility.emit(event),
    async resolve(state, plan, signal) {
      const session = await getSessionManager().getSession(plan.envelope.sessionId);
      if (!session?.workingDirectory?.trim()) return { ok: false, reason: 'dynamic workflow session workspace is unavailable' };
      const workspaceResolution = validateDynamicWorkflowRecoveryWorkspace(state, session.workingDirectory);
      if (!workspaceResolution.ok) return workspaceResolution;
      const { workspace, cwd } = workspaceResolution;
      if (
        session.modelConfig.provider !== state.model.provider
        || session.modelConfig.model !== state.model.model
      ) {
        return { ok: false, reason: 'dynamic workflow session model identity has drifted' };
      }
      const baseModelConfig = resolveSessionDefaultModelConfig(state.model);
      if (baseModelConfig.provider !== state.model.provider || baseModelConfig.model !== state.model.model) {
        return { ok: false, reason: 'dynamic workflow model dependency is unavailable' };
      }
      const resolver = getToolResolver();
      const readonlyProfile = resolveToolProfile('readonly');
      if (readonlyProfile.tools.some((tool) => !resolver.getDefinition(tool))) {
        return { ok: false, reason: 'dynamic workflow readonly tool dependency is unavailable' };
      }
      const journal = createRecoveryJournal(plan.envelope.sessionId, cwd);
      if (!journal) return { ok: false, reason: 'dynamic workflow journal repository is unavailable' };
      const deps: ScriptRunHostDeps = {
        baseModelConfig,
        resolveModelConfig: (override) => resolveRecoveryModel(baseModelConfig, override),
        deriveSubagentContext: ({ agentId, modelConfig, signal: agentSignal, capabilities }): SubagentExecutionContext => ({
          runId: plan.envelope.runId,
          sessionId: plan.envelope.sessionId,
          workspace,
          cwd,
          modelConfig,
          resolver,
          permission: {
            request: async (request) => readonlyProfile.tools.includes(request.tool)
              && request.type !== 'file_write'
              && request.type !== 'file_edit'
              && request.type !== 'command'
              && request.type !== 'dangerous_command',
          },
          events: {
            emit: (type, data) => getEventBus().publish('agent', type, { type, data }, {
              sessionId: plan.envelope.sessionId,
              bridgeToRenderer: false,
            }),
          },
          abortSignal: agentSignal,
          traceContext: input.registry.getTraceContext(plan.envelope.runId),
          agentId,
          executionAgentId: agentId,
          capabilityManifest: capabilities,
        }),
        resolveAgentTools: (profile) => {
          if (profile && profile !== 'readonly') throw new Error('recovered dynamic workflow is restricted to readonly tools');
          return readonlyProfile;
        },
        signal,
        journal,
        traceContext: input.registry.getTraceContext(plan.envelope.runId),
      };
      return { ok: true, workspace, cwd, deps };
    },
  };
}

export function validateDynamicWorkflowRecoveryWorkspace(
  state: DynamicWorkflowDurableState,
  sessionWorkingDirectory: string,
): { ok: true; workspace: string; cwd: string } | { ok: false; reason: string } {
  let workspace: string;
  let cwd: string;
  let sessionWorkspace: string;
  try {
    workspace = resolveCanonicalRunPath(state.workspace.root);
    cwd = resolveCanonicalRunPath(state.workspace.cwd);
    sessionWorkspace = resolveCanonicalRunPath(sessionWorkingDirectory);
  } catch {
    return { ok: false, reason: 'dynamic workflow workspace cannot be canonicalized' };
  }
  if (workspace !== sessionWorkspace || !isRunPathInsideWorkspace(cwd, workspace)) {
    return { ok: false, reason: 'dynamic workflow workspace or cwd has drifted outside the session boundary' };
  }
  if (state.workspace.fingerprint !== fingerprintRunWorkspace(workspace)) {
    return { ok: false, reason: 'dynamic workflow workspace fingerprint has drifted' };
  }
  return { ok: true, workspace, cwd };
}

function resolveRecoveryModel(
  base: ModelConfig,
  override?: { provider: string; model: string },
): ModelConfig {
  if (!override) return base;
  if (override.provider !== base.provider || override.model !== base.model) {
    throw new Error('recovered dynamic workflow cannot expand its persisted model capability');
  }
  return base;
}

function createRecoveryJournal(sessionId: string, workingDir: string): ScriptRunJournal | undefined {
  const repo = getWorkflowJournalRepository();
  if (!repo) return undefined;
  return {
    loadPriorRun: (runId) => {
      const prior = repo.loadRun(runId);
      if (!prior) return null;
      return {
        run: {
          runId: prior.run.runId,
          scriptHash: prior.run.scriptHash,
          goal: prior.run.goal,
        },
        calls: new Map([...prior.calls].map(([index, call]) => [index, {
          contentHash: call.contentHash,
          result: call.result,
        }])),
      };
    },
    loadPriorCalls: (runId) => {
      const prior = repo.loadRun(runId);
      return prior
        ? new Map([...prior.calls].map(([index, call]) => [index, { contentHash: call.contentHash, result: call.result }]))
        : null;
    },
    onRunStart: (value) => repo.startRun({
      ...value,
      sessionId,
      workingDir,
    }),
    onRunFinish: (value) => repo.finishRun(value),
    onCallComplete: (value) => repo.recordCall(value),
  };
}

export function dynamicWorkflowRecoveryDescriptorHasOnlySafeCapabilities(
  state: DynamicWorkflowDurableState,
): boolean {
  return state.toolProfile === 'readonly'
    && state.graphSpec.nodes.every((node) => node.sideEffect === 'none' || node.sideEffect === 'read_only');
}
