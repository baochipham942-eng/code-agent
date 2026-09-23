export interface UserQuestionOption {
  label: string;
  description: string;
  recommended?: boolean;
}

const RECOMMENDED_LABEL_SUFFIX = /\s*\((?:推荐|Recommended)\)\s*$/iu;

/**
 * Provider 既可以传结构化 recommended，也可以沿用 schema 约定的 label 后缀。
 * 统一在边界去掉后缀，避免 renderer 回传的答案把展示标记混进真实选项值。
 */
export function normalizeUserQuestionOption(option: UserQuestionOption): UserQuestionOption {
  const hasRecommendedSuffix = RECOMMENDED_LABEL_SUFFIX.test(option.label);
  return {
    ...option,
    label: hasRecommendedSuffix ? option.label.replace(RECOMMENDED_LABEL_SUFFIX, '').trim() : option.label,
    ...(option.recommended === true || hasRecommendedSuffix ? { recommended: true } : {}),
  };
}

export const ASK_USER_QUESTION_DECLINED_OUTPUT =
  'Questions skipped by the user; continue with the information you already have, make reasonable defaults where decisions are required and state your assumptions in your response, and do not ask the same question again.';

/** AskUserQuestion 无头回退的开头标记。文案已进夜跑库 result_summary，一字不改。 */
export const ASK_USER_QUESTION_UNANSWERED_PREFIX = '[用户未响应 - CLI 模式无法交互]';

/** AskUserQuestion 同轮重复问句回放的工具结果后缀（对模型可见）。 */
export const ASK_USER_QUESTION_REPLAY_SUFFIX =
  '\n\n[回放] 你这轮已答过这组问题：问句与选项归一化后与本轮上次提问完全相同，以上为上次答案的直接回放，没有再次询问用户。请基于该答案继续，不要重复提问。';
