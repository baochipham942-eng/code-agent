// ============================================================================
// failedRoundGuard — 连续整轮真实工具调用全部失败则强制收尾
//
// 熔断器只计基础设施类失败，业务失败（非零退出、校验、文件不存在）可以无限连着
// 失败。本守卫按「一轮」计数：一轮 = 一次 executeToolsWithHooks。并行的多次失败
// 仍是一轮。运行时合成的 skipped 结果（强制收尾、BATCH_TERMINATED）不是失败。
// 取消或中途改道留下的 undefined 槽让这一轮中性，不增不减。
// ============================================================================

import type { ToolCall, ToolResult } from '../../../shared/contract';
import { FAILED_ROUND_GUARD } from '../../../shared/constants/circuitBreaker';
import { createLogger } from '../../services/infra/logger';
import type { RuntimeContext } from '../runtime/runtimeContext';

const logger = createLogger('FailedRoundGuard');

const MAX_ERROR_LINES = 3;
const MAX_ERROR_LINE_CHARS = 200;
const MAX_REMEMBERED_TOOL_NAMES = 32;

interface FailedRoundStreak {
  consecutive: number;
  toolNames: string[];
  errorLines: string[];
}

const streaks = new WeakMap<RuntimeContext, FailedRoundStreak>();

function isDisabled(): boolean {
  return process.env[FAILED_ROUND_GUARD.DISABLE_ENV] === '0';
}

function isSkipped(result: ToolResult): boolean {
  return result.metadata?.skipped === true;
}

type RoundClass = 'neutral' | 'reset' | 'failed';

function classifyRound(results: readonly (ToolResult | undefined)[]): RoundClass {
  if (results.some((result) => result === undefined)) return 'neutral';
  if (results.some((result) => result?.success === true)) return 'reset';
  const realFailure = results.some((result) => result?.success === false && result?.metadata?.skipped !== true);
  return realFailure ? 'failed' : 'neutral';
}

function clipErrorLine(toolName: string, error: string | undefined): string {
  const lines = (error ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const last = lines.length > 0 ? lines[lines.length - 1] : 'failed with no error text';
  return `${toolName}: ${last}`.slice(0, MAX_ERROR_LINE_CHARS);
}

function collectFailures(
  toolCalls: readonly ToolCall[],
  results: readonly (ToolResult | undefined)[],
): Array<{ toolName: string; errorLine: string }> {
  const callsById = new Map(toolCalls.map((call) => [call.id, call]));
  const failures: Array<{ toolName: string; errorLine: string }> = [];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (!result || result.success || isSkipped(result)) continue;
    const call = toolCalls[index] ?? callsById.get(result.toolCallId);
    const toolName = call?.name ?? 'unknown';
    failures.push({ toolName, errorLine: clipErrorLine(toolName, result.error) });
  }
  return failures;
}

function buildPrompt(rounds: number, toolNames: string[], errorLines: string[]): string {
  const names = toolNames.length > 0 ? toolNames.join(', ') : 'unknown';
  const errors = errorLines.length > 0
    ? errorLines.map((line) => `- ${line}`).join('\n')
    : '- failed with no error text';
  return [
    '<force-final-response reason="failed-round-guard">',
    `The runtime has stopped further tool use because the last ${rounds} rounds failed entirely.`,
    `Tools that failed: ${names}.`,
    'Last errors:',
    errors,
    'Say what was attempted, what failed, and why in plain prose.',
    'State clearly whether any deliverable file exists. If no deliverable file exists, say so explicitly.',
    'Do not claim success.',
    'Do not call any tool. Do not emit tool-call markup or function-call syntax of any kind. Plain prose only.',
    '</force-final-response>',
  ].join('\n');
}

/**
 * 观察一轮工具结果。非触发路径不改任何模型可见状态。
 * 计数达到阈值时，已有强制收尾原因则不动；否则写入 failed-round-guard 并清零计数。
 */
export function observeFailedToolRound(
  ctx: RuntimeContext,
  toolCalls: readonly ToolCall[],
  results: readonly (ToolResult | undefined)[],
): void {
  if (isDisabled()) return;

  const kind = classifyRound(results);
  if (kind === 'neutral') return;
  if (kind === 'reset') {
    streaks.delete(ctx);
    return;
  }

  const streak = streaks.get(ctx) ?? { consecutive: 0, toolNames: [], errorLines: [] };
  streak.consecutive += 1;
  for (const failure of collectFailures(toolCalls, results)) {
    streak.toolNames.push(failure.toolName);
    streak.errorLines.push(failure.errorLine);
  }
  if (streak.toolNames.length > MAX_REMEMBERED_TOOL_NAMES) {
    streak.toolNames.splice(0, streak.toolNames.length - MAX_REMEMBERED_TOOL_NAMES);
  }
  if (streak.errorLines.length > MAX_ERROR_LINES) {
    streak.errorLines.splice(0, streak.errorLines.length - MAX_ERROR_LINES);
  }
  streaks.set(ctx, streak);

  if (streak.consecutive < FAILED_ROUND_GUARD.MAX_CONSECUTIVE_FAILED_ROUNDS) return;
  if (ctx.control.forceFinalResponseReason) return;

  const rounds = streak.consecutive;
  const toolNames = [...streak.toolNames];
  const errorLines = [...streak.errorLines];
  ctx.control.forceFinalResponse('failed-round-guard', buildPrompt(rounds, toolNames, errorLines));
  ctx.turnTrace?.record('failed_round_guard', { rounds, toolNames });
  logger.warn(
    `failed-round-guard: stopped after ${rounds} consecutive all-failed rounds (${toolNames.join(', ')})`,
  );
  streaks.delete(ctx);
}
