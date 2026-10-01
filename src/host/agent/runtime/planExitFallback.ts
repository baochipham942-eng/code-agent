// ============================================================================
// PlanExitFallback — ADR-074 slice 1（N-PLANEXIT-K1）+ slice 2 判定（N-PLANEXIT-K2）
//
// plan mode 里模型交出结构化计划正文却没调 exit_plan_mode 时的兜底判定：
//   - isStructuredPlanText：只看结构与标点的正文判据（≥2 条列表步骤、非提问为主），
//     不含任何动作词/目标词词表（判据按 ADR-074 拍板修订，误判代价只是一次提醒）。
//   - planExitFallbackStep：在文本响应即将结束 run 时判一次；首次命中注入一次提醒、
//     允许一轮补推理，预算绑定 runKey（同 run 至多一次，换 run 重新发）。
//     补推理仍是结构化正文 → 判 synthesize（K2：宿主合成同形审批卡，见 planExitFallbackCard）。
//   - isWriteBlockedDuringPlanExitFallback：兜底窗口内的工具面收成 allowlist——
//     只放读类、只读 Bash、退出工具与提问工具，其余（含 MCP 未知名、连接器写、
//     子代理、产物生成器）一律 admission 拒绝，未知名 fail closed。
// ============================================================================

import type { ToolCall } from '../../../shared/contract';
import { READ_ONLY_TOOLS } from '../loopTypes';
import { isReadLikeToolCall } from './readLoopSeal';

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

/** 每 run 一次性预算：runKey 记最近一次已花掉预算的 run，notified 限定 not_applicable 只记一次，synthesized 限定每 run 至多合成一张卡。 */
export interface PlanExitFallbackState {
  runKey: string | undefined;
  spent: boolean;
  notified: boolean;
  synthesized: boolean;
}

export function createPlanExitFallbackState(): PlanExitFallbackState {
  return { runKey: undefined, spent: false, notified: false, synthesized: false };
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

export type PlanExitFallbackOutcome = 'reminded' | 'synthesize' | 'not-applicable' | 'none';

/**
 * 触发条件（全部满足才提醒）：plan mode 激活、非取消、非强制收尾、有 runKey、
 * 纯文本响应（非空且无任何工具调用）、结构判据命中、当前 run 预算未花。
 * 预算已花时：补推理仍是结构化计划正文 → synthesize（每 run 至多一次，卡由 K2 合成器落）；
 * 澄清/拒绝/非计划正文只记一次 not_applicable，然后维持今日收尾语义。
 */
export function planExitFallbackStep(input: PlanExitFallbackStepInput): PlanExitFallbackOutcome {
  if (!input.planModeActive || input.cancelled || input.forcedFinalPass) return 'none';
  if (typeof input.runKey !== 'string' || input.runKey.length === 0) return 'none';
  const { response } = input;
  if (response.type !== 'text' || !response.content?.trim()) return 'none';
  if ((response.toolCalls?.length ?? 0) > 0) return 'none';

  if (input.state.spent && input.state.runKey === input.runKey) {
    if (!input.state.synthesized && analyzePlanTextStructure(response.content).isPlanText) {
      input.state.synthesized = true;
      return 'synthesize';
    }
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

/**
 * 兜底窗口内显式放行的非读类工具：退出工具两形态与提问工具。读类（READ_ONLY_TOOLS
 * 全表 + 只读 Bash）经 isReadLikeToolCall 放行；不在放行面内的一律拒绝——MCP 未知名、
 * 连接器写、子代理、产物生成器、写类与写文件型 Bash 全部落回 TOOL_DISABLED_FOR_RUN。
 */
const PLAN_EXIT_ALLOWED_TOOL_NAMES = new Set(['exit_plan_mode', 'PlanMode', 'AskUserQuestion']);

export interface PlanExitWriteBlockadeContext {
  readonly control: { readonly planExitFallbackActive: boolean };
  /** 只读 Bash 判定用（isReadLikeToolCall 内部带可选链，缺成员时不当只读，仍拒绝）。 */
  readonly antiPatternDetector: { isReadOnlyShellCommand?: (command: string) => boolean };
}

/**
 * 兜底提醒已发出（补推理进行中）且会话仍在 plan mode 时，工具面收成 allowlist：
 * 读类/只读 Bash/退出工具/提问工具放行，其余一律 admission 拒绝（未知名 fail closed）。
 * plan mode 退出（exit 工具）后旗标仍在，但 planModeActive 已翻 false，放行按
 * 审批后的正常路径走。审批前硬门不在此复制：外部引擎写回由 N-PLANEXIT-K3 收口。
 */
export function isWriteBlockedDuringPlanExitFallback(
  ctx: PlanExitWriteBlockadeContext,
  planModeActive: () => boolean,
  toolCall: Pick<ToolCall, 'name' | 'arguments'>,
): boolean {
  if (!ctx.control.planExitFallbackActive || !planModeActive()) return false;
  if (PLAN_EXIT_ALLOWED_TOOL_NAMES.has(toolCall.name)) return false;
  return !isReadLikeToolCall(ctx, toolCall);
}
