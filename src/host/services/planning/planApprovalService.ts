import type { AgentApplicationService } from '../../../shared/contract/appService';
import type { Message, ToolCall } from '../../../shared/contract';
import {
  createPendingPlanApproval,
  formatApprovedPlan,
  PLAN_APPROVAL_CONFIRMATION_TYPE,
  type PlanApprovalRecord,
  type PlanApprovalRequest,
  type PlanApprovalResponse,
  type PlanApprovalStep,
} from '../../../shared/contract/planApproval';
import type { TaskManager } from '../../task';
import { getSessionManager } from '../infra/sessionManager';
import { replaceTasksAtomically } from './taskStore';
import { createLogger } from '../infra/logger';

const MAX_PLAN_STEPS = 50;
const MAX_STEP_LENGTH = 2_000;
const MAX_FEEDBACK_LENGTH = 8_000;
const logger = createLogger('PlanApprovalService');

export class PlanApprovalError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function requiredId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PlanApprovalError('INVALID_REQUEST', `${field} is required`);
  }
  return value.trim();
}

function normalizeSteps(
  rawSteps: PlanApprovalStep[] | undefined,
  originalSteps: readonly PlanApprovalStep[],
): PlanApprovalStep[] {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0 || rawSteps.length > MAX_PLAN_STEPS) {
    throw new PlanApprovalError('INVALID_STEPS', `steps must contain 1-${MAX_PLAN_STEPS} items`);
  }
  const originalById = new Map(originalSteps.map((step) => [step.id, step]));
  const seenIds = new Set<string>();
  return rawSteps.map((step, index) => {
    const content = typeof step?.content === 'string' ? step.content.trim() : '';
    if (!content || content.length > MAX_STEP_LENGTH) {
      throw new PlanApprovalError('INVALID_STEPS', `steps[${index}].content is invalid`);
    }
    const id = typeof step.id === 'string' && step.id.trim() ? step.id.trim() : `step-${index + 1}`;
    if (seenIds.has(id)) {
      throw new PlanApprovalError('INVALID_STEPS', `steps[${index}].id is duplicated`);
    }
    seenIds.add(id);
    const originalContent = originalById.get(id)?.content ?? '';
    return {
      id,
      content,
      originalContent,
      ...(content !== originalContent ? { edited: true } : {}),
    };
  });
}

function readApproval(toolCall: ToolCall): PlanApprovalRecord {
  const metadata = toolCall.result?.metadata;
  if (
    metadata?.confirmationType !== PLAN_APPROVAL_CONFIRMATION_TYPE
    || typeof metadata.plan !== 'string'
  ) {
    throw new PlanApprovalError('NOT_PLAN_APPROVAL', 'The referenced tool call is not a plan approval');
  }
  const approval = metadata.planApproval;
  if (approval && typeof approval === 'object' && !Array.isArray(approval)) {
    return approval as unknown as PlanApprovalRecord;
  }
  return createPendingPlanApproval(metadata.plan);
}

async function loadApprovalTarget(request: PlanApprovalRequest): Promise<{
  message: Message;
  toolCall: ToolCall;
  approval: PlanApprovalRecord;
}> {
  const messages = await getSessionManager().getMessages(request.sessionId);
  const message = messages.find((candidate) => candidate.id === request.messageId);
  const toolCall = message?.toolCalls?.find((candidate) => candidate.id === request.toolCallId);
  if (!message || !toolCall) {
    throw new PlanApprovalError('APPROVAL_NOT_FOUND', 'Plan approval request no longer exists');
  }
  const approval = readApproval(toolCall);
  if (approval.status !== 'pending') {
    throw new PlanApprovalError('ALREADY_RESOLVED', `Plan approval is already ${approval.status}`);
  }
  return { message, toolCall, approval };
}

async function persistApproval(
  message: Message,
  toolCallId: string,
  approval: PlanApprovalRecord,
): Promise<void> {
  const toolCalls = (message.toolCalls ?? []).map((toolCall) => {
    if (toolCall.id !== toolCallId || !toolCall.result) return toolCall;
    return {
      ...toolCall,
      result: {
        ...toolCall.result,
        metadata: { ...toolCall.result.metadata, planApproval: approval },
      },
    };
  });
  await getSessionManager().updateMessage(message.id, { toolCalls });
}

function hiddenPlanTurn(content: string) {
  return {
    content,
    options: {
      mode: 'normal' as const,
      historyVisibility: 'meta' as const,
      disableAutoAgent: true,
    },
  };
}

export async function resolvePlanApproval(
  request: PlanApprovalRequest,
  deps: {
    appService: AgentApplicationService;
    taskManager: TaskManager;
  },
): Promise<PlanApprovalResponse> {
  const normalizedRequest: PlanApprovalRequest = {
    ...request,
    sessionId: requiredId(request.sessionId, 'sessionId'),
    messageId: requiredId(request.messageId, 'messageId'),
    toolCallId: requiredId(request.toolCallId, 'toolCallId'),
  };
  const target = await loadApprovalTarget(normalizedRequest);
  const decidedAt = Date.now();

  if (normalizedRequest.decision === 'approve') {
    const steps = normalizeSteps(normalizedRequest.steps, target.approval.steps);
    const submittedIds = new Set(steps.map((step) => step.id));
    const removedSteps = target.approval.steps.filter((step) => !submittedIds.has(step.id));
    const originalRetainedOrder = target.approval.steps
      .filter((step) => submittedIds.has(step.id))
      .map((step) => step.id);
    const submittedRetainedOrder = steps
      .filter((step) => target.approval.steps.some((original) => original.id === step.id))
      .map((step) => step.id);
    const reordered = originalRetainedOrder.some((id, index) => submittedRetainedOrder[index] !== id);
    const approval: PlanApprovalRecord = {
      ...target.approval,
      status: 'approved',
      steps,
      ...(removedSteps.length > 0 ? { removedSteps } : {}),
      ...(reordered ? { reordered: true } : {}),
      decidedAt,
    };
    const tasks = replaceTasksAtomically(normalizedRequest.sessionId, steps.map((step) => step.content));
    await persistApproval(target.message, normalizedRequest.toolCallId, approval);
    deps.taskManager.emitAgentEventForSession(normalizedRequest.sessionId, {
      type: 'task_update',
      data: {
        tasks,
        action: 'sync',
        taskIds: tasks.map((task) => task.id),
        source: 'plan_approval',
      },
    });
    const approvedPlan = formatApprovedPlan(steps);
    void deps.appService.sendMessage({
      ...hiddenPlanTurn([
        '<approved-plan>',
        approvedPlan,
        '</approved-plan>',
        'Execute this approved plan now. Keep the TaskManager session ledger updated as steps progress.',
      ].join('\n')),
      sessionId: normalizedRequest.sessionId,
    }).catch((error) => {
      logger.error('Approved plan turn failed to start', error);
    });
    return { approval, tasks };
  }

  if (normalizedRequest.decision === 'revise') {
    const feedback = typeof normalizedRequest.feedback === 'string' ? normalizedRequest.feedback.trim() : '';
    if (!feedback || feedback.length > MAX_FEEDBACK_LENGTH) {
      throw new PlanApprovalError('INVALID_FEEDBACK', 'feedback is required and must be concise');
    }
    const approval: PlanApprovalRecord = {
      ...target.approval,
      status: 'revision_requested',
      feedback,
      decidedAt,
    };
    await persistApproval(target.message, normalizedRequest.toolCallId, approval);
    void deps.appService.sendMessage({
      ...hiddenPlanTurn([
        '<plan-revision-request>',
        `<proposed-plan>\n${target.approval.originalPlan}\n</proposed-plan>`,
        `<feedback>\n${feedback}\n</feedback>`,
        'Revise the plan only. Do not execute it. Return the replacement through exit_plan_mode for approval.',
        '</plan-revision-request>',
      ].join('\n')),
      sessionId: normalizedRequest.sessionId,
    }).catch((error) => {
      logger.error('Plan revision turn failed to start', error);
    });
    return { approval };
  }

  if (normalizedRequest.decision !== 'cancel') {
    throw new PlanApprovalError('INVALID_DECISION', `Unknown decision: ${String(normalizedRequest.decision)}`);
  }
  const approval: PlanApprovalRecord = { ...target.approval, status: 'cancelled', decidedAt };
  await persistApproval(target.message, normalizedRequest.toolCallId, approval);
  return { approval };
}
