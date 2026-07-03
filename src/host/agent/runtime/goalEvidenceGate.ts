// ============================================================================
// Goal Evidence Gate（闸0）— attempt_completion 的公开证据自证核验
//
// maka-agent self-check gate 借鉴：正式验证（闸1 verifyCommand / 闸2 review）之前，
// 先程序化核验模型自报的公开证据——产物文件真实存在、关键命令真的在本会话执行过。
// 零 LLM 成本。证据不足按闸1 同款有界语义打回（最多 EVIDENCE_GATE_MAX_BOUNCES 次），
// 打回预算用尽后放行进闸1/闸2（闸0 是前置增强，不设新的死锁面）。
// ============================================================================

import { statSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import type { ToolCall } from '../../../shared/contract';
import { GOAL_MODE } from '../../../shared/constants/agent';
import { makeEvidenceRef, type EvidenceRef } from '../../../shared/contract/evidence';
import type { RuntimeContext } from './runtimeContext';

export interface GoalEvidenceGateResult {
  verdict: 'pass' | 'bounce' | 'exhausted_release';
  reason: string;
  feedback?: string;
  evidenceRefs: EvidenceRef[];
}

interface ClaimedEvidence {
  deliverables: string[];
  commands: string[];
}

function parseClaimedEvidence(completionCall: ToolCall): ClaimedEvidence {
  const raw = completionCall.arguments?.evidence;
  const deliverables: string[] = [];
  const commands: string[] = [];
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    for (const item of Array.isArray(record.deliverables) ? record.deliverables : []) {
      if (typeof item === 'string' && item.trim()) deliverables.push(item.trim());
    }
    for (const item of Array.isArray(record.commands) ? record.commands : []) {
      if (typeof item === 'string' && item.trim()) commands.push(item.trim());
    }
  }
  return { deliverables, commands };
}

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim();
}

/** 收集本会话内实际执行过的 shell 命令（Bash 族工具调用的 command 参数） */
function collectExecutedCommands(ctx: RuntimeContext): string[] {
  const executed: string[] = [];
  for (const message of ctx.messages || []) {
    for (const toolCall of message.toolCalls || []) {
      if (!/^bash$/i.test(toolCall.name || '')) continue;
      const command = toolCall.arguments?.command;
      if (typeof command === 'string' && command.trim()) {
        executed.push(normalizeCommand(command));
      }
    }
  }
  return executed;
}

function commandWasExecuted(claimed: string, executed: string[]): boolean {
  const normalized = normalizeCommand(claimed);
  if (!normalized) return false;
  return executed.some((cmd) => cmd.includes(normalized) || normalized.includes(cmd));
}

/**
 * 闸0 主入口。核验三类证据（有什么核什么，全部命中才 pass）：
 * 1. 模型自报 deliverables → 逐个 fs 核验文件存在
 * 2. 模型自报 commands → 逐条与会话内真实执行过的 Bash 命令匹配
 * 3. declare_deliverables 事先声明的 finalArtifacts（若有）→ 同样核验存在
 * 三类全空 = 只声称不举证 → 打回。
 */
export function runGoalEvidenceGate(
  ctx: RuntimeContext,
  completionCall: ToolCall,
): GoalEvidenceGateResult {
  const claimed = parseClaimedEvidence(completionCall);
  const declaredArtifacts = ctx.declaredDeliverables?.finalArtifacts ?? [];
  const evidenceRefs: EvidenceRef[] = [];
  const problems: string[] = [];

  const filesToVerify = [...new Set([...claimed.deliverables, ...declaredArtifacts])];
  for (const filePath of filesToVerify) {
    const absolutePath = isAbsolute(filePath)
      ? filePath
      : resolve(ctx.workingDirectory || process.cwd(), filePath);
    let exists = false;
    try {
      exists = statSync(absolutePath).isFile();
    } catch {
      exists = false;
    }
    if (exists) {
      evidenceRefs.push(makeEvidenceRef({
        kind: 'file',
        ref: absolutePath,
        source: 'goal-evidence-gate',
        state: 'read',
      }));
    } else {
      const origin = claimed.deliverables.includes(filePath) ? '自报产物' : '事先声明的产物';
      problems.push(`${origin} \`${filePath}\` 在磁盘上不存在（核验路径 ${absolutePath}）。`);
    }
  }

  if (claimed.commands.length > 0) {
    const executed = collectExecutedCommands(ctx);
    for (const command of claimed.commands) {
      if (commandWasExecuted(command, executed)) {
        evidenceRefs.push(makeEvidenceRef({
          kind: 'tool',
          ref: normalizeCommand(command),
          source: 'goal-evidence-gate',
          state: 'read',
        }));
      } else {
        problems.push(`自报命令 \`${command}\` 在本会话的执行记录中找不到——只有真实执行过的命令才能作为证据。`);
      }
    }
  }

  const nothingClaimed = filesToVerify.length === 0 && claimed.commands.length === 0;
  if (nothingClaimed) {
    // 有确定性 verifyCommand 的 goal：闸1 会真验，不为"没自报"多烧两轮打回。
    // 纯软目标（只有 review 闸，LLM 评审可被话术糊弄）才强制自证。
    if (ctx.goalMode?.getVerifyCommand()) {
      return {
        verdict: 'pass',
        reason: 'no self-reported evidence; deferring to deterministic gate 1',
        evidenceRefs,
      };
    }
    problems.push('attempt_completion 没有携带任何可核验证据（evidence.deliverables / evidence.commands 均为空，也没有事先声明产物）。纯软目标必须自证：列出真实存在的产物文件或真正执行过的验证命令。');
  }

  if (problems.length === 0) {
    return {
      verdict: 'pass',
      reason: `evidence verified: ${evidenceRefs.length} ref(s)`,
      evidenceRefs,
    };
  }

  const bounces = (ctx.goalEvidenceGateBounces ?? 0) + 1;
  if (bounces > GOAL_MODE.EVIDENCE_GATE_MAX_BOUNCES) {
    // 打回预算用尽：放行进闸1/闸2（系统侧验证仍在），但把缺口记录在案。
    return {
      verdict: 'exhausted_release',
      reason: `evidence gate bounces exhausted (${GOAL_MODE.EVIDENCE_GATE_MAX_BOUNCES}); releasing to gate 1/2 with ${problems.length} unresolved problem(s)`,
      evidenceRefs,
    };
  }
  ctx.goalEvidenceGateBounces = bounces;

  const feedback = [
    '<goal-evidence-gate-failed>',
    `完成申请被闸0（公开证据核验）打回（第 ${bounces}/${GOAL_MODE.EVIDENCE_GATE_MAX_BOUNCES} 次机会）：`,
    ...problems.map((problem, index) => `${index + 1}. ${problem}`),
    '要通过闸0：重新调用 attempt_completion 并在 evidence.deliverables 里列出真实存在的最终产物路径、在 evidence.commands 里列出本会话真正执行过的关键验证命令。缺什么补什么——先把产物做出来/把验证跑起来，再举证。',
    '</goal-evidence-gate-failed>',
  ].join('\n');

  return {
    verdict: 'bounce',
    reason: problems[0] ?? 'insufficient evidence',
    feedback,
    evidenceRefs,
  };
}
