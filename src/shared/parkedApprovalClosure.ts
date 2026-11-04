// 停车审批被自动收口（没有执行）后写进台账 denied 结果的四句大白话。
// host（describeParkedApprovalClosure 写入）与 renderer（精确匹配后读作「未执行」而非「执行失败」）
// 共用这一处，句子只在这里写一遍。句子本身暂未做 i18n（已知缺口，英文 UI 也显示中文句）。
export const PARKED_APPROVAL_CLOSURE_SENTENCES = {
  expiredAfterRestart24h: '这一步等你确认超过 24 小时，已自动作废，没有执行。',
  workingDirectoryUnavailable: '这次对话没有工作目录，重启后无法安全执行，没有执行。',
  runEndedAfterRestart: '所属运行已结束，没有执行；下次触发会重新询问你。',
  argsUnavailable: '应用重启后找不到这一步的完整信息，为安全起见没有执行。',
} as const;

const CLOSURE_SENTENCE_SET: ReadonlySet<string> = new Set(Object.values(PARKED_APPROVAL_CLOSURE_SENTENCES));

/**
 * 台账/收件箱里持久化的是中文原句；展示侧拿原句做**精确**查表换出 i18n 词条键。
 * 差一个字都返回 null（当普通失败文案处理），不做任何模糊匹配。
 */
export function lookupParkedApprovalClosureKey(text: unknown): keyof typeof PARKED_APPROVAL_CLOSURE_SENTENCES | null {
  if (typeof text !== 'string') return null;
  for (const key of Object.keys(PARKED_APPROVAL_CLOSURE_SENTENCES) as (keyof typeof PARKED_APPROVAL_CLOSURE_SENTENCES)[]) {
    if (PARKED_APPROVAL_CLOSURE_SENTENCES[key] === text) return key;
  }
  return null;
}

export function isParkedApprovalClosureSentence(text: unknown): text is string {
  return typeof text === 'string' && CLOSURE_SENTENCE_SET.has(text);
}
