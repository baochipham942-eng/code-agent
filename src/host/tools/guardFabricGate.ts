// ============================================================================
// GuardFabric gate adapter for ToolExecutor
// ============================================================================

import type { DecisionStep, DecisionTrace } from '../../shared/contract/decisionTrace';
import { HostReasonCode, createHostReason, type HostReasonPayload } from '../../shared/contract/permission';
import { getGuardFabric, type ExecutionTopology } from '../permissions';
import { resolveGuardLevel } from '../permissions/guardFabric';
import type { PermissionLevel } from '../../shared/contract/tool';
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
  /** 按 toolDef.permissionLevel 传入；缺省按 execute 评估（fail-safe，维持旧行为）。 */
  permissionLevel?: PermissionLevel;
}

export interface GuardFabricGateResult {
  deny?: {
    error: string;
    reason: string;
    /** 结构化原因（稳定 code + toolName 元数据），renderer 登记表直查，不落英文原句。 */
    hostReason?: HostReasonPayload;
    trace?: DecisionTrace;
  };
  forceApproval?: boolean;
  traceStep?: DecisionStep;
}

/**
 * 用户在设置里写的拒绝规则（如 Bash(rm *)）对所有拓扑都是硬拒，在审批之前生效（N-PERM-USER-DENY-MAIN）。
 * 此前主拓扑直接放行、非主拓扑也只消费 topology 裁决，命令类用户 deny 没有任何消费方——
 * rm 照样落到审批分类器，点允许就执行。
 * 只认规则本身是 user-deny（matchUserDenyRule 独立扫描）：Plan/dontAsk 等严格模式下
 * PolicyEngine 会把命中的 user-allow 改写成 action=deny，那是模式的事、由主链按真实
 * level 判，不能在这里当成「你的拒绝规则」硬拒。FU1 r1：level 修正后内置不可覆盖 deny
 * （block-root-write/block-ssh-keys）会在 evaluate 的 Pass1 抢先成为 matchedRule，若拿它的
 * 前缀当答案，用户 deny 被遮蔽成「无规则命中」，硬拒降级成可批的 ask——所以命中判定
 * 不看 evaluate 的 matchedRule，走独立扫描。
 */
function buildPolicyRequest(input: GuardFabricGateInput) {
  return {
    tool: input.policyToolName,
    level: resolveGuardLevel(input.permissionLevel),
    description: `tool: ${input.policyToolName}`,
    command: input.params.command as string,
    filePath: (input.params.filePath as string) || (input.params.file_path as string),
    sessionId: input.sessionId,
  };
}

function evaluateUserDeny(input: GuardFabricGateInput): GuardFabricGateResult['deny'] | undefined {
  const request = buildPolicyRequest(input);
  const rules = resolveEffectivePolicyRules(input.sessionId);
  // 完整评估保留：审计按真实 level 记账（FU1 验收⑥），模式联动语义不变。
  getPolicyEngine().evaluate(request, rules);
  const matchedRule = getPolicyEngine().matchUserDenyRule(request, rules);
  if (!matchedRule) return undefined;
  const reason = `user-config: ${matchedRule.name}`;
  logger.warn('Denied by user permission rule', { toolName: input.executionToolName, rule: matchedRule.id });
  const trace = createTraceBuilder(input.executionToolName)
    .addStep('policy_enforcer', matchedRule.id, 'deny', reason)
    .build('deny');
  const error = `Blocked by your permission deny rule (${matchedRule.name}). This tool call is denied by the user's settings; do not retry it or try to achieve the same effect another way.`;
  return {
    error,
    reason,
    hostReason: createHostReason(HostReasonCode.PermissionDeniedUserRule, error, { toolName: input.executionToolName }),
    trace,
  };
}

/**
 * 内置不可覆盖 deny（block-root-write / block-ssh-keys / block-rm-rf-root）对所有拓扑硬拒，
 * 在审批之前生效；此前只进审计，主链上 Write /usr/bin/x 仍会弹审批卡、点允许就执行。
 */
function evaluateBuiltinHardDeny(input: GuardFabricGateInput): GuardFabricGateResult['deny'] | undefined {
  const rule = getPolicyEngine().matchHardDenyRule(buildPolicyRequest(input), resolveEffectivePolicyRules(input.sessionId));
  if (!rule) return undefined;
  const reason = `built-in: ${rule.name}`;
  logger.warn('Denied by built-in safety rule', { toolName: input.executionToolName, rule: rule.id });
  const trace = createTraceBuilder(input.executionToolName)
    .addStep('policy_enforcer', rule.id, 'deny', reason)
    .build('deny');
  const error = `Blocked by built-in safety rule (${rule.name}): ${rule.reason}. Do not retry. Write inside the workspace/project directory instead, or ask the user to make this change themselves.`;
  return {
    error,
    reason,
    hostReason: createHostReason(HostReasonCode.PermissionDeniedSafetyRule, error, { toolName: input.executionToolName }),
    trace,
  };
}

export function evaluateGuardFabricGate(input: GuardFabricGateInput): GuardFabricGateResult {
  const userDeny = evaluateUserDeny(input);
  if (userDeny) return { deny: userDeny };

  const builtinDeny = evaluateBuiltinHardDeny(input);
  if (builtinDeny) return { deny: builtinDeny };

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
      level: input.permissionLevel,
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
