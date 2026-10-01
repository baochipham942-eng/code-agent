// ============================================================================
// PlanExitFallbackCard — ADR-074 slice 2（N-PLANEXIT-K2）
//
// 补推理仍是结构化计划正文（planExitFallbackStep 判 synthesize）时，宿主从同一段
// 正文合成与 exitPlanMode 同形的审批卡：
//   - buildSyntheticPlanApprovalToolCall：纯构造器——卡片正文逐字取自最终响应正文，
//     metadata 与 executeExitPlanMode 同形，planApproval.source 标记 synthetic_text。
//   - settlePlanExitFallbackOnTextBreak：conversationRuntime 文本收尾分支的完整兜底
//     落点——先走 K1 判定（提醒/not_applicable 语义不变），判 synthesize 时落卡消息
//     （新持久化 assistant 消息 + 正常 message 事件宣布，renderer 无新 ingest 路径），
//     并按 shouldEndRunForPlanApproval 这一唯一谓词决定是否出卡（autoApprovePlan=true
//     跳过合成，维持今日语义）。run 边界与模型退出路径同一处：落卡即收尾，不再推理。
// ============================================================================

import type { Message, ToolCall, ToolResult } from '../../../shared/contract';
import {
  createPendingPlanApproval,
  PLAN_APPROVAL_CONFIRMATION_TYPE,
} from '../../../shared/contract/planApproval';
import { buildExitPlanModeOutput } from '../../tools/modules/planning/exitPlanMode';
import { exitPlanModeSchema } from '../../tools/modules/planning/exitPlanMode.schema';
import type { RuntimeContext } from './runtimeContext';
import { shouldEndRunForPlanApproval } from './planApprovalRunBoundary';
import { planExitFallbackStep, type PlanExitFallbackOutcome, type PlanExitFallbackState } from './planExitFallback';

/** trace 事件 `plan_exit_fallback_synthesized` 载荷（turnTrace.ts 的 TraceEventDataMap 同形引用）。 */
export interface PlanExitFallbackSynthesizedData {
  readonly runKey: string;
  readonly retryCount: 1;
  readonly cardId: string;
  readonly source: 'synthetic_text';
  readonly textLength: number;
}

interface SyntheticPlanApprovalToolCall {
  readonly toolCall: ToolCall;
  readonly result: ToolResult;
}

/**
 * 合成卡的 toolCallId / trace cardId：绑定 runKey，run 内天然唯一、跨 run 不撞。
 */
function syntheticPlanCardId(runKey: string): string {
  return `synthetic-plan-${runKey}`;
}

/**
 * 纯构造器：与 executeExitPlanMode 的成功结果同形（output 文案、requiresUserConfirmation、
 * confirmationType、plan、planApproval 全套），只多 planApproval.source = 'synthetic_text'。
 * 正文（metadata.plan / planApproval.originalPlan）逐字保留调用方传入的响应正文。
 * 模块内私有：外部行为经 settlePlanExitFallbackOnTextBreak 测试（生产档棘轮禁测试专用导出）。
 */
function buildSyntheticPlanApprovalToolCall(plan: string, runKey: string): SyntheticPlanApprovalToolCall {
  const id = syntheticPlanCardId(runKey);
  const result: ToolResult = {
    toolCallId: id,
    success: true,
    output: buildExitPlanModeOutput(plan),
    metadata: {
      requiresUserConfirmation: true,
      confirmationType: PLAN_APPROVAL_CONFIRMATION_TYPE,
      plan,
      planApproval: { ...createPendingPlanApproval(plan), source: 'synthetic_text' },
    },
  };
  return {
    toolCall: { id, name: exitPlanModeSchema.name, arguments: { plan }, result },
    result,
  };
}

/** settle 需要的宿主窄面：控制旗标、审批自动批准开关、事件出口与 turn trace。 */
type PlanExitFallbackSettleContext = Pick<RuntimeContext, 'control' | 'autoApprovePlan' | 'onEvent' | 'turnTrace'>;

/** settle 需要的装配窄面：落卡消息持久化与消息 id 生成。 */
interface PlanExitFallbackSettleAssembly {
  addAndPersistMessage(message: Message): Promise<unknown>;
  generateId(): string;
}

export interface SettlePlanExitFallbackInput {
  readonly ctx: PlanExitFallbackSettleContext;
  readonly assembly: PlanExitFallbackSettleAssembly;
  readonly state: PlanExitFallbackState;
  readonly response: {
    readonly type: string;
    readonly content?: string;
    readonly toolCalls?: readonly unknown[];
  };
  readonly planModeActive: boolean;
  readonly forcedFinalPass: boolean;
  readonly runKey: string | undefined;
  /** 提醒注入留在 conversationRuntime（注入点计数/全景锚点不因本模块挪位）。 */
  readonly remind: (reminderText: string) => void;
}

/**
 * 文本收尾分支的兜底落点。返回值语义与 planExitFallbackStep 一致；判 synthesize 时
 * 同步完成落卡（autoApprovePlan=true 时不落卡直接返回），调用方收到除 'reminded' 外
 * 的任何结果都应结束 run——与模型退出审批的 run 边界同形，落卡后不再有下一轮推理。
 */
export async function settlePlanExitFallbackOnTextBreak(input: SettlePlanExitFallbackInput): Promise<PlanExitFallbackOutcome> {
  const outcome = planExitFallbackStep({
    state: input.state,
    response: input.response,
    planModeActive: input.planModeActive,
    forcedFinalPass: input.forcedFinalPass,
    cancelled: input.ctx.control.isCancelled,
    runKey: input.runKey,
    emitDetected: (data) => input.ctx.turnTrace.record('plan_exit_fallback_detected', data),
    emitNotApplicable: (data) => input.ctx.turnTrace.record('plan_exit_fallback_not_applicable', data),
    remind: input.remind,
  });
  if (outcome !== 'synthesize') return outcome;

  const runKey = input.runKey ?? '';
  const planText = input.response.content ?? '';
  const { toolCall, result } = buildSyntheticPlanApprovalToolCall(planText, runKey);
  // 唯一 run 边界谓词：autoApprovePlan（CLI/测试自动批准链路）下不出卡，维持今日语义。
  if (!shouldEndRunForPlanApproval([result], input.ctx.autoApprovePlan)) return outcome;

  const cardMessage: Message = {
    id: input.assembly.generateId(),
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    toolCalls: [toolCall],
  };
  await input.assembly.addAndPersistMessage(cardMessage);
  input.ctx.turnTrace.record('plan_exit_fallback_synthesized', {
    runKey,
    retryCount: 1,
    cardId: toolCall.id,
    source: 'synthetic_text',
    textLength: planText.length,
  });
  input.ctx.onEvent({ type: 'message', data: cardMessage });
  return outcome;
}
