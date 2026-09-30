// ============================================================================
// toolStepGuardRails — 工具步防护编排（N-JEV-WARDEN-MOCK）
// ============================================================================
// 从 conversationRuntime 抽出的「工具步 recordStep → abort 交还 → 执行 →
// recordResults → nudge 注入」整段，行为与改动前逐条一致（DoomLoopGuard
// nudge 顺序不变：L1/L2 nudge 先于信号 nudge）。JevWarden 挂在末尾
// （验收①：工具结果 recordResults 之后），开关关时 verdict 恒 none，零差异。

import { createLogger } from '../../services/infra/logger';
import type { ContextInjectionSource } from '../../../shared/contract/contextView';
import type { RuntimeContext } from './runtimeContext';
import {
  collectGuardStepResults,
  noteGuardSignals,
  type DoomLoopGuard,
  type GuardToolCall,
} from './doomLoopGuard';
import { settleDoomLoopHandback } from './doomLoopHandback';
import type { JevWarden, JevWardenStepInput } from './jevWarden';

const logger = createLogger('AgentLoop');

export type ToolStepGuardOutcome = 'proceed' | 'retry' | 'abort';

export interface ToolStepGuardRailsArgs<TToolAction> {
  ctx: RuntimeContext;
  guard: DoomLoopGuard;
  warden: JevWarden;
  toolCalls: GuardToolCall[];
  /** 本步助手文本（tool_use 步可能带正文），给 warden 的 fake_done 规则。 */
  assistantText?: string;
  iterations: number;
  inject: (text: string, source: ContextInjectionSource) => void;
  /** 执行本步工具（messageProcessor.handleToolResponse），返回其动作。 */
  runTools: (messagesBeforeTools: number) => Promise<TToolAction>;
}

export async function runToolStepGuardRails<TToolAction>(
  args: ToolStepGuardRailsArgs<TToolAction>,
): Promise<{ outcome: ToolStepGuardOutcome; toolAction?: TToolAction }> {
  const { ctx, guard, warden, iterations, inject } = args;
  // L1 同名同参 ×3 → 强警告；警告后仍重复 → 中止交还用户；L2 整步签名 ×3 → nudge
  const doomCheck = guard.recordStep(args.toolCalls);
  if (doomCheck.level === 'doom-loop-abort') {
    const action = await settleDoomLoopHandback(ctx, guard, iterations, (text) => {
      inject(text, 'stagnation-guard');
    });
    return { outcome: action === 'retry' ? 'retry' : 'abort' };
  }
  const messagesBeforeTools = ctx.messages.length;
  const toolAction = await args.runTools(messagesBeforeTools);
  const stepResults = collectGuardStepResults(ctx.messages, messagesBeforeTools);
  const signalHit = guard.recordResults(stepResults);
  if (signalHit.signals.length > 0) noteGuardSignals(ctx.turnTrace, signalHit.signals);
  for (const nudge of [doomCheck.nudge, signalHit.nudge]) {
    if (!nudge) continue;
    logger.warn(`[DoomLoopGuard] ${nudge === doomCheck.nudge ? doomCheck.level : signalHit.signals.join(',')} detected; injecting nudge`);
    inject(nudge, 'stagnation-guard');
  }
  // JevWarden（验收①挂点：工具结果 recordResults 之后）。规则先判、命中才问。
  // 审查 R2 #4：本步已取消/中断时跳过判官——用户已停，不再等 Jev 请求。
  if (ctx.control.isCancelled || ctx.control.isInterrupted) return { outcome: 'proceed', toolAction };
  const wardenInput: JevWardenStepInput = {
    guardLevel: doomCheck.level,
    guardSignals: signalHit.signals,
    stepResults,
    assistantText: args.assistantText,
    signal: ctx.control.runAbortController?.signal,
  };
  const verdict = await warden.reviewToolStep(wardenInput);
  if (verdict.kind === 'nudge') {
    logger.warn(`[JevWarden] ${verdict.rule} confirmed; injecting steering nudge`);
    inject(verdict.text, 'jev-warden');
  } else if (verdict.kind === 'force_wrap_up') {
    logger.warn(`[JevWarden] ${verdict.rule} confirmed; forcing wrap-up handback`);
    ctx.control.forceFinalResponse(verdict.reason, verdict.prompt);
  }
  return { outcome: 'proceed', toolAction };
}
