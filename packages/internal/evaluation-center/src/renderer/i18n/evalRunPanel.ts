import type { AiReviewDimension } from '@shared/contract/evaluation';

export interface EvalRunPanelLabels {
  launch: string;
  lastRun: string;
  history: string;
  loading: string;
  emptyTitle: string;
  quickCheck: string;
  scoringDocs: string;
  wizardTitle: string;
  datasetSection: string;
  dailySet: string;
  heldOutSet: string;
  safetySet: string;
  allSet: string;
  tags: string;
  tagCorePath: string;
  tagRecovery: string;
  tagConversation: string;
  tagMultiTurn: string;
  tagSpreadsheet: string;
  tagWeb: string;
  maxCases: string;
  expensiveHint: string;
  safetyUnavailable: string;
  unhardenedNotice: string;
  shapeSection: string;
  productionShape: string;
  scorerSection: string;
  deterministicScorer: string;
  locked: string;
  aiJudge: string;
  nextVersion: string;
  aiReviewColumns: string;
  aiReviewDimensions: Record<AiReviewDimension, string>;
  calibrated: string;
  uncalibrated: string;
  calibrationReasons: Record<'no_record' | 'below_threshold' | 'prompt_changed' | 'not_enough_pairs' | 'superseded' | 'judge_changed', string>;
  needsExpectation: string;
  referenceOnly: string;
  aiReviewEstimatedCost: string;
  estimatedCost: string;
  runAndBill: string;
  confirmRun: string;
  confirmSafety: string;
  cancel: string;
  starting: string;
  runFailed: string;
  runningSet: string;
  stop: string;
  stopping: string;
  waiting: string;
  running: string;
  passed: string;
  failed: string;
  excluded: string;
  skipped: string;
  costExceeded: string;
  noResult: string;
  logTitle: string;
  autoScroll: string;
  jumpToBottom: string;
  runStarted: string;
  caseStarted: string;
  casePassed: string;
  caseFailed: string;
  caseExcluded: string;
  toolsCalled: string;
  skillActivated: string;
  memoryInjected: string;
  subagentSpawned: string;
  runEnded: string;
  quietDegraded: string;
  endedBeforeSubscribe: string;
  incomplete: string;
  complete: string;
  groupHeader: string;
  unknownCaseBank: string;
  runs: string;
  passRate: string;
  compareTitle: string;
  compareNeedTwo: string;
  compareLoading: string;
  regressedCount: string;
  fixedCount: string;
  unchangedCount: string;
  noCaseChanges: string;
  caseStatusRegressed: string;
  caseStatusFixed: string;
  selectForCompare: string;
  incompleteCannotCompare: string;
  refresh: string;
  loadFailed: string;
  baselineGroup: string;
  candidateGroup: string;
}

interface EvalRunPanelDictionary {
  runPanel: EvalRunPanelLabels;
}

export const evalRunPanelZh: EvalRunPanelDictionary = {
  runPanel: {
    launch: '开跑',
    lastRun: '上次：{set} · {model} · 每题 {k} 次',
    history: '历史',
    loading: '加载中…',
    emptyTitle: '还没有任何一轮跑分记录',
    quickCheck: '跑一轮快速检查试试（约 {count} 题 · 预估 {cost}）',
    scoringDocs: '跑分怎么打分？ →',
    wizardTitle: '开跑一轮',
    datasetSection: '评测集',
    dailySet: '日常集',
    heldOutSet: '留出集',
    safetySet: '安全集',
    allSet: '全部题目',
    tags: '标签',
    tagCorePath: '核心路径',
    tagRecovery: '恢复处理',
    tagConversation: '对话',
    tagMultiTurn: '多轮',
    tagSpreadsheet: '表格',
    tagWeb: '网页',
    maxCases: '最多跑 N 题',
    expensiveHint: '超过 50 题，费用会明显增加。可以调小 N 再开跑。',
    safetyUnavailable: '不受控系统环境不可用',
    unhardenedNotice: '另有 {n} 题还没有判定标准，不会跑',
    shapeSection: '本轮形态',
    productionShape: 'skill 集 / 记忆 / swarm：与生产默认相同',
    scorerSection: '打分器',
    deterministicScorer: '判定标准（默认挂上，免费）',
    locked: '不可取消',
    aiJudge: 'AI 评审',
    nextVersion: '下一版',
    aiReviewColumns: '各成一列，不合成综合分',
    aiReviewDimensions: {
      task_completed: '任务完成了吗', tool_choice: '工具选得对吗',
      confirmed_before_acting: '该确认时确认了吗', no_extra_changes: '没干多余的事', self_tested: '自测过没',
    },
    calibrated: '已校准 κ={kappa} · 金标 {pairs} 条',
    uncalibrated: '未校准',
    calibrationReasons: {
      no_record: '无记录', below_threshold: '一致性未达标', prompt_changed: '提示词改过',
      not_enough_pairs: '金标不足 N<20', superseded: '按旧标准，需重跑', judge_changed: '评审模型已变',
    },
    needsExpectation: '这题集没有逐题期望，评审不了',
    referenceOnly: '结果只作参考，不作能力证据',
    aiReviewEstimatedCost: 'AI 评审预估 {cost} = {count} 题 × {k} × {dimensions} 维 × 单价（{model}）',
    estimatedCost: '约 {cost} · 按价格表 v{version}',
    runAndBill: '真跑并计费',
    confirmRun: '再点一次确认：将调用 {model} 跑 {count} 题，预估 {cost}',
    confirmSafety: '5 秒内不确认会自动收回；也可以修改 N 题降低费用',
    cancel: '取消',
    starting: '正在发车…',
    runFailed: '这轮没有成功发车，请检查评测环境后重试。',
    runningSet: '{set} · {model} · 第 {current}/{total} 题 · 已用时 {duration}',
    stop: '停止',
    stopping: '正在停止…',
    waiting: '等待',
    running: '进行中',
    passed: '通过',
    failed: '失败',
    excluded: '不计入通过率（环境故障）',
    skipped: '不计入',
    costExceeded: '不计入（成本超限）',
    noResult: '等待结果',
    logTitle: '运行记录',
    autoScroll: '自动滚动到底',
    jumpToBottom: '回到底部',
    runStarted: '开始这一轮',
    caseStarted: '开始 {caseId}',
    casePassed: '{caseId} 通过',
    caseFailed: '{caseId} 没通过：{reason}',
    caseExcluded: '{caseId} 不计入通过率（环境故障）',
    toolsCalled: '{caseId} 调用了 {count} 个工具',
    skillActivated: '{caseId} 使用了 skill {name}',
    memoryInjected: '{caseId} 已带入相关记忆',
    subagentSpawned: '{caseId} 已请协作者处理一部分任务',
    runEnded: '这一轮已结束',
    quietDegraded: '这轮没有正常结束，已按已跑完的题记录',
    endedBeforeSubscribe: '这轮已结束，去历史看',
    incomplete: '未跑满',
    complete: '完成',
    groupHeader: '{set} · 每题 {k} 次 · 题库 {sha}',
    unknownCaseBank: '未知版本',
    runs: '{count} 轮',
    passRate: '通过率',
    compareTitle: '所选两轮对比',
    compareNeedTwo: '在同一组里选择两轮才能对比。',
    compareLoading: '正在加载对比结果…',
    regressedCount: '新增失败 {n}',
    fixedCount: '转通过 {n}',
    unchangedCount: '不变 {n}',
    noCaseChanges: '题目状态没有变化',
    caseStatusRegressed: '退步',
    caseStatusFixed: '进步',
    selectForCompare: '选择这轮用于对比',
    incompleteCannotCompare: '未跑满的轮次不能用于对比',
    refresh: '刷新',
    loadFailed: '加载失败：{message}',
    baselineGroup: '对照组',
    candidateGroup: '实验组',
  },
};

export const evalRunPanelEn: EvalRunPanelDictionary = {
  runPanel: {
    launch: 'Run',
    lastRun: 'Last: {set} · {model} · {k} time(s) per case',
    history: 'History',
    loading: 'Loading…',
    emptyTitle: 'No benchmark run has been recorded yet',
    quickCheck: 'Try a quick check (about {count} cases · estimated {cost})',
    scoringDocs: 'How are runs scored? →',
    wizardTitle: 'Start a run',
    datasetSection: 'Eval set',
    dailySet: 'Daily set',
    heldOutSet: 'Held-out set',
    safetySet: 'Safety set',
    allSet: 'All cases',
    tags: 'Tags',
    tagCorePath: 'Core path',
    tagRecovery: 'Recovery',
    tagConversation: 'Conversation',
    tagMultiTurn: 'Multi-turn',
    tagSpreadsheet: 'Spreadsheet',
    tagWeb: 'Web',
    maxCases: 'Maximum cases',
    expensiveHint: 'More than 50 cases will increase cost noticeably. Lower the limit before running if needed.',
    safetyUnavailable: 'Unavailable without a controlled system environment',
    unhardenedNotice: '{n} more cases have no criteria yet and will not run',
    shapeSection: 'Run shape',
    productionShape: 'Skills / memory / swarm: same as production defaults',
    scorerSection: 'Scorers',
    deterministicScorer: 'Assertions (included by default, free)',
    locked: 'Required',
    aiJudge: 'AI review',
    nextVersion: 'Next version',
    aiReviewColumns: 'Separate columns, never combined into an overall score',
    aiReviewDimensions: {
      task_completed: 'Was the task completed?', tool_choice: 'Were the right tools chosen?',
      confirmed_before_acting: 'Was confirmation requested when needed?', no_extra_changes: 'Were extra changes avoided?', self_tested: 'Was the result self-tested?',
    },
    calibrated: 'Calibrated κ={kappa} · {pairs} gold labels',
    uncalibrated: 'Uncalibrated',
    calibrationReasons: {
      no_record: 'No record', below_threshold: 'Agreement below requirement', prompt_changed: 'Prompt changed',
      not_enough_pairs: 'Not enough gold labels N<20', superseded: 'Old standard; rerun required', judge_changed: 'Review model changed',
    },
    needsExpectation: 'This case set has no per-case expectation for this review',
    referenceOnly: 'Reference only; not capability evidence',
    aiReviewEstimatedCost: 'AI review estimate {cost} = {count} cases × {k} × {dimensions} dimensions × unit price ({model})',
    estimatedCost: 'About {cost} · pricing table v{version}',
    runAndBill: 'Run and incur charges',
    confirmRun: 'Click again to confirm: call {model} for {count} cases, estimated {cost}',
    confirmSafety: 'Confirmation resets after 5 seconds; lower the case limit to reduce cost',
    cancel: 'Cancel',
    starting: 'Starting…',
    runFailed: 'The run did not start. Check the evaluation environment and try again.',
    runningSet: '{set} · {model} · case {current}/{total} · elapsed {duration}',
    stop: 'Stop',
    stopping: 'Stopping…',
    waiting: 'Waiting',
    running: 'Running',
    passed: 'Passed',
    failed: 'Failed',
    excluded: 'Excluded from pass rate (environment issue)',
    skipped: 'Excluded',
    costExceeded: 'Excluded (cost limit reached)',
    noResult: 'Waiting for result',
    logTitle: 'Run log',
    autoScroll: 'Auto-scroll to bottom',
    jumpToBottom: 'Jump to bottom',
    runStarted: 'Run started',
    caseStarted: 'Started {caseId}',
    casePassed: '{caseId} passed',
    caseFailed: '{caseId} failed: {reason}',
    caseExcluded: '{caseId} excluded from pass rate (environment issue)',
    toolsCalled: '{caseId} called {count} tools',
    skillActivated: '{caseId} used skill {name}',
    memoryInjected: '{caseId} received relevant memory',
    subagentSpawned: '{caseId} delegated part of the task',
    runEnded: 'Run ended',
    quietDegraded: 'This run did not end normally; completed cases were recorded',
    endedBeforeSubscribe: 'This run has ended; see History',
    incomplete: 'Incomplete',
    complete: 'Complete',
    groupHeader: '{set} · {k} time(s) per case · case bank {sha}',
    unknownCaseBank: 'unknown case bank',
    runs: '{count} runs',
    passRate: 'Pass rate',
    compareTitle: 'Selected runs compared',
    compareNeedTwo: 'Select two runs in the same group to compare.',
    compareLoading: 'Loading comparison…',
    regressedCount: '{n} newly failed',
    fixedCount: '{n} newly passed',
    unchangedCount: '{n} unchanged',
    noCaseChanges: 'No case status changes',
    caseStatusRegressed: 'Regressed',
    caseStatusFixed: 'Improved',
    selectForCompare: 'Select this run for comparison',
    incompleteCannotCompare: 'Incomplete runs cannot be compared',
    refresh: 'Refresh',
    loadFailed: 'Load failed: {message}',
    baselineGroup: 'Control',
    candidateGroup: 'Candidate',
  },
};
