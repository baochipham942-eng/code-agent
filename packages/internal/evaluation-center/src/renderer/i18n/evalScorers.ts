import type { AiReviewDimension } from '@shared/contract/evaluation';

const zhDimensions = {
  task_completed: '任务完成了吗',
  tool_choice: '工具选得对吗',
  confirmed_before_acting: '该确认时确认了吗',
  no_extra_changes: '没干多余的事',
  self_tested: '自测过没',
} satisfies Record<AiReviewDimension, string>;

const enDimensions = {
  task_completed: 'Was the task completed?',
  tool_choice: 'Were the right tools chosen?',
  confirmed_before_acting: 'Was confirmation requested when needed?',
  no_extra_changes: 'Were extra changes avoided?',
  self_tested: 'Was the result self-tested?',
} satisfies Record<AiReviewDimension, string>;

const zh = {
  sectionAssertions: '确定性断言',
  assertionsSubtitle: '通过率 = 断言通过率，是定义不是选择 · 默认全挂、不可关',
  collapsed: '其余 {n} 种已折叠',
  collapse: '收起',
  sectionAiReview: 'AI 评审 5 问',
  aiReviewSubtitle: '是 / 否 · 各成一列，不合成综合分 · 未校准的维跑分时默认不勾',
  calibrated: '已校准 κ={kappa} · 金标 {pairs} 条',
  shadowGold: '（影子金标）',
  uncalibrated: '未校准',
  reasons: {
    no_record: '没有校准记录',
    below_threshold: '一致性没有达到上线要求',
    prompt_changed: '提示词改过，需要重跑校准',
    not_enough_pairs: '金标不足 N<20',
    superseded: '按旧标准，需重跑',
    judge_changed: '评审模型或端点已变，需要重跑校准',
  },
  dimensions: zhDimensions,
  needsExpectation: '题集没有逐题期望，评审不了',
  sectionHuman: '人工评审',
  humanReview: '👍/👎 + 一句话 · 并列写回，不进通过率 · 在单题证据抽屉里打',
  judgeRule: '评审模型能力必须 ≥ 被测模型',
  currentJudge: '当前评审模型：{model}',
  loading: '正在读取打分器…',
  loadFailed: '打分器信息暂时不可用',
};

const en = {
  sectionAssertions: 'Deterministic assertions',
  assertionsSubtitle: 'Pass rate = assertion pass rate · always enabled and cannot be turned off',
  collapsed: '{n} more types collapsed',
  collapse: 'Collapse',
  sectionAiReview: 'Five AI review questions',
  aiReviewSubtitle: 'Yes / No · separate columns · never combined into an overall score · uncalibrated dimensions are off by default',
  calibrated: 'Calibrated κ={kappa} · {pairs} gold labels',
  shadowGold: ' (shadow gold)',
  uncalibrated: 'Uncalibrated',
  reasons: {
    no_record: 'No calibration record',
    below_threshold: 'Agreement is below the launch requirement',
    prompt_changed: 'Prompt changed; calibration must be rerun',
    not_enough_pairs: 'Not enough gold labels N<20',
    superseded: 'Old standard; rerun required',
    judge_changed: 'Review model or endpoint changed; rerun required',
  },
  dimensions: enDimensions,
  needsExpectation: 'This case set has no per-case expectation for this review',
  sectionHuman: 'Human review',
  humanReview: '👍/👎 + one sentence · stored alongside results, excluded from pass rate · labeled in the case evidence drawer',
  judgeRule: 'The review model must be at least as capable as the tested model',
  currentJudge: 'Current review model: {model}',
  loading: 'Loading scorers…',
  loadFailed: 'Scorer information is temporarily unavailable',
};

export const evalScorersZh = { scorers: zh };
export const evalScorersEn = { scorers: en };
