// ============================================================================
// GuardFabric gate adapter for ToolExecutor
// ============================================================================

import type { DecisionStep, DecisionTrace } from '../../shared/contract/decisionTrace';
import { getGuardFabric, type ExecutionTopology } from '../permissions';
import { UserConfigSource } from '../permissions/userConfigSource';
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

const userRules = new UserConfigSource();

/**
 * 用户在设置里写的拒绝规则（如 Bash(rm *)）对所有拓扑都是硬拒，在审批之前生效（N-PERM-USER-DENY-MAIN）。
 * 此前主拓扑直接放行、非主拓扑也只消费 topology 裁决，命令类用户 deny 没有任何消费方——
 * rm 照样落到审批分类器，点允许就执行。只接 deny：用户 ask/allow 的语义不在这里改。
 */
function evaluateUserDeny(input: GuardFabricGateInput): GuardFabricGateResult['deny'] | undefined {
  const verdict = userRules.evaluate({
    tool: input.policyToolName,
    args: input.params,
    topology: input.topology,
    sessionId: input.sessionId,
    agentId: input.agentId,
  });
  if (verdict?.verdict !== 'deny') return undefined;
  logger.warn('Denied by user permission rule', { toolName: input.executionToolName, reason: verdict.reason });
  const trace = createTraceBuilder(input.executionToolName)
    .addStep('policy_enforcer', 'user-config', 'deny', verdict.reason)
    .build('deny');
  return {
    error: `Blocked by your permission deny rule (${verdict.reason}). This tool call is denied by the user's settings; do not retry it or try to achieve the same effect another way.`,
    reason: verdict.reason,
    trace,
  };
}

export function evaluateGuardFabricGate(input: GuardFabricGateInput): GuardFabricGateResult {
  const userDeny = evaluateUserDeny(input);
  if (userDeny) return { deny: userDeny };

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

    // 只消费 topology 规则的裁决（2026-07-13 激活批收窄）：其余 sources（policyEngine/
    // userConfig/hook）与主权限链在错误的 level（硬编码 execute）上重复评估，若放行其
    // deny/ask，任何非 main 拓扑的每一次工具调用都会被强制弹确认/误杀。user deny 已在
    // 函数开头 evaluateUserDeny 对全部拓扑处理。
    if (guardDecision.source !== 'topology') {
      return {};
    }

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
