import { randomUUID } from 'crypto';
import type { AgentRunOptions } from '../../research/types';
import type { Message, MessageMetadata } from '../../../shared/contract';
import type {
  NeoTagRunContext,
  NeoWorkCardDetail,
  NeoWorkCardRevision,
  NeoWorkCardUpdateReason,
} from '../../../shared/contract/tag';
import { generateMessageId } from '../../../shared/utils/id';
import { getSessionManager } from '../infra/sessionManager';
import { getNeoWorkCardService, type NeoWorkCardService } from './neoWorkCardService';
import { buildNeoTagContextPack } from './neoTagContextSelector';
import { buildNeoTagPromptLayer } from './neoTagPromptLayer';
import {
  collectNeoTagChangedFiles,
  createNeoTagRunArtifactSnapshot,
  type NeoTagRunArtifactSnapshot,
} from './neoTagRunArtifactTracker';
import { createLogger } from '../infra/logger';

const logger = createLogger('NeoTagRuntimeService');

export interface NeoTagTaskManager {
  getOrCreateCurrentOrchestrator?: (sessionId?: string) => { setWorkingDirectory?: (path: string) => void } | undefined;
  setWorkingDirectory?: (sessionId: string, directory: string) => void;
  startTask: (
    sessionId: string,
    message: string,
    attachments?: unknown[],
    options?: AgentRunOptions,
    messageMetadata?: MessageMetadata,
    clientMessageId?: string,
  ) => Promise<void>;
  getSessionState?: (sessionId: string) => { status: string; error?: string };
}

export interface LaunchApprovedNeoWorkCardInput {
  workCardId: string;
  taskManager: NeoTagTaskManager;
  service?: NeoWorkCardService;
  now?: () => number;
  onWorkCardUpdated?: (workCardId: string, reason: NeoWorkCardUpdateReason) => void;
}

export interface LaunchApprovedNeoWorkCardResult {
  runId: string;
  context: NeoTagRunContext;
}

function runId(): string {
  return `neorun_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

type ApprovedNeoWorkCardDetail = NeoWorkCardDetail & { approvedRevision: NeoWorkCardRevision };

function requireApprovedDetail(detail: NeoWorkCardDetail | null): ApprovedNeoWorkCardDetail {
  if (!detail) throw new Error('Neo work card not found');
  if (!detail.workCard.approvedRevisionId || !detail.approvedRevision) {
    throw new Error('Neo work card does not have an approved revision');
  }
  return detail as ApprovedNeoWorkCardDetail;
}

async function readSourceMessages(sessionId: string): Promise<{ messages: Message[]; workingDirectory?: string }> {
  const session = await getSessionManager().getSession(sessionId, 80);
  return {
    messages: session?.messages ?? [],
    workingDirectory: session?.workingDirectory,
  };
}

async function safelyCreateArtifactSnapshot(
  workingDirectory: string | undefined,
  revision: NeoWorkCardRevision,
): Promise<NeoTagRunArtifactSnapshot | null> {
  try {
    return await createNeoTagRunArtifactSnapshot(workingDirectory, revision.writeScope);
  } catch (error) {
    logger.warn('Neo Tag artifact snapshot failed; changedFiles will be empty', error);
    return null;
  }
}

async function safelyCollectChangedFiles(snapshot: NeoTagRunArtifactSnapshot | null): Promise<string[]> {
  try {
    return await collectNeoTagChangedFiles(snapshot);
  } catch (error) {
    logger.warn('Neo Tag artifact diff failed; changedFiles will be empty', error);
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeContextAudit(contextPack: NeoTagRunContext['contextPack']): string {
  const sourceTypes = [
    contextPack.selectedMessages.length > 0 ? 'messages' : null,
    contextPack.selectedArtifacts.length > 0 ? 'artifacts' : null,
    contextPack.selectedFiles.length > 0 ? 'files' : null,
    contextPack.selectedMemoryEntryIds.length > 0 ? 'memory' : null,
  ].filter((item): item is string => Boolean(item));
  const sourceSummary = sourceTypes.length > 0 ? sourceTypes.join('+') : 'none';
  return [
    `Context audit: pack=${contextPack.id}`,
    `strategy=${contextPack.strategy}`,
    `messages=${contextPack.selectedMessages.length}`,
    `artifacts=${contextPack.selectedArtifacts.length}`,
    `files=${contextPack.selectedFiles.length}`,
    `memory=${contextPack.selectedMemoryEntryIds.length}`,
    `excluded=${contextPack.excluded.length}`,
    `tokens=${contextPack.budget.estimatedTokens}/${contextPack.budget.maxTokens}`,
    `sources=${sourceSummary}`,
  ].join(' ');
}

async function waitForRuntimeState(
  taskManager: NeoTagTaskManager,
  sessionId: string,
): Promise<{ status: string; error?: string } | null> {
  if (!taskManager.getSessionState) return null;
  let latest = taskManager.getSessionState(sessionId);
  if (!['running', 'queued', 'cancelling'].includes(latest.status)) return latest;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    await sleep(250);
    latest = taskManager.getSessionState(sessionId);
    if (!['running', 'queued', 'cancelling'].includes(latest.status)) return latest;
  }
  return latest;
}

function runtimeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() || 'Runtime task ended with an unknown provider error.';
}

function appendFailureDelta(args: {
  service: NeoWorkCardService;
  workCardId: string;
  runId: string;
  error: string;
  now: () => number;
  contextAudit: string;
}): void {
  args.service.appendDelta({
    workCardId: args.workCardId,
    runId: args.runId,
    decisions: [args.contextAudit],
    openQuestions: ['Check provider credentials/model availability, then revise or retry this work card.'],
    risks: [args.error],
    nextStep: 'Fix the runtime/provider error before retrying the approved work card.',
    markResultReview: false,
  }, args.now());
}

function notifyWorkCardUpdated(
  input: LaunchApprovedNeoWorkCardInput,
  workCardId: string,
  reason: NeoWorkCardUpdateReason,
): void {
  try {
    input.onWorkCardUpdated?.(workCardId, reason);
  } catch (error) {
    logger.warn('Neo Tag work card update notification failed', error);
  }
}

export async function launchApprovedNeoWorkCard(
  input: LaunchApprovedNeoWorkCardInput,
): Promise<LaunchApprovedNeoWorkCardResult> {
  const service = input.service ?? getNeoWorkCardService();
  const now = input.now ?? Date.now;
  const detail = requireApprovedDetail(service.get(input.workCardId));
  const { workCard, approvedRevision } = detail;
  const latestDelta = detail.deltas.at(-1);
  const source = await readSourceMessages(workCard.sourceConversationId);
  const run = runId();
  const contextPack = buildNeoTagContextPack({
    workCard,
    revision: approvedRevision,
    messages: source.messages,
    previousDeltas: detail.deltas,
    now: now(),
  });
  const context: NeoTagRunContext = {
    workCardId: workCard.id,
    projectId: workCard.projectId,
    sourceConversationId: workCard.sourceConversationId,
    sourceTurnId: workCard.sourceTurnId,
    approvedRevisionId: approvedRevision.id,
    runId: run,
    contextPackId: contextPack.id,
    modelIntent: approvedRevision.modelIntent,
    contextPack,
  };
  context.promptLayer = buildNeoTagPromptLayer({
    runContext: context,
    revision: approvedRevision,
    previousDelta: latestDelta,
  });

  service.setStatus(workCard.id, 'queued', now());
  service.appendDelta({
    workCardId: workCard.id,
    runId: run,
    completed: [`Queued approved revision ${approvedRevision.id}`],
    decisions: [
      'Approved work card entered the local Neo runtime queue.',
      summarizeContextAudit(contextPack),
    ],
    nextStep: 'Start local runtime execution.',
    markResultReview: false,
  }, now());
  notifyWorkCardUpdated(input, workCard.id, 'runtime_queued');

  try {
    if (source.workingDirectory) {
      const orchestrator = input.taskManager.getOrCreateCurrentOrchestrator?.(workCard.sourceConversationId);
      orchestrator?.setWorkingDirectory?.(source.workingDirectory);
      input.taskManager.setWorkingDirectory?.(workCard.sourceConversationId, source.workingDirectory);
    }

    service.setStatus(workCard.id, 'working', now());
    notifyWorkCardUpdated(input, workCard.id, 'runtime_working');
    const artifactSnapshot = await safelyCreateArtifactSnapshot(source.workingDirectory, approvedRevision);
    const options: AgentRunOptions = {
      mode: 'normal',
      neoTag: context,
    };
    const metadata: MessageMetadata = {
      neoTag: {
        workCardId: workCard.id,
        approvedRevisionId: approvedRevision.id,
        runId: run,
        contextPackId: contextPack.id,
        sourceConversationId: workCard.sourceConversationId,
        sourceTurnId: workCard.sourceTurnId,
        status: 'working',
      },
    };
    await input.taskManager.startTask(
      workCard.sourceConversationId,
      approvedRevision.taskSummary,
      undefined,
      options,
      metadata,
      generateMessageId(),
    );
    const changedFiles = await safelyCollectChangedFiles(artifactSnapshot);

    const state = await waitForRuntimeState(input.taskManager, workCard.sourceConversationId);
    if (state?.status === 'error') {
      const error = state.error || 'Runtime task ended with an error state.';
      service.setStatus(workCard.id, 'failed', now());
      appendFailureDelta({
        service,
        workCardId: workCard.id,
        runId: run,
        error,
        now,
        contextAudit: summarizeContextAudit(contextPack),
      });
      notifyWorkCardUpdated(input, workCard.id, 'runtime_failed');
      return { runId: run, context };
    }

    if (state?.status === 'paused') {
      service.setStatus(workCard.id, 'waiting_for_user', now());
      service.appendDelta({
        workCardId: workCard.id,
        runId: run,
        decisions: [summarizeContextAudit(contextPack)],
        openQuestions: ['Runtime paused for user input or approval.'],
        nextStep: 'Answer the pending runtime request before continuing this work card.',
        markResultReview: false,
      }, now());
      notifyWorkCardUpdated(input, workCard.id, 'runtime_waiting_for_user');
      return { runId: run, context };
    }

    service.setStatus(workCard.id, 'in_result_review', now());
    service.appendDelta({
      workCardId: workCard.id,
      runId: run,
      completed: ['Local Neo runtime run finished.'],
      changedFiles,
      decisions: [
        'Runtime result is ready for work card review.',
        summarizeContextAudit(contextPack),
      ],
      openQuestions: [],
      risks: approvedRevision.risks,
      memoryCandidates: approvedRevision.memoryPlan.entries.map((entry) => entry.text),
      nextStep: 'Review the result and accept, revise, or archive the work card.',
    }, now());
    notifyWorkCardUpdated(input, workCard.id, 'runtime_result_review');
  } catch (error) {
    logger.error('Neo Tag runtime launch failed', error);
    const message = runtimeErrorMessage(error);
    service.setStatus(workCard.id, 'failed', now());
    appendFailureDelta({
      service,
      workCardId: workCard.id,
      runId: run,
      error: message,
      now,
      contextAudit: summarizeContextAudit(contextPack),
    });
    notifyWorkCardUpdated(input, workCard.id, 'runtime_failed');
  }

  return { runId: run, context };
}
