// ============================================================================
// readLoopSeal — 只读循环撞硬阈值后「只封读、放行写」
//
// 夜巡 2026-09-27（FB-253）：连续只读 15 次 → activateForceFinalResponse 清空
// 工具表 → 模型说「Let me generate the .docx」却发不出 Write。本模块把硬阈值
// 从全量 forceFinal 改成读通道封口：READ_ONLY_TOOLS + 只读 Bash 继续拦，
// WRITE_TOOLS / 写文件型 Bash / ppt_generate·docx_generate 等产物工具照常执行。
// 模型若在封口后仍只发读类调用，累计 N 次后再退回原来的全量 forceFinal。
// ============================================================================

import type { ToolCall, ToolResult } from '../../../shared/contract';
import { READ_ONLY_TOOLS, WRITE_TOOLS } from '../loopTypes';
import { isBashToolName } from '../../tools/toolNames';
import { activateForceFinalResponse } from './toolPreflightGuards';
import type { RuntimeContext } from './runtimeContext';

/**
 * 只封读状态下，额外被拦的读类调用次数上限。触发硬阈值的那一次不计入。
 *
 * 取 3：GDPval 撞护栏题在墙后通常只再走一步（写产物）。3 覆盖「多发了一次
 * 只读 + 再试一次」的常见晃神，又不会让卡住的搜索循环把整轮步数烧完。
 * 混批（第 15 次 Read + Write）只激活封口、计数仍为 0，Write 能落盘。
 */
const MAX_BLOCKED_READS_WHILE_READ_SEALED = 3;

const READ_LOOP_HARD_LIMIT_REASON_PREFIX = '连续只读操作达到硬阈值';

const DELIVERABLE_GENERATE_TOOLS = new Set([
  'ppt_generate',
  'docx_generate',
  'excel_generate',
  'pdf_generate',
  'chart_generate',
]);

export function isReadLikeToolCall(
  ctx: Pick<RuntimeContext, 'antiPatternDetector'>,
  toolCall: Pick<ToolCall, 'name' | 'arguments'>,
): boolean {
  if (READ_ONLY_TOOLS.includes(toolCall.name)) return true;
  if (!isBashToolName(toolCall.name)) return false;
  const command = typeof toolCall.arguments?.command === 'string' ? toolCall.arguments.command : '';
  if (!command) return false;
  // 可选链：detector 没有 isReadOnlyShellCommand 时不当成读类（封口期间仍可执行）。
  // 解封走 isWriteClassToolCall，缺方法时不会误把 git log 当交付。
  return Boolean(ctx.antiPatternDetector.isReadOnlyShellCommand?.(command));
}

export function isWriteClassToolCall(
  ctx: Pick<RuntimeContext, 'antiPatternDetector'>,
  toolCall: Pick<ToolCall, 'name' | 'arguments'>,
): boolean {
  if (WRITE_TOOLS.includes(toolCall.name) || DELIVERABLE_GENERATE_TOOLS.has(toolCall.name)) return true;
  if (!isBashToolName(toolCall.name)) return false;
  const command = typeof toolCall.arguments?.command === 'string' ? toolCall.arguments.command : '';
  if (!command) return false;
  return Boolean(ctx.antiPatternDetector.isMutatingShellCommand?.(command));
}

function buildReadLoopSealError(): string {
  return (
    `${READ_LOOP_HARD_LIMIT_REASON_PREFIX}，调研通道已关闭。请停止调研，基于已经获取到的文件或搜索证据立刻交付：` +
    '写文件 / 生成产物（Write、Edit、写文件型 Bash、ppt/docx/xlsx 生成）。' +
    '不要继续 Read/Glob/Grep/WebSearch/WebFetch 或只读 Bash。若关键证据缺失，明确说明缺失。'
  );
}

function buildReadLoopSealPrompt(): string {
  return [
    '<read-loop-deliver-now reason="read-loop-hard-limit">',
    'The runtime has stopped further research because the session entered a repeated read loop.',
    'Stop researching. Deliver immediately using evidence already in tool results and persistent context.',
    'Write files or generate the artifact now (Write, Edit, write-file Bash, ppt/docx/xlsx generation).',
    'Do not call Read, Glob, Grep, WebSearch, WebFetch, or read-only Bash.',
    'If exact evidence is missing, say which evidence is missing instead of inventing it.',
    '</read-loop-deliver-now>',
  ].join('\n');
}

/**
 * 真实交付成功后解除只封读：WRITE_TOOLS / 写文件型 Bash / 产物生成。
 * git log、curl 等非读也非写的调用不解除，否则 blockedReads 被清零、永远撞不到 forceFinal。
 * 解封时 markSemanticProgress 把 consecutiveReadOps 归零，后续回读自检按 detector 重新计。
 */
export function releaseReadLoopSealAfterSuccessfulWrite(
  ctx: Pick<RuntimeContext, 'control' | 'antiPatternDetector'>,
  toolCall: Pick<ToolCall, 'name' | 'arguments'>,
  success: boolean,
): void {
  if (!success || !ctx.control.readLoopSealActive) return;
  if (!isWriteClassToolCall(ctx, toolCall)) return;
  ctx.control.clearReadLoopSeal();
  ctx.antiPatternDetector.markSemanticProgress?.('read-loop-seal-delivery');
}

export function applyReadLoopHardLimit(
  ctx: RuntimeContext,
  toolCall: Pick<ToolCall, 'id' | 'name'>,
  startTime: number,
  injectPrompt: (content: string) => void,
): ToolResult {
  const alreadySealed = ctx.control.readLoopSealActive;
  if (!alreadySealed) {
    ctx.control.activateReadLoopSeal();
    injectPrompt(buildReadLoopSealPrompt());
  } else {
    const blocked = ctx.control.recordBlockedReadDuringReadLoopSeal();
    if (blocked >= MAX_BLOCKED_READS_WHILE_READ_SEALED) {
      activateForceFinalResponse(
        ctx,
        `${READ_LOOP_HARD_LIMIT_REASON_PREFIX}，只封读后仍连续 ${blocked} 次只读调用`,
      );
    }
  }

  return {
    toolCallId: toolCall.id,
    success: false,
    error: buildReadLoopSealError(),
    duration: Date.now() - startTime,
    metadata: {
      blocked: true,
      skipped: true,
      hardLimitPreflight: true,
      readLoopSeal: true,
      readLoopSealBlockedReads: ctx.control.readLoopSealBlockedReads,
      ...(ctx.control.forceFinalResponseReason
        ? { forceFinalResponseReason: ctx.control.forceFinalResponseReason }
        : {}),
    },
  };
}
