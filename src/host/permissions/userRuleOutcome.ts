// ============================================================================
// userRuleOutcome —— 一句话规则的运行时消费端（N-PERM-NL-RULES-K2）
// ----------------------------------------------------------------------------
// 给定 session + 工具 + 参数，给出这条调用落在哪一档用户规则上：
//   denied      命中 deny（nlRules 的 deny，或三张旧表的 user-deny-）——调用方硬拒
//   handback    命中「交回我亲手做」——进审批链但带 handback 标记（无人值守停车）
//   ask         命中「先问我」（nlRules 的 ask，或旧表 user-prompt-——K2 起 K1 存的
//               ask 规则真的会在运行时强制弹审批），或 preapprove 未命中短语
//   preapproved 命中「我说了才做」且本轮发起话里出现了任一触发短语
//   none        没有用户规则管这条调用（旧表 user-allow 不产生新放行捷径，同 K1）
//
// 判定序（任务书）：deny > handback > ask > preapprove-miss(=ask) > preapprove-hit。
// 规则列表读 runPolicySnapshot 的有效视图（外部来源的放宽对已开始的 run 冻结），
// 角色域与发起话同样用 run 起点的盖章（beginRunPolicy），run 结束即失效。
// ============================================================================

import { getPolicyEngine, type PolicyRule } from './policyEngine';
import { NL_RULE_K2_TEXT } from '../../shared/nlRuleRestate';
import { resolveEffectivePolicyRules, resolveRunUserRuleContext } from './runPolicySnapshot';

/** 消费结果。rule 是命中的规则串（Tool(pattern) 或裸工具名），用于指名与留痕。 */
export type UserRuleOutcome =
  | { kind: 'none' }
  | { kind: 'denied'; rule: string }
  | { kind: 'handback'; rule: string }
  | { kind: 'ask'; rule: string }
  | { kind: 'preapproved'; rule: string; phrase: string };

interface UserRuleOutcomeInput {
  sessionId?: string;
  /** 规范化后的工具名（与规则书写同一口径，engine 内部再折叠大小写） */
  tool: string;
  /** Bash 类工具的整条命令；无则不参与 command 指定符匹配 */
  command?: string;
  /** 路径类工具的目标路径；无则不参与 path 指定符匹配 */
  filePath?: string;
}

/**
 * toolExecutor 侧入口：从工具参数里取 command/路径（与 guardFabricGate 的
 * evaluateUserDeny 同一字段口径），再走 resolveUserRuleOutcome。
 */
export function resolveUserRuleOutcomeForTool(
  sessionId: string | undefined,
  tool: string,
  params: Record<string, unknown>,
): UserRuleOutcome {
  return resolveUserRuleOutcome({
    sessionId,
    tool,
    ...(typeof params.command === 'string' && params.command ? { command: params.command } : {}),
    ...(typeof (params.filePath ?? params.file_path ?? params.path) === 'string'
      ? { filePath: (params.filePath ?? params.file_path ?? params.path) as string }
      : {}),
  });
}

/** 单条 user-* 规则映射到 K2 档位；none = 这条规则不产生 K2 语义（如旧表 allow）。 */
function ruleKind(rule: PolicyRule): 'denied' | 'handback' | 'ask' | 'preapprove' | 'none' {
  const nl = rule.userNlRule;
  if (nl) return nl.behavior === 'allow' ? 'none' : nl.behavior === 'deny' ? 'denied' : nl.behavior;
  // 旧三表：deny 已由既有硬拒链消费（这里同样报 denied，做第二道网）；ask 即强制
  // 弹审批（K2 语义）；allow 不产生新放行捷径。
  if (rule.action === 'deny') return 'denied';
  if (rule.action === 'prompt') return 'ask';
  return 'none';
}

function ruleString(rule: PolicyRule): string {
  return rule.userNlRule?.rule ?? rule.name.replace(/^User [a-z]+:\s*/, '');
}

/**
 * 解析这条工具调用的用户规则档位。匹配语义与 engine.evaluate 同源
 * （PolicyEngine.matchUserRules：工具名规范化 + Tool(pattern) glob），
 * 规则列表传 run 有效视图，外部放宽不作用于已开始的 run。
 */
function resolveUserRuleOutcome(input: UserRuleOutcomeInput): UserRuleOutcome {
  const runContext = resolveRunUserRuleContext(input.sessionId);
  const matched = getPolicyEngine().matchUserRules(
    {
      tool: input.tool,
      level: 'execute',
      description: `tool: ${input.tool}`,
      command: input.command,
      filePath: input.filePath,
      sessionId: input.sessionId,
      // 角色域规则的 matcher.custom 只在 run 盖章角色一致时命中；主聊天（无 roleId）
      // 与别的角色都不命中。
      ...(runContext.roleId ? { roleId: runContext.roleId } : {}),
    },
    resolveEffectivePolicyRules(input.sessionId),
  );
  if (matched.length === 0) return { kind: 'none' };

  const denied = matched.find((rule) => ruleKind(rule) === 'denied');
  if (denied) return { kind: 'denied', rule: ruleString(denied) };
  const handback = matched.find((rule) => ruleKind(rule) === 'handback');
  if (handback) return { kind: 'handback', rule: ruleString(handback) };
  const ask = matched.find((rule) => ruleKind(rule) === 'ask');
  if (ask) return { kind: 'ask', rule: ruleString(ask) };

  // preapprove：任一触发短语逐字出现在本轮发起话里 → 免询问；否则回落 ask
  //（绝不静默放行，也绝不静默拦死）。
  const initiatingText = runContext.initiatingText;
  for (const rule of matched) {
    if (ruleKind(rule) !== 'preapprove') continue;
    const phrases = rule.userNlRule?.phrases ?? [];
    const hit = initiatingText ? phrases.find((phrase) => initiatingText.includes(phrase.trim())) : undefined;
    if (hit) return { kind: 'preapproved', rule: ruleString(rule), phrase: hit.trim() };
  }
  const preapproveMiss = matched.find((rule) => ruleKind(rule) === 'preapprove');
  if (preapproveMiss) return { kind: 'ask', rule: ruleString(preapproveMiss) };
  return { kind: 'none' };
}

/** handback「我做完了」回给模型的工具结果文案（用户亲自做，勿重试，继续别的活）。 */
export const handbackDoneModelText = NL_RULE_K2_TEXT.handbackDoneModelText;
