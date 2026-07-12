import { createHash } from 'node:crypto';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { getAgentRequirementsAnalyzer } from '../agent/agentRequirementsAnalyzer';
import { getAutoAgentCoordinator } from '../agent/autoAgentCoordinator';
import { getDynamicAgentFactory } from '../agent/dynamicAgentFactory';
import { getToolResolver } from '../tools/dispatch/toolResolver';
import { getSessionManager } from '../services/infra/sessionManager';
import { AutoAgentRecoveryHost, type AutoAgentRecoveryRunner } from '../runtime/autoAgentRecoveryHost';
import type { RunRegistry } from '../runtime/runRegistry';
import { GraphEventCompatibilityAdapter } from '../orchestration/graphEventCompatibilityAdapter';

export function createApplicationAutoAgentRecoveryHost(registry: RunRegistry): AutoAgentRecoveryHost {
  const runner: AutoAgentRecoveryRunner = {
    async resume({ plan, state, emit, persist }) {
      if (!state.graphCheckpoint) return { status: 'requires_review', reason: 'auto_agent_graph_checkpoint_missing' };
      let canonicalWorkspace: string;
      try {
        canonicalWorkspace = await realpath(state.workspace.root);
      } catch {
        return { status: 'requires_review', reason: 'auto_agent_workspace_unavailable' };
      }
      const fingerprint = createHash('sha256').update(path.resolve(canonicalWorkspace)).digest('hex');
      if (fingerprint !== state.workspace.fingerprint) {
        return { status: 'requires_review', reason: 'auto_agent_workspace_drift' };
      }
      const sessionManager = getSessionManager();
      const [session, messages] = await Promise.all([
        sessionManager.getSession(plan.envelope.sessionId),
        sessionManager.getMessages(plan.envelope.sessionId, 500),
      ]);
      const source = messages.find((message) => message.id === state.sourceMessageId && message.role === 'user');
      if (!session || !source) return { status: 'requires_review', reason: 'auto_agent_source_message_missing' };
      const analyzer = getAgentRequirementsAnalyzer();
      const requirements = await analyzer.analyze(source.content, canonicalWorkspace);
      if (!requirements.needsAutoAgent) return { status: 'requires_review', reason: 'auto_agent_requirements_drift' };
      const agents = getDynamicAgentFactory().create(requirements, {
        userMessage: source.content,
        workingDirectory: canonicalWorkspace,
        sessionId: plan.envelope.sessionId,
      });
      const expectedNodes = new Set(state.graphCheckpoint.nodes.map((node) => node.nodeId));
      if (agents.length === 0 || agents.some((agent) => !expectedNodes.has(agent.id))) {
        return { status: 'requires_review', reason: 'auto_agent_graph_definition_drift' };
      }
      let latestCheckpoint = state.graphCheckpoint;
      const result = await getAutoAgentCoordinator().execute(agents, requirements, {
        sessionId: plan.envelope.sessionId,
        graphCheckpoint: state.graphCheckpoint,
        onGraphCheckpoint: async (checkpoint) => {
          latestCheckpoint = checkpoint;
          await persist(checkpoint);
        },
        executionContext: {
          runId: plan.envelope.runId,
          sessionId: plan.envelope.sessionId,
          workspace: canonicalWorkspace,
          cwd: state.workspace.cwd,
          modelConfig: session.modelConfig,
          resolver: getToolResolver(),
          permission: { request: async () => true },
          events: { emit: async () => undefined },
          abortSignal: new AbortController().signal,
        },
        compatibilitySink: new GraphEventCompatibilityAdapter({ graph: emit }),
      });
      const checkpoint = latestCheckpoint;
      return {
        status: result.success ? 'completed' : 'failed',
        checkpoint: { ...checkpoint, status: result.success ? 'completed' : 'failed', updatedAt: Date.now() },
        results: {},
      };
    },
    shutdown() {
      // AutoAgentCoordinator owns and cancels the actual GraphRunner by session.
    },
  };
  return new AutoAgentRecoveryHost(registry, runner, {
    diagnostic: () => undefined,
  });
}
