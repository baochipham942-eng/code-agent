import type { EvalStatusLabels } from './evalStatusLabels';

/** Copy for the single-case evidence drawer. */
export interface EvalCaseDrawerLabels {
  title: string;
  close: string;
  loading: string;
  loadFailed: string;
  status: EvalStatusLabels;
  conclusion: string;
  conversation: string;
  representativeAttempt: string;
  selectedAttempt: string;
  unstable: string;
  mixedTrials: string;
  excludedTrials: string;
  promptVersion: string;
  productionDefault: string;
  input: string;
  actualOutput: string;
  responseExcerpt: string;
  toolsCollapsed: string;
  toolsExpanded: string;
  toolOk: string;
  toolFailed: string;
  toolFailureMissing: string;
  simulatorRule: string;
  toolsTruncated: string;
  noProcessEvidence: string;
  noPromptEvidence: string;
  noOutputEvidence: string;
  checks: string;
  checkName: string;
  expected: string;
  actual: string;
  score: string;
  scoreColumn: string;
  checkSummary: string;
  judgedPassed: string;
  judgedFailed: string;
  excludedExplanation: string;
  excludedShort: string;
  excludedFailure: string;
  aiReview: string;
  aiReviewNote: string;
  verdict: Record<'yes' | 'no' | 'unavailable', string>;
  source: string;
  sourceManual: string;
  sourceSession: string;
  dailySet: string;
  heldOutSet: string;
  safetySet: string;
  openReport: string;
  editCase: string;
  caseCost: string;
}

export const evalCaseDrawerZh = {
  caseDrawer: {
    title: '单题证据', close: '关闭证据抽屉', loading: '正在读取本题证据…', loadFailed: '本题证据暂时无法读取：{message}',
    status: { passed: '通过', failed: '失败', infra: '环境故障', invalid: '判废', skipped: '跳过', costExceeded: '成本超限', notRun: '未执行', partial: '部分通过', error: '出错' },
    conclusion: '{status} · {reason}',
    conversation: '对话', representativeAttempt: '按代表尝试', selectedAttempt: '第 {index} 次 · {status} · score {score}',
    unstable: '{total} 次 {passed} 过 {failed} 挂 → 这题不稳，按失败处理',
    mixedTrials: '{total} 次 {passed} 过 {failed} 挂，{excluded} 次未形成有效执行 → {judgement}',
    excludedTrials: '{total} 次均未形成有效执行（{status}）',
    promptVersion: '系统提示词 · {version}', productionDefault: '产线默认', input: '输入', actualOutput: '实际输出',
    responseExcerpt: '末尾 {shown} 字 · 全文 {total} 字', toolsCollapsed: '调用了 {count} 个工具 · 展开', toolsExpanded: '调用了 {count} 个工具 · 收起',
    toolOk: '成功', toolFailed: '失败：{error}', toolFailureMissing: '未记录错误详情', simulatorRule: '模拟器 · {rule}', toolsTruncated: '另 {count} 次调用未记录',
    noProcessEvidence: '这轮没有留下过程证据（旧版本跑的），重跑一轮就有', noPromptEvidence: '本轮没有记录输入', noOutputEvidence: '本轮没有记录实际输出',
    checks: '判定结果', checkName: '判定', expected: '期望', actual: '实际', score: 'score {score}', scoreColumn: '分数',
    checkSummary: '{total} 条判定 {passed} 过 {failed} 挂 → {judgement}', judgedPassed: '判通过', judgedFailed: '判失败',
    excludedExplanation: '本题不计入通过率（{status}），不是能力失败。通过率按总数减去跳过、环境故障和成本超限后计算。', excludedShort: '不计入通过率',
    excludedFailure: '错误摘要：{reason}', aiReview: 'AI 评审', aiReviewNote: '并列 · 不进通过率',
    verdict: { yes: '是', no: '否', unavailable: '不可用' }, source: '来源', sourceManual: '手写', sourceSession: '从会话转成题目',
    dailySet: '日常集', heldOutSet: '留出集', safetySet: '安全集', openReport: '打开本轮报告', editCase: '在题库中编辑',
    caseCost: '本题实付 {cost}',
  } satisfies EvalCaseDrawerLabels,
};

export const evalCaseDrawerEn = {
  caseDrawer: {
    title: 'Case evidence', close: 'Close case evidence', loading: 'Loading case evidence…', loadFailed: 'Case evidence is unavailable: {message}',
    status: { passed: 'Passed', failed: 'Failed', infra: 'Environment issue', invalid: 'Invalid', skipped: 'Skipped', costExceeded: 'Cost limit reached', notRun: 'Not run', partial: 'Partially passed', error: 'Error' },
    conclusion: '{status} · {reason}',
    conversation: 'Conversation', representativeAttempt: 'Representative attempt', selectedAttempt: 'Attempt {index} · {status} · score {score}',
    unstable: '{total} attempts: {passed} passed, {failed} failed → unstable, treated as failed',
    mixedTrials: '{total} attempts: {passed} passed, {failed} failed, {excluded} produced no valid execution → {judgement}',
    excludedTrials: 'All {total} attempts produced no valid execution ({status})',
    promptVersion: 'System prompt · {version}', productionDefault: 'Production default', input: 'Input', actualOutput: 'Actual output',
    responseExcerpt: 'Last {shown} characters · {total} total', toolsCollapsed: '{count} tool calls · Expand', toolsExpanded: '{count} tool calls · Collapse',
    toolOk: 'Succeeded', toolFailed: 'Failed: {error}', toolFailureMissing: 'No error detail was recorded', simulatorRule: 'Simulator · {rule}', toolsTruncated: '{count} additional calls were not recorded',
    noProcessEvidence: 'This run left no process evidence (older version). Rerun it to capture evidence.', noPromptEvidence: 'No input was recorded for this run', noOutputEvidence: 'No actual output was recorded for this run',
    checks: 'Check results', checkName: 'Check', expected: 'Expected', actual: 'Actual', score: 'score {score}', scoreColumn: 'score',
    checkSummary: '{total} checks, {passed} passed, {failed} failed → {judgement}', judgedPassed: 'passed', judgedFailed: 'failed',
    excludedExplanation: 'This case is excluded from the pass rate ({status}); it is not an ability failure. The pass rate excludes skipped cases, environment issues, and cost-limit cases.', excludedShort: 'Excluded from pass rate',
    excludedFailure: 'Error summary: {reason}', aiReview: 'AI review', aiReviewNote: 'Parallel result · excluded from pass rate',
    verdict: { yes: 'Yes', no: 'No', unavailable: 'Unavailable' }, source: 'Source', sourceManual: 'Written manually', sourceSession: 'Created from a session',
    dailySet: 'Daily set', heldOutSet: 'Held-out set', safetySet: 'Safety set', openReport: 'Open run report', editCase: 'Edit in case bank',
    caseCost: 'This case {cost}',
  } satisfies EvalCaseDrawerLabels,
};
