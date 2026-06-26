import type { CreateHandoffProposalInput, HandoffProposal } from '../../shared/contract/handoff';
import { createLogger } from '../services/infra/logger';
import { getHandoffProposalService } from './handoffProposalService';

const logger = createLogger('LongTaskRecoveryProposal');

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
