// ============================================================================
// nlRuleRestate —— K2 两档新行为（我说了才做 / 交回我亲手做）的中文话术唯一源
// ----------------------------------------------------------------------------
// 与 K1 的 NL_RULE_TEXT 同一投放模式（cronHumanize 先例：host 生成话术 + renderer
// 展示共用一份，不进大 settings i18n 文件）。这里只放 K2 新增的：
// 结构化规则复述（describeNlRule，代码生成不经过模型）、handback 审批卡/收件箱/
// 通知文案、以及「我做完了」裁决回给模型的工具结果文案。
// ============================================================================

import { NL_RULE_TEXT, ruleScopePhrase, type NlRuleBehavior } from './permissionRuleTranslate';

/** describeNlRule 的结构化输入：与 settings.permissions.nlRules 条目及草稿形状兼容。 */
export interface NlRuleRestateInput {
  behavior: NlRuleBehavior;
  rule: string;
  /** 只对该角色生效；缺省 = 所有人 */
  roleId?: string;
  /** preapprove 触发短语 */
  phrases?: readonly string[];
}

/** K2 新增话术（zh）。allow/ask/deny 的短语沿用 NL_RULE_TEXT.behaviorPhrase。 */
export const NL_RULE_K2_TEXT = {
  scopeEveryone: '对所有人生效',
  scopeRole: (roleName: string): string => `只对「${roleName}」生效`,
  phrasesLabel: '约定的话',
  phrasesList: (phrases: readonly string[]): string => phrases.map((phrase) => `「${phrase}」`).join(' / '),
  restatement: {
    preapprove: (phrases: readonly string[]): string => (
      `只有你在这轮开头说了 ${NL_RULE_K2_TEXT.phrasesList(phrases)} 才直接做；没说就先问你`
    ),
    handback: '停下来交回给你亲自做，这一步不算失败',
  },
  /** handback 审批卡（attended） */
  card: {
    title: '这一步按你的规则要交回给你',
    question: '你设的规则是这一步由你亲手做。现在这步到了，怎么处理？',
    userDidIt: '我做完了，继续',
    userDidItDesc: '告诉 Neo 这步你自己做了，不用重试，继续干别的',
    letNeoOnce: '让 Neo 做这一次',
    letNeoOnceDesc: '只这一次由 Neo 代做，规则保持不变',
    note: '两种选择都不算失败：任务会继续往下走。',
  },
  /** handback 无人值守停车 + 系统通知 */
  notify: {
    title: '有一步需要你亲自做',
    body: (tool: string): string => (
      `按你设的「交回我亲手做」规则，任务把 ${tool} 这一步留给了你，已挂起：你做完后在收件箱点「我做完了」，或点「让 Neo 做这一次」。这不是失败，任务会接着走。`
    ),
  },
  /** 收件箱 handback 行 */
  inbox: {
    badge: '要你亲手做',
    userDidIt: '我做完了',
    letNeoOnce: '让 Neo 做这一次',
  },
  /** 「我做完了」裁决 → 回给模型的工具结果（model-visible） */
  handbackDoneModelText: (
    tool: string,
  ): string => (
    `The user is handling this step (${tool}) personally per their own rule — they said they have done or will do it themselves. Do not retry this tool call and do not try to achieve the same effect another way; continue with the rest of the work.`
  ),
  /** handback 命中时的审批 reason（进 decisionTrace / 审批卡 reason） */
  handbackRuleReason: 'user-nl-rule: hand back to the user (their own one-sentence rule)',
} as const;

/**
 * 结构化条目 → 人话复述（代码生成）。范围段与 K1 describeRule 同源（ruleScopePhrase），
 * 行为段按 K2 语义展开；带角色范围时附「只对 X 生效」，preapprove 列出约定短语。
 */
export function describeNlRule(
  entry: NlRuleRestateInput,
  roleNameFor?: (roleId: string) => string | undefined,
): string {
  const scopeTail = entry.roleId
    ? `（${NL_RULE_K2_TEXT.scopeRole(roleNameFor?.(entry.roleId) ?? entry.roleId)}）`
    : '';
  if (entry.behavior === 'preapprove') {
    const phrases = entry.phrases && entry.phrases.length > 0 ? entry.phrases : [];
    return `${ruleScopePhrase(entry.rule)} → ${NL_RULE_K2_TEXT.restatement.preapprove(phrases)}${scopeTail}`;
  }
  if (entry.behavior === 'handback') {
    return `${ruleScopePhrase(entry.rule)} → ${NL_RULE_K2_TEXT.restatement.handback}${scopeTail}`;
  }
  return `${ruleScopePhrase(entry.rule)} → ${NL_RULE_TEXT.behaviorPhrase[entry.behavior]}${scopeTail}`;
}
