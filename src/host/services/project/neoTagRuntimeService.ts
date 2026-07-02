import { randomUUID } from 'crypto';
import type { AgentRunOptions } from '../../research/types';
import type { Message, MessageMetadata } from '../../../shared/contract';
import type {
  CreateNeoWorkCardDraftInput,
  NeoTagRunContext,
  NeoWorkCard,
  NeoWorkCardDetail,
  NeoWorkCardRevision,
  NeoWorkCardUpdateReason,
} from '../../../shared/contract/tag';
import { getSessionManager } from '../infra/sessionManager';
import {
  extractNeoTopicRounds,
  mergeTopicRounds,
  topicConversationIds,
  type NeoTopicRound,
} from '../../../shared/neoTag/topicRounds';
import {
  getNeoWorkCardService,
  NeoWorkCardServiceError,
  type NeoWorkCardService,
} from './neoWorkCardService';
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
  /** 本轮落点：缺省回源会话（向后兼容）。跨会话续接时 = 当前会话 + 该轮 turnId（ADR-033）。 */
  target?: { conversationId: string; turnId: string };
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

function summarizeContextAudit(contextPack: NeoTagRunContext['contextPack'], topicRoundCount = 0): string {
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
    `topicRounds=${topicRoundCount}`,
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
  conversationId: string;
  error: string;
  now: () => number;
  contextAudit: string;
}): void {
  args.service.appendDelta({
    workCardId: args.workCardId,
    runId: args.runId,
    conversationId: args.conversationId,
    decisions: [args.contextAudit],
    openQuestions: ['Check provider credentials/model availability, then revise or retry this work card.'],
    risks: [args.error],
    nextStep: 'Fix the runtime/provider error before retrying the approved work card.',
    markResultReview: false,
  }, args.now());
}

function notifyWorkCardUpdated(
  onWorkCardUpdated: ((workCardId: string, reason: NeoWorkCardUpdateReason) => void) | undefined,
  workCardId: string,
  reason: NeoWorkCardUpdateReason,
): void {
  try {
    onWorkCardUpdated?.(workCardId, reason);
  } catch (error) {
    logger.warn('Neo Tag work card update notification failed', error);
  }
}

export interface CreateAndRunNeoWorkCardInput {
  draft: CreateNeoWorkCardDraftInput;
  taskManager: NeoTagTaskManager;
  service?: NeoWorkCardService;
  now?: () => number;
  onWorkCardUpdated?: (workCardId: string, reason: NeoWorkCardUpdateReason) => void;
}

export interface CreateAndRunNeoWorkCardResult {
  workCard: NeoWorkCard;
  revision: NeoWorkCardRevision;
  /** 后台运行的 Promise。调用方（如 IPC）可 fire-and-forget，立即拿到已建的卡返回。 */
  run: Promise<LaunchApprovedNeoWorkCardResult>;
}

/**
 * @neo 直接开干（轻量化重设计）：一步「建卡 → 自动批准 → 落地运行」，无审批门。
 *
 * 权限是项目级 ambient（全局 permission mode + ADR-031 运行时护栏），不再逐任务审批。
 * 自动批准的 reviewer 就是发起人本人——审批语义在这里退化为无操作记录，
 * 用户看不到审批按钮，卡直接进入运行态。审批记录本体在 Phase 3 契约减重时移除。
 *
 * 建卡 + 批准是同步的；运行以 `run` Promise 返回，调用方可后台跑并立即返回已建卡。
 */
export function createAndRunNeoWorkCard(
  input: CreateAndRunNeoWorkCardInput,
): CreateAndRunNeoWorkCardResult {
  const service = input.service ?? getNeoWorkCardService();
  const now = input.now ?? Date.now;

  const created = service.createDraft(input.draft, now());
  notifyWorkCardUpdated(input.onWorkCardUpdated, created.workCard.id, 'draft_created');

  service.approveRevision({
    workCardId: created.workCard.id,
    revisionId: created.revision.id,
    reviewerUserId: input.draft.requesterUserId,
  }, now());
  notifyWorkCardUpdated(input.onWorkCardUpdated, created.workCard.id, 'revision_approved');

  const run = launchApprovedNeoWorkCard({
    workCardId: created.workCard.id,
    taskManager: input.taskManager,
    service,
    now,
    onWorkCardUpdated: input.onWorkCardUpdated,
  });

  return {
    workCard: created.workCard,
    revision: created.revision,
    run,
  };
}

export async function launchApprovedNeoWorkCard(
  input: LaunchApprovedNeoWorkCardInput,
): Promise<LaunchApprovedNeoWorkCardResult> {
  const service = input.service ?? getNeoWorkCardService();
  const now = input.now ?? Date.now;
  const detail = requireApprovedDetail(service.get(input.workCardId));
  const { workCard, approvedRevision } = detail;
  const latestDelta = detail.deltas.at(-1);
  // ADR-033：本轮落点缺省回源会话；跨会话续接时落发起续接的会话（过程在用户眼前流式可见）
  const roundConversationId = input.target?.conversationId ?? workCard.sourceConversationId;
  const roundTurnId = input.target?.turnId ?? workCard.sourceTurnId;
  const isCrossConversation = roundConversationId !== workCard.sourceConversationId;
  const source = await readSourceMessages(roundConversationId);
  const run = runId();
  const contextPack = buildNeoTagContextPack({
    workCard,
    revision: approvedRevision,
    messages: source.messages,
    previousDeltas: detail.deltas,
    now: now(),
  });
  // Topic 历史（ADR-033 D3）：从本轮之外的参与会话物化历史轮正文。
  // Neo 懂当前会话靠 run 在场（session 历史天然加载）；其他会话的轮必须以正文注入 prompt。
  const historyConversationIds = Array.from(new Set([
    workCard.sourceConversationId,
    ...approvedRevision.readScope.conversationIds,
  ])).filter((id) => id && id !== roundConversationId);
  const topicRoundLists: NeoTopicRound[][] = [];
  let topicWorkspace: string | undefined;
  for (const conversationId of historyConversationIds) {
    const session = await getSessionManager().getSession(conversationId, 80);
    if (conversationId === workCard.sourceConversationId) {
      topicWorkspace = session?.workingDirectory;
    }
    topicRoundLists.push(extractNeoTopicRounds(session?.messages ?? [], workCard.id, conversationId));
  }
  const topicRounds = mergeTopicRounds(topicRoundLists);

  const context: NeoTagRunContext = {
    workCardId: workCard.id,
    projectId: workCard.projectId,
    sourceConversationId: workCard.sourceConversationId,
    sourceTurnId: roundTurnId,
    targetConversationId: roundConversationId,
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
    topicRounds,
    topicWorkspace,
  });

  service.setStatus(workCard.id, 'queued', now());
  service.appendDelta({
    workCardId: workCard.id,
    runId: run,
    conversationId: roundConversationId,
    completed: [`Queued approved revision ${approvedRevision.id}`],
    decisions: [
      'Approved work card entered the local Neo runtime queue.',
      summarizeContextAudit(contextPack, topicRounds.length),
    ],
    nextStep: 'Start local runtime execution.',
    markResultReview: false,
  }, now());
  notifyWorkCardUpdated(input.onWorkCardUpdated, workCard.id, 'runtime_queued');

  try {
    // D2 护栏：只有回源会话跑才同步工作目录；跨会话续接用目标会话自己的目录，
    // 禁止持久改写目标会话的工作目录（污染其后续普通聊天）。
    if (source.workingDirectory && !isCrossConversation) {
      const orchestrator = input.taskManager.getOrCreateCurrentOrchestrator?.(roundConversationId);
      orchestrator?.setWorkingDirectory?.(source.workingDirectory);
      input.taskManager.setWorkingDirectory?.(roundConversationId, source.workingDirectory);
    }

    service.setStatus(workCard.id, 'working', now());
    notifyWorkCardUpdated(input.onWorkCardUpdated, workCard.id, 'runtime_working');
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
        sourceTurnId: roundTurnId,
        status: 'working',
      },
    };
    // clientMessageId = 本轮 turnId：renderer 在 @neo 提交时本地补的用户消息用同一个 ID，
    // 落库幂等（addMessageToSession 重复 ID 走 update），live 与 reload 不会出现双份用户消息。
    await input.taskManager.startTask(
      roundConversationId,
      approvedRevision.taskSummary,
      undefined,
      options,
      metadata,
      roundTurnId,
    );
    const changedFiles = await safelyCollectChangedFiles(artifactSnapshot);

    const state = await waitForRuntimeState(input.taskManager, roundConversationId);
    if (state?.status === 'error') {
      const error = state.error || 'Runtime task ended with an error state.';
      service.setStatus(workCard.id, 'failed', now());
      appendFailureDelta({
        service,
        workCardId: workCard.id,
        runId: run,
        conversationId: roundConversationId,
        error,
        now,
        contextAudit: summarizeContextAudit(contextPack, topicRounds.length),
      });
      notifyWorkCardUpdated(input.onWorkCardUpdated, workCard.id, 'runtime_failed');
      return { runId: run, context };
    }

    if (state?.status === 'paused') {
      service.setStatus(workCard.id, 'waiting_for_user', now());
      service.appendDelta({
        workCardId: workCard.id,
        runId: run,
        conversationId: roundConversationId,
        decisions: [summarizeContextAudit(contextPack, topicRounds.length)],
        openQuestions: ['Runtime paused for user input or approval.'],
        nextStep: 'Answer the pending runtime request before continuing this work card.',
        markResultReview: false,
      }, now());
      notifyWorkCardUpdated(input.onWorkCardUpdated, workCard.id, 'runtime_waiting_for_user');
      return { runId: run, context };
    }

    service.setStatus(workCard.id, 'in_result_review', now());
    service.appendDelta({
      workCardId: workCard.id,
      runId: run,
      conversationId: roundConversationId,
      completed: ['Local Neo runtime run finished.'],
      changedFiles,
      decisions: [
        'Runtime result is ready for work card review.',
        summarizeContextAudit(contextPack, topicRounds.length),
      ],
      openQuestions: [],
      risks: approvedRevision.risks,
      memoryCandidates: approvedRevision.memoryPlan.entries.map((entry) => entry.text),
      nextStep: 'Review the result and accept, revise, or archive the work card.',
    }, now());
    notifyWorkCardUpdated(input.onWorkCardUpdated, workCard.id, 'runtime_result_review');
  } catch (error) {
    logger.error('Neo Tag runtime launch failed', error);
    const message = runtimeErrorMessage(error);
    service.setStatus(workCard.id, 'failed', now());
    appendFailureDelta({
      service,
      workCardId: workCard.id,
      runId: run,
      conversationId: roundConversationId,
      error: message,
      now,
      contextAudit: summarizeContextAudit(contextPack, topicRounds.length),
    });
    notifyWorkCardUpdated(input.onWorkCardUpdated, workCard.id, 'runtime_failed');
  }

  return { runId: run, context };
}

const CONTINUATION_BLOCKED_STATUSES = new Set<NeoWorkCard['status']>([
  'approved', 'queued', 'working', 'waiting_for_user',
]);

export interface ContinueAndRunNeoWorkCardInput {
  workCardId: string;
  /** 续接发生的会话 = 本轮执行落点（ADR-033 D2）。 */
  conversationId: string;
  /** 本轮用户消息 ID（renderer 本地补显与 host 落库同 ID 去重，机制同 sourceTurnId）。 */
  turnId: string;
  userText: string;
  requesterUserId: string;
  selectedArtifactIds?: string[];
  taskManager: NeoTagTaskManager;
  service?: NeoWorkCardService;
  now?: () => number;
  onWorkCardUpdated?: (workCardId: string, reason: NeoWorkCardUpdateReason) => void;
}

/**
 * @neo 跨会话续接（ADR-033）：既有 topic 追加一轮 —— 新 revision → 自动批准 → 在当前会话运行。
 * completed/failed 卡可续接重开；运行中拒绝（同卡双会话并发 fail-closed）。
 * readScope.conversationIds 自动推导 = 当前会话 ∪ 源会话 ∪ 历史轮会话，不做手动多选。
 */
export function continueAndRunNeoWorkCard(
  input: ContinueAndRunNeoWorkCardInput,
): CreateAndRunNeoWorkCardResult {
  const service = input.service ?? getNeoWorkCardService();
  const now = input.now ?? Date.now;
  const detail = service.get(input.workCardId);
  if (!detail) throw new NeoWorkCardServiceError('NOT_FOUND', 'work card not found');
  if (CONTINUATION_BLOCKED_STATUSES.has(detail.workCard.status)) {
    throw new NeoWorkCardServiceError('CONFLICT', '这个 topic 还在跑，等这轮结束再续。');
  }
  const userText = input.userText.trim();
  if (!userText) throw new NeoWorkCardServiceError('INVALID_ARGS', '写一下要 Neo 接着做什么。');

  const base = detail.approvedRevision ?? detail.currentRevision;
  if (!base) throw new NeoWorkCardServiceError('INVALID_STATE', 'work card has no revision');
  const conversationIds = Array.from(new Set([
    input.conversationId,
    ...topicConversationIds(detail),
  ]));

  const updated = service.updateDraftRevision({
    workCardId: detail.workCard.id,
    updatedByUserId: input.requesterUserId,
    revision: {
      intent: base.intent,
      taskSummary: userText,
      readScope: {
        ...base.readScope,
        mode: 'selected_context',
        conversationIds,
        messageIds: [],
        artifactIds: input.selectedArtifactIds ?? [],
        notes: ['Follow-up round appended from another conversation (ADR-033).'],
      },
      writeScope: base.writeScope,
      modelIntent: base.modelIntent,
      memoryPlan: { mode: 'none', entries: [], notes: [] },
      expectedOutputs: base.expectedOutputs,
      risks: [],
      assumptions: [],
    },
  }, now());
  notifyWorkCardUpdated(input.onWorkCardUpdated, updated.workCard.id, 'draft_updated');

  service.approveRevision({
    workCardId: updated.workCard.id,
    revisionId: updated.revision.id,
    reviewerUserId: input.requesterUserId,
  }, now());
  notifyWorkCardUpdated(input.onWorkCardUpdated, updated.workCard.id, 'revision_approved');

  const run = launchApprovedNeoWorkCard({
    workCardId: updated.workCard.id,
    taskManager: input.taskManager,
    service,
    now,
    onWorkCardUpdated: input.onWorkCardUpdated,
    target: { conversationId: input.conversationId, turnId: input.turnId },
  });
  return { workCard: updated.workCard, revision: updated.revision, run };
}
