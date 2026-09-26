import { randomUUID } from 'crypto';
import type { AgentRunOptions } from '../../research/types';
import type { AgentEvent, Message, MessageMetadata } from '../../../shared/contract';
import {
  getAgentErrorMessage,
  isTerminalAgentError,
} from '../../../shared/utils/agentErrorClassification';
import { hasVisibleAssistantTextAfterLastUser } from '../../agent/runtime/runFinalizer';
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
  getOrCreateCurrentOrchestrator?: (sessionId?: string) => {
    setWorkingDirectory?: (path: string) => void;
    /** AgentOrchestrator.getMessages：工作卡完成判定的正向证据判源（内存 history）。 */
    getMessages?: () => Message[];
  } | undefined;
  hasActivePrimaryRun?: (sessionId: string) => boolean;
  setSessionContextIfIdle?: (sessionId: string, messages: Message[]) => boolean;
  setSessionContext?: (sessionId: string, messages: Message[]) => void;
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
  /** TaskManager.observeAgentEvents 的结构性子集：工作卡靠它旁听本轮 run 的终态事件。 */
  observeAgentEvents?: (
    observer: (sessionId: string, event: AgentEvent, taskId?: string) => void,
  ) => () => void;
}

export interface LaunchApprovedNeoWorkCardInput {
  workCardId: string;
  taskManager: NeoTagTaskManager;
  service?: NeoWorkCardService;
  now?: () => number;
  onWorkCardUpdated?: (workCardId: string, reason: NeoWorkCardUpdateReason) => void;
  /** 本轮落点：缺省回源会话（向后兼容）。跨会话续接时 = 当前会话 + 该轮 turnId（ADR-035）。 */
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

async function readFullSessionMessages(sessionId: string): Promise<Message[]> {
  const session = await getSessionManager().getSession(sessionId, Number.MAX_SAFE_INTEGER, { messageSource: 'ledger' });
  return session?.messages ?? [];
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

/** 本轮 run 旁听到的终态失败（runFinalizer 的 error 事件：message + 结构化 failure 标记）。 */
interface NeoTagRunFailure {
  message: string;
  /** 结构化失败标记的 code（MODEL_AUTH / MODEL_QUOTA / MODEL_UNAVAILABLE …），缺省=未分类。 */
  failureCode?: string;
}

/**
 * 终态契约的单一判定点（N-CHAT-EMPTY-FINAL-NO-EXIT）。
 *
 * 完成必须有正向证据：本轮 user turn 之后存在非空 assistant 正文。排除法
 * （「不是 error/paused 就算完成」）已被废除——provider 401 等失败会让
 * agentLoop 正常 resolve、session state 回到 idle，排除法把它们全记成完成。
 *
 * 优先级（高→低）：session 显式 error → 运行被取消 → 旁听到终态失败 →
 * 没有最终回复（无正向证据）→ 完成（in_result_review）。
 */
interface NeoTagRunOutcomeInput {
  state: { status: string; error?: string } | null;
  failure: NeoTagRunFailure | null;
  cancelled: boolean;
  /** 正向证据：本轮 user turn 之后有非空 assistant 正文。 */
  hasFinalReply: boolean;
}

type NeoTagRunOutcome =
  | { status: 'failed'; reason: string }
  | { status: 'waiting_for_user' }
  | { status: 'in_result_review' };

/** 失败态带出路不带解释：一句原因 + 一句下一步，不堆技术细节。 */
function blockedReasonForFailure(failure: { message: string; failureCode?: string }): string {
  switch (failure.failureCode) {
    case 'MODEL_AUTH':
      return '模型鉴权失败：API Key 无效或已过期。到「设置 → 模型」修复这个模型的 Key，或换一个模型，然后点「接着做」重试。';
    case 'MODEL_QUOTA':
      return '模型额度不足：这个账号在服务商的余额或额度已用完。换一个模型，或到服务商侧处理后再点「接着做」重试。';
    case 'MODEL_UNAVAILABLE':
      return '模型不可用：这个模型已被服务商下线或暂时不可用。换一个模型后点「接着做」重试。';
    default: {
      const raw = failure.message.trim().slice(0, 200);
      return raw
        ? `${raw} 点「接着做」重试，或换一个模型。`
        : '这轮运行失败了。点「接着做」重试，或换一个模型。';
    }
  }
}

function resolveNeoTagRunOutcome(input: NeoTagRunOutcomeInput): NeoTagRunOutcome {
  if (input.state?.status === 'paused') return { status: 'waiting_for_user' };
  if (input.state?.status === 'error') {
    return {
      status: 'failed',
      reason: blockedReasonForFailure({ message: input.state.error ?? '' }),
    };
  }
  if (input.cancelled) {
    return { status: 'failed', reason: '运行被手动中止，这轮没有产出。点「接着做」继续这个 topic。' };
  }
  if (input.failure) {
    return { status: 'failed', reason: blockedReasonForFailure(input.failure) };
  }
  if (!input.hasFinalReply) {
    return {
      status: 'failed',
      reason: '这轮没有生成最终回复，没有可复核的结果。点「接着做」让 Neo 重试，或换一个模型。',
    };
  }
  return { status: 'in_result_review' };
}

/**
 * 旁听本轮 run 的终态事件。runFinalizer 对 provider 失败只发 error 事件不抛异常
 * （sendMessage 照常 resolve），session state 也回 idle——不旁听事件就抓不到失败。
 */
function observeNeoTagRunTerminalEvents(
  taskManager: NeoTagTaskManager,
  sessionId: string,
): { failure: () => NeoTagRunFailure | null; cancelled: () => boolean; stop: () => void } {
  let failure: NeoTagRunFailure | null = null;
  let cancelled = false;
  if (!taskManager.observeAgentEvents) {
    return { failure: () => failure, cancelled: () => cancelled, stop: () => {} };
  }
  const unsubscribe = taskManager.observeAgentEvents((eventSessionId, event) => {
    if (eventSessionId !== sessionId) return;
    if (event.type === 'agent_cancelled') {
      cancelled = true;
      return;
    }
    if (event.type !== 'error' || !isTerminalAgentError(event.data)) return;
    const message = getAgentErrorMessage(event.data) ?? 'Runtime task ended with an unknown error.';
    const failureCode = event.data && typeof event.data === 'object' && 'failure' in event.data
      ? (event.data as { failure?: { code?: unknown } }).failure?.code
      : undefined;
    failure = {
      message,
      ...(typeof failureCode === 'string' && failureCode ? { failureCode } : {}),
    };
  });
  return {
    failure: () => failure,
    cancelled: () => cancelled,
    stop: unsubscribe,
  };
}

/**
 * 正向证据：本轮 user turn（id = roundTurnId，startTask 以它为 clientMessageId 落库）
 * 之后有没有非空 assistant 正文。
 *
 * 判源优先级：orchestrator 内存 history（运行期同步写入，无落库竞态）→ 会话 ledger
 * 全量（orchestrator 不可用时的兜底）。两处都找不到锚点 user 消息 = 没有证据，
 * 宁可失败不可冒充完成。
 */
async function runProducedVisibleReply(
  taskManager: NeoTagTaskManager,
  conversationId: string,
  roundTurnId: string,
): Promise<boolean> {
  const hasReplyFrom = (messages: Message[]): boolean | null => {
    const anchorIndex = messages.findIndex(
      (message) => message.id === roundTurnId && message.role === 'user',
    );
    if (anchorIndex < 0) return null;
    return hasVisibleAssistantTextAfterLastUser(messages.slice(anchorIndex));
  };

  const orchestrator = taskManager.getOrCreateCurrentOrchestrator?.(conversationId);
  const liveMessages = typeof orchestrator?.getMessages === 'function'
    ? orchestrator.getMessages()
    : undefined;
  if (liveMessages && liveMessages.length > 0) {
    const live = hasReplyFrom(liveMessages);
    if (live !== null) return live;
  }
  const ledger = hasReplyFrom(await readFullSessionMessages(conversationId));
  return ledger ?? false;
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
  // ADR-035：本轮落点缺省回源会话；跨会话续接时落发起续接的会话（过程在用户眼前流式可见）
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
  // Topic 历史（ADR-035 D3）：从本轮之外的参与会话物化历史轮正文。
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
    // The renderer may submit from a project page while another session is open.
    // Check and hydrate synchronously so a competing run cannot have its live
    // orchestrator history replaced before startTask rejects the busy session.
    const targetMessages = await readFullSessionMessages(roundConversationId);
    const contextReady = input.taskManager.setSessionContextIfIdle
      ? input.taskManager.setSessionContextIfIdle(roundConversationId, targetMessages)
      : (() => {
        const currentState = input.taskManager.getSessionState?.(roundConversationId);
        if (['running', 'paused', 'queued', 'cancelling'].includes(currentState?.status ?? '')
          || input.taskManager.hasActivePrimaryRun?.(roundConversationId)) return false;
        if (targetMessages.length > 0) {
          input.taskManager.setSessionContext?.(roundConversationId, targetMessages);
        }
        return true;
      })();
    if (!contextReady) {
      throw new Error(`Session ${roundConversationId} is already running`);
    }
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
      displayContent: `@neo ${approvedRevision.taskSummary}`,
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
    // clientMessageId = 本轮 turnId：host 直接把带 @neo 前缀的展示文本落到目标会话，
    // renderer 不需要切换会话或做本地补显，live 与 reload 都只看到一条用户消息。
    // 终态事件旁听必须先于 startTask 挂上：runFinalizer 的失败事件发生在 sendMessage
    // resolve 之前，晚挂会漏。
    const terminalEvents = observeNeoTagRunTerminalEvents(input.taskManager, roundConversationId);
    try {
      await input.taskManager.startTask(
        roundConversationId,
        approvedRevision.taskSummary,
        undefined,
        options,
        metadata,
        roundTurnId,
      );
    } finally {
      terminalEvents.stop();
    }
    const changedFiles = await safelyCollectChangedFiles(artifactSnapshot);
    const hasFinalReply = await runProducedVisibleReply(input.taskManager, roundConversationId, roundTurnId);
    const state = await waitForRuntimeState(input.taskManager, roundConversationId);
    const outcome = resolveNeoTagRunOutcome({
      state,
      failure: terminalEvents.failure(),
      cancelled: terminalEvents.cancelled(),
      hasFinalReply,
    });

    if (outcome.status === 'failed') {
      service.setStatus(workCard.id, 'failed', now(), outcome.reason);
      appendFailureDelta({
        service,
        workCardId: workCard.id,
        runId: run,
        conversationId: roundConversationId,
        error: outcome.reason,
        now,
        contextAudit: summarizeContextAudit(contextPack, topicRounds.length),
      });
      notifyWorkCardUpdated(input.onWorkCardUpdated, workCard.id, 'runtime_failed');
      return { runId: run, context };
    }

    if (outcome.status === 'waiting_for_user') {
      service.setStatus(
        workCard.id,
        'waiting_for_user',
        now(),
        'Runtime paused for user input or approval.',
      );
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
    service.setStatus(workCard.id, 'failed', now(), message);
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
  /** 续接发生的会话 = 本轮执行落点（ADR-035 D2）。 */
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
 * @neo 跨会话续接（ADR-035）：既有 topic 追加一轮 —— 新 revision → 自动批准 → 在当前会话运行。
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
        notes: ['Follow-up round appended from another conversation (ADR-035).'],
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
