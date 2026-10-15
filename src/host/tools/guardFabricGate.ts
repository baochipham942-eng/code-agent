// ============================================================================
// GuardFabric gate adapter for ToolExecutor
// ============================================================================

import type { DecisionStep, DecisionTrace } from '../../shared/contract/decisionTrace';
import { getGuardFabric, type ExecutionTopology } from '../permissions';
import { getPolicyEngine } from '../permissions/policyEngine';
import { resolveEffectivePolicyRules } from '../permissions/runPolicySnapshot';
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

/**
 * 用户在设置里写的拒绝规则（如 Bash(rm *)）对所有拓扑都是硬拒，在审批之前生效（N-PERM-USER-DENY-MAIN）。
 * 此前主拓扑直接放行、非主拓扑也只消费 topology 裁决，命令类用户 deny 没有任何消费方——
 * rm 照样落到审批分类器，点允许就执行。
 * 只认命中规则本身是 user-deny：PolicyEngine 在 plan/dontAsk 等严格模式下会把命中的 user-allow
 * 改写成 action=deny，那是模式的事、由主链按真实 level 判，不能在这里当成「你的拒绝规则」硬拒。
 */
function evaluateUserDeny(input: GuardFabricGateInput): GuardFabricGateResult['deny'] | undefined {
  const { matchedRule } = getPolicyEngine().evaluate({
    tool: input.policyToolName,
    level: 'execute',
    description: `tool: ${input.policyToolName}`,
    command: input.params.command as string,
    filePath: (input.params.filePath as string) || (input.params.file_path as string),
    sessionId: input.sessionId,
  }, resolveEffectivePolicyRules(input.sessionId));
  if (matchedRule?.action !== 'deny' || !matchedRule.id.startsWith('user-deny-')) return undefined;
  const reason = `user-config: ${matchedRule.name}`;
  logger.warn('Denied by user permission rule', { toolName: input.executionToolName, rule: matchedRule.id });
  const trace = createTraceBuilder(input.executionToolName)
    .addStep('policy_enforcer', matchedRule.id, 'deny', reason)
    .build('deny');
  return {
    error: `Blocked by your permission deny rule (${matchedRule.name}). This tool call is denied by the user's settings; do not retry it or try to achieve the same effect another way.`,
    reason,
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
