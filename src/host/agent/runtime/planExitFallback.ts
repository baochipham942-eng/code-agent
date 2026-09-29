// ============================================================================
// PlanExitFallback — ADR-074 slice 1（N-PLANEXIT-K1）
//
// plan mode 里模型交出结构化计划正文却没调 exit_plan_mode 时的兜底判定：
//   - isStructuredPlanText：只看结构与标点的正文判据（≥2 条列表步骤、非提问为主），
//     不含任何动作词/目标词词表（判据按 ADR-074 拍板修订，误判代价只是一次提醒）。
//   - planExitFallbackStep：在文本响应即将结束 run 时判一次；首次命中注入一次提醒、
//     允许一轮补推理，预算绑定 runKey（同 run 至多一次，换 run 重新发）。
//   - isWriteBlockedDuringPlanExitFallback：补推理期间写类工具在 admission 层拒绝。
//
// K2 的合成审批卡不在本刀：补推理仍是纯文本时按今日语义收尾，只留 not_applicable trace。
// ============================================================================

/** 判据阈值（命名常量；行为经 planExitFallbackStep 公共入口测试，不单独导出）。 */
const MIN_LIST_STEPS = 2;
/** 提问为主的判定上限：提问项占比严格大于该值才算「提问为主」。 */
const MAX_QUESTION_ITEM_SHARE = 0.5;

/** 有序列表项：`1.` / `1)` / ①…⑳（①=U+2460，⑳=U+2473）。 */
const NUMBERED_LIST_ITEM_PATTERN = /^\s{0,3}(?:\d{1,3}[.)]\s+|[①-⑳])/;
/** 无序列表项：`-` / `*` / `•`，标记后须跟空白。 */
const BULLET_LIST_ITEM_PATTERN = /^\s{0,3}[-*•]\s+/;
/** 提问项：行尾为半角/全角问号。 */
const QUESTION_ITEM_PATTERN = /[?？]\s*$/;
/** 围栏代码块：块内的编号/符号行不是正文列表步骤。 */
const FENCED_CODE_BLOCK_PATTERN = /^[ \t]*```[^\n]*\n[\s\S]*?\n[ \t]*```[ \t]*$/gm;

interface PlanTextStructure {
  readonly isPlanText: boolean;
  readonly listItemCount: number;
  readonly questionItemCount: number;
}

/**
 * ADR-074 判据第 2、3 条：规范化正文至少两条有序/无序列表步骤（标题下两条以上列表项
 * 是它的子集——计数不要求同标题），且列表项不以后缀问号为主（多数提问=澄清，不是计划）。
 * 只看结构与标点；代码围栏内的行不参与计数。
 */
function analyzePlanTextStructure(text: string): PlanTextStructure {
  const normalized = text.replace(FENCED_CODE_BLOCK_PATTERN, '');
  const lines = normalized.split(/\r?\n/);
  const listItems = lines.filter((line) =>
    NUMBERED_LIST_ITEM_PATTERN.test(line) || BULLET_LIST_ITEM_PATTERN.test(line));
  const questionItemCount = listItems.filter((line) => QUESTION_ITEM_PATTERN.test(line)).length;
  const isPlanText = listItems.length >= MIN_LIST_STEPS
    && questionItemCount / listItems.length <= MAX_QUESTION_ITEM_SHARE;
  return { isPlanText, listItemCount: listItems.length, questionItemCount };
}

/** 提醒文案（ADR-074 原文）：计划已识别 → 补调退出工具 → 保持只读。 */
function buildPlanExitReminder(): string {
  return '<plan-exit-fallback>\n'
    + '计划已识别。请调用 `exit_plan_mode` 提交审批；继续保持只读，不要调用写工具。\n'
    + '</plan-exit-fallback>';
}

/** 每 run 一次性预算：runKey 记最近一次已花掉预算的 run，notified 限定 not_applicable 只记一次。 */
export interface PlanExitFallbackState {
  runKey: string | undefined;
  spent: boolean;
  notified: boolean;
}

export function createPlanExitFallbackState(): PlanExitFallbackState {
  return { runKey: undefined, spent: false, notified: false };
}

/** trace 事件 `plan_exit_fallback_detected` 载荷（turnTrace.ts 的 TraceEventDataMap 同形引用）。 */
export interface PlanExitFallbackDetectedData {
  readonly textLength: number;
  readonly structureReason: string;
  readonly exitToolCalled: false;
  readonly runKey: string;
}

/** trace 事件 `plan_exit_fallback_not_applicable` 载荷：补推理没换来退出工具，按今日语义收尾。 */
export interface PlanExitFallbackNotApplicableData {
  readonly retryCount: 1;
  readonly runKey: string;
  readonly textLength: number;
}

export interface PlanExitFallbackStepInput {
  readonly state: PlanExitFallbackState;
  /** 响应只取判据需要的字段；type 为 'text' 且带 toolCalls 的混合形态按「有工具调用」处理。 */
  readonly response: {
    readonly type: string;
    readonly content?: string;
    readonly toolCalls?: readonly unknown[];
  };
  readonly planModeActive: boolean;
  readonly forcedFinalPass: boolean;
  readonly cancelled: boolean;
  /** 当前 run 的标识（runTraceContext.runId 优先，回落 loop 自身 runId）；拿不到则不触发。 */
  readonly runKey: string | undefined;
  readonly emitDetected: (data: PlanExitFallbackDetectedData) => void;
  readonly emitNotApplicable: (data: PlanExitFallbackNotApplicableData) => void;
  readonly remind: (reminderText: string) => void;
}

export type PlanExitFallbackOutcome = 'reminded' | 'not-applicable' | 'none';

/**
 * 触发条件（全部满足才提醒）：plan mode 激活、非取消、非强制收尾、有 runKey、
 * 纯文本响应（非空且无任何工具调用）、结构判据命中、当前 run 预算未花。
 * 预算已花时补推理的落选文本只记一次 not_applicable，然后维持今日收尾语义。
 */
export function planExitFallbackStep(input: PlanExitFallbackStepInput): PlanExitFallbackOutcome {
  if (!input.planModeActive || input.cancelled || input.forcedFinalPass) return 'none';
  if (typeof input.runKey !== 'string' || input.runKey.length === 0) return 'none';
  const { response } = input;
  if (response.type !== 'text' || !response.content?.trim()) return 'none';
  if ((response.toolCalls?.length ?? 0) > 0) return 'none';

  if (input.state.spent && input.state.runKey === input.runKey) {
    if (!input.state.notified) {
      input.state.notified = true;
      input.emitNotApplicable({
        retryCount: 1,
        runKey: input.runKey,
        textLength: response.content.length,
      });
    }
    return 'not-applicable';
  }

  const structure = analyzePlanTextStructure(response.content);
  if (!structure.isPlanText) return 'none';

  input.state.runKey = input.runKey;
  input.state.spent = true;
  input.emitDetected({
    textLength: response.content.length,
    structureReason: `list_items=${structure.listItemCount} question_items=${structure.questionItemCount}`,
    exitToolCalled: false,
    runKey: input.runKey,
  });
  input.remind(buildPlanExitReminder());
  return 'reminded';
}

/** 补推理期间在 admission 层拒绝的写类工具名（小写比较）。K2 再扩连接器/MCP 写边界。 */
const PLAN_EXIT_BLOCKED_TOOL_NAMES = new Set(['write', 'edit', 'append', 'bash']);

export interface PlanExitWriteBlockadeContext {
  readonly control: { readonly planExitFallbackActive: boolean };
}

/**
 * 兜底提醒已发出（补推理进行中）且会话仍在 plan mode 时，写类工具一律在 admission 层
 * 拒绝——plan mode 退出（exit 工具）后旗标仍在，但 planModeActive 已翻 false，放行按
 * 审批后的正常路径走。这是本刀打开的补推理窗口的唯一硬门，不复制 K2 的审批前硬门。
 */
export function isWriteBlockedDuringPlanExitFallback(
  ctx: PlanExitWriteBlockadeContext,
  planModeActive: () => boolean,
  toolName: string,
): boolean {
  return ctx.control.planExitFallbackActive
    && planModeActive()
    && PLAN_EXIT_BLOCKED_TOOL_NAMES.has(toolName.trim().toLowerCase());
}
