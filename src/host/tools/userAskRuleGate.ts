// ============================================================================
// 用户 ask 规则闸门（N-FIX-NL-RULE-ASK-BASH-SILENT-ABORT）
// ============================================================================
// 用户在设置里写的「询问」规则（如 Bash(rm *) → ask）此前只作为 PolicyEngine 里的一条
// 低优先级 prompt 规则存在，没有任何放行捷径之前的消费方：bypassPermissions/acceptEdits
// 档、skill 预授权、exec-policy allow、已知安全命令都会越过它，用户保存的「先问我」
// 静默失效。这里按规则本身（id 前缀 user-prompt-）独立扫描，命中即强制进审批通道，
// 与 guardFabricGate 的 user-deny 扫描同款（不看 evaluate 的 matchedRule 竞争结果）。

import type { DecisionStep } from '../../shared/contract/decisionTrace';
import { getPolicyEngine } from '../permissions/policyEngine';
import { resolveEffectivePolicyRules } from '../permissions/runPolicySnapshot';
import type { PolicyRequest } from '../permissions/policyEngine';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('UserAskRuleGate');

export interface UserAskRuleHit {
  ruleId: string;
  ruleName: string;
  traceStep: DecisionStep;
}

export function matchUserAskRule(
  request: PolicyRequest,
  sessionId: string | undefined,
  executionToolName: string,
): UserAskRuleHit | undefined {
  const engine = getPolicyEngine();
  for (const rule of resolveEffectivePolicyRules(sessionId)) {
    if (!rule.id.startsWith('user-prompt-') || rule.action !== 'prompt') continue;
    // 单规则评估：命中与否只取决于这条规则自己的 matcher，不受优先级竞争/模式联动影响。
    if (engine.evaluate(request, [rule]).matchedRule?.id !== rule.id) continue;
    const reason = `user-config: ${rule.name}`;
    logger.info('User ask rule hit, forcing approval', { toolName: executionToolName, rule: rule.id });
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      traceStep: {
        layer: 'policy_enforcer',
        rule: rule.id,
        result: 'ask',
        reason,
        durationMs: 0,
        timestamp: Date.now(),
      },
    };
  }
  return undefined;
}
