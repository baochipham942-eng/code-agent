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
