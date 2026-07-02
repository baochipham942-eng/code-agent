import type { CreateHandoffProposalInput, HandoffProposal } from '../../shared/contract/handoff';
import { createLogger } from '../services/infra/logger';
import { getDatabase } from '../services/core/databaseService';
import { getHandoffProposalService } from './handoffProposalService';
import { buildPriorRunProjection } from './priorRunProjection';

const logger = createLogger('LongTaskRecoveryProposal');

/**
 * retry = projection continuation：把有界现场投影拼进恢复提案 prompt，
 * 新 attempt 直接基于现场续跑，不从 transcript 从头考古。
 */
function priorProjectionSection(projection: string | undefined): string[] {
  if (!projection?.trim()) return [];
  return [
    '--- 上一 run 现场（有界投影，来自 session 一本账）---',
    projection.trim(),
    '--- 现场结束 ---',
    '新 attempt 请直接基于上述现场续跑：优先处理未完成任务与最后失败点，不要从头重读全部历史。',
  ];
}

/**
 * 从 session 一本账派生现场投影（impure 组装口，fail-safe：任何失败返回 undefined，
 * 提案回退为纯文本，绝不因投影失败丢掉恢复提案本体）。
 */
export function buildRecoveryPriorProjection(sessionId: string | undefined): string | undefined {
  if (!sessionId?.trim()) return undefined;
  try {
    const ledger = getDatabase().getSessionLedger(sessionId);
    return buildPriorRunProjection(ledger) ?? undefined;
  } catch (error) {
    logger.warn('buildRecoveryPriorProjection failed (ignored)', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function compact(value: string | undefined, fallback: string): string {
  const normalized = value?.trim().replace(/\s+/g, ' ');
  return normalized && normalized.length > 0 ? normalized : fallback;
}

function stripWorkspacePrefix(task: string): string {
  return task.replace(/^\[工作目录:[^\]]+\]\s*所有文件路径基于此目录。\n\n/, '').trim();
}

export interface WorkflowFailureRecoveryInput {
  sessionId?: string;
  runId: string;
  goal?: string;
  status: string;
  error?: string;
  resumeFromRunId?: string;
  cacheHits?: number;
  phaseCount?: number;
  /** 上一 run 有界现场投影（buildRecoveryPriorProjection 产物），可选 */
  priorProjection?: string;
}

export interface AgentTeamFailureRecoveryInput {
  sessionId?: string;
  sourceMessageId?: string;
  totalTasks: number;
  failedTasks: Array<{
    taskId: string;
    role: string;
    task?: string;
    error?: string;
  }>;
  summary?: string;
  /** 上一 run 有界现场投影（buildRecoveryPriorProjection 产物），可选 */
  priorProjection?: string;
}

export function buildWorkflowFailureRecoveryProposal(
  input: WorkflowFailureRecoveryInput,
): CreateHandoffProposalInput | null {
  if (!input.sessionId?.trim()) return null;

  const titleGoal = compact(input.goal, input.runId).slice(0, 72);
  const retryRunId = compact(input.resumeFromRunId, input.runId);
  const error = compact(input.error, 'unknown error');
  const prompt = [
    '继续这个失败的 workflow，并优先复用已有 journal/replay。',
    `Run ID: ${input.runId}`,
    `Retry with resumeFromRunId: ${retryRunId}`,
    `Goal: ${compact(input.goal, '(未填写)')}`,
    `Failure: ${input.status}: ${error}`,
    `Evidence: phases=${input.phaseCount ?? 0}, cacheHits=${input.cacheHits ?? 0}`,
    ...priorProjectionSection(input.priorProjection),
    '先读取已有 run journal 与成功子调用缓存，再给出 retry plan；能自动重试的步骤直接重试，不能重试的步骤说明需要人工介入的边界。',
  ].join('\n');

  return {
    sessionId: input.sessionId,
    sourceMessageId: `workflow:${input.runId}:failure`,
    source: 'workflow_failure',
    title: `重试 workflow：${titleGoal}`,
    prompt,
    reason: `workflow ${input.status}: ${error}`,
  };
}

export function buildAgentTeamFailureRecoveryProposal(
  input: AgentTeamFailureRecoveryInput,
): CreateHandoffProposalInput | null {
  if (!input.sessionId?.trim()) return null;
  if (input.failedTasks.length === 0) return null;

  const failedLines = input.failedTasks.map((task) => {
    const taskText = task.task ? ` task=${stripWorkspacePrefix(task.task)}` : '';
    const errorText = task.error ? ` error=${compact(task.error, 'unknown error')}` : '';
    return `- ${task.taskId} (${task.role})${taskText}${errorText}`;
  });
  const sourceMessageId = input.sourceMessageId?.trim()
    || `agent-team:${input.failedTasks.map((task) => task.taskId).join(',')}`;
  const prompt = [
    '继续这个失败的 Agent Team 长任务。',
    `Total tasks: ${input.totalTasks}`,
    `Failed tasks: ${input.failedTasks.length}`,
    input.summary ? `Summary: ${compact(input.summary, '')}` : undefined,
    'Failed task evidence:',
    ...failedLines,
    ...priorProjectionSection(input.priorProjection),
    '先复用 Agent Team checkpoint、已完成子任务结果和 replay 证据，只重试失败或被阻塞的 task；重试前给出每个 task 的原因、依赖和预期产物。',
  ].filter(Boolean).join('\n');

  return {
    sessionId: input.sessionId,
    sourceMessageId,
    source: 'agent_team_failure',
    title: `重试 Agent Team：${input.failedTasks.map((task) => task.role).join(', ')}`,
    prompt,
    reason: `${input.failedTasks.length}/${input.totalTasks} agent tasks failed`,
  };
}

export function recordLongTaskRecoveryProposal(input: CreateHandoffProposalInput | null): HandoffProposal | null {
  if (!input) return null;
  try {
    return getHandoffProposalService().create(input);
  } catch (error) {
    logger.warn('Failed to record long-task recovery proposal', {
      source: input.source,
      sessionId: input.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
