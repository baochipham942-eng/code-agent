// ============================================================================
// GuardFabric gate adapter for ToolExecutor
// ============================================================================

import type { DecisionStep, DecisionTrace } from '../../shared/contract/decisionTrace';
import { getGuardFabric, type ExecutionTopology } from '../permissions';
import { createLogger } from '../services/infra/logger';
import { createTraceBuilder } from '../security/decisionTraceBuilder';

const logger = createLogger('GuardFabricGate');

export interface GuardFabricGateInput {
  executionToolName: string;
  policyToolName: string;
  params: Record<string, unknown>;
  topology: ExecutionTopology;
  sessionId?: string;
  agentId?: string;
}

export interface GuardFabricGateResult {
  deny?: {
    error: string;
    reason: string;
    trace?: DecisionTrace;
  };
  forceApproval?: boolean;
  traceStep?: DecisionStep;
}

export function evaluateGuardFabricGate(input: GuardFabricGateInput): GuardFabricGateResult {
  if (input.topology === 'main') {
    return {};
  }

  try {
    const guardDecision = getGuardFabric().evaluate({
      tool: input.policyToolName,
      args: input.params,
      topology: input.topology,
      sessionId: input.sessionId,
      agentId: input.agentId,
    });

    if (guardDecision.verdict === 'deny') {
      logger.warn('Denied by GuardFabric', {
        toolName: input.executionToolName,
        topology: input.topology,
        reason: guardDecision.reason,
      });
      const trace = guardDecision.traceStep
        ? createTraceBuilder(input.executionToolName)
          .addStep(
            guardDecision.traceStep.layer,
            guardDecision.traceStep.rule,
            guardDecision.traceStep.result,
            guardDecision.traceStep.reason,
          )
          .build('deny')
        : undefined;
      return {
        deny: {
          error: `Blocked by GuardFabric: ${guardDecision.reason}`,
          reason: guardDecision.reason,
          trace,
        },
      };
    }

    if (guardDecision.verdict === 'ask') {
      return {
        forceApproval: true,
        traceStep: guardDecision.traceStep,
      };
    }

    return {};
  } catch (error) {
    logger.warn('GuardFabric evaluation failed', {
      toolName: input.executionToolName,
      topology: input.topology,
      error: error instanceof Error ? error.message : error,
    });

    const failBehavior = getGuardFabric().getFailBehavior(input.topology);
    const reason = `GuardFabric evaluation failed for ${input.topology}`;
    if (failBehavior === 'deny') {
      return {
        deny: {
          error: `Blocked by GuardFabric: ${reason}`,
          reason,
          trace: createTraceBuilder(input.executionToolName)
            .addStep('guard_fabric', `failure: ${input.topology}`, 'deny', reason)
            .build('deny'),
        },
      };
    }

    return {
      forceApproval: true,
      traceStep: {
        layer: 'guard_fabric',
        rule: `failure: ${input.topology}`,
        result: 'ask',
        reason,
        durationMs: 0,
        timestamp: Date.now(),
      },
    };
  }
}
