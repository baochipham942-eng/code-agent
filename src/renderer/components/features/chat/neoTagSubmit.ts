import type { ConversationEnvelope } from '@shared/contract/conversationEnvelope';
import type { Message } from '@shared/contract/message';
import type {
  ContinueNeoWorkCardRequest,
  ContinueNeoWorkCardResult,
  CreateNeoWorkCardDraftRequest,
  CreateNeoWorkCardDraftResult,
} from '@shared/contract/tag';
import { parseLeadingNeoTagInvocation } from './ChatInput/neoMentionRouting';

export interface BuildNeoWorkCardDraftRequestParams {
  envelope: ConversationEnvelope;
  sourceConversationId: string;
  projectId?: string | null;
  workspacePath?: string | null;
  requesterUserId: string;
}

export interface SubmitNeoTagDraftParams extends BuildNeoWorkCardDraftRequestParams {
  /** @neo 直接开干：建卡即运行（无审批门），底层走 tag `createAndRun`。 */
  runNeoTag: (input: CreateNeoWorkCardDraftRequest) => Promise<CreateNeoWorkCardDraftResult>;
}

function compactTitle(text: string): string {
  const firstLine = text.replace(/\s+/g, ' ').trim();
  if (!firstLine) return 'Neo work card';
  return firstLine.length > 72 ? `${firstLine.slice(0, 69)}...` : firstLine;
}

export function buildNeoWorkCardDraftRequest(
  params: BuildNeoWorkCardDraftRequestParams,
): CreateNeoWorkCardDraftRequest | null {
  const parsed = parseLeadingNeoTagInvocation(params.envelope.content);
  if (!parsed) return null;
  if (!parsed.userText) {
    throw new Error('写一下 Neo 要做什么。');
  }

  const workspacePath = params.workspacePath ?? params.envelope.context?.workingDirectory ?? null;
  // @neo 直接开干：不再要求先绑项目。projectId 回退到会话工作目录，再兜底到 current-project，
  // 去掉「必须先绑项目」这道和「直接开干」矛盾的配置门。
  const projectScope = params.projectId || workspacePath || 'current-project';
  const attachmentIds = params.envelope.attachments?.map((attachment) => attachment.id) ?? [];

  return {
    projectId: projectScope,
    workspacePath,
    sourceConversationId: params.sourceConversationId,
    requesterUserId: params.requesterUserId,
    userText: parsed.userText,
    title: compactTitle(parsed.userText),
    selectedMessageIds: [],
    selectedArtifactIds: attachmentIds,
    clientSourceMessageId: params.envelope.clientMessageId,
    revision: {
      intent: 'plan',
      taskSummary: parsed.userText,
      readScope: {
        mode: 'selected_context',
        projectId: projectScope,
        conversationIds: [params.sourceConversationId],
        messageIds: [],
        artifactIds: attachmentIds,
        fileGlobs: [],
        memoryEntryIds: [],
        notes: ['Seeded from a leading @neo conversation request.'],
      },
      writeScope: {
        mode: 'none',
        projectId: projectScope,
        allowedPaths: [],
        canCreateFiles: false,
        canModifyFiles: false,
        canWriteProjectMemory: false,
        externalDestinations: [],
        notes: ['Runtime execution is not started by the renderer draft entry.'],
      },
      modelIntent: { mode: 'inherit_current' },
      memoryPlan: { mode: 'none', entries: [], notes: [] },
      expectedOutputs: [
        {
          kind: 'plan',
          title: 'Neo work card result',
          description: 'Result review happens after an approved runtime run.',
        },
      ],
      risks: [],
      assumptions: [],
    },
  };
}

export interface BuildNeoTagSourceMessageParams {
  envelope: ConversationEnvelope;
  sourceConversationId: string;
  result: CreateNeoWorkCardDraftResult;
  timestamp?: number;
}

/**
 * @neo 提交成功后，renderer 本地补上用户那句原话（BUG1：会话里要能看到自己说了什么）。
 * ID 用 sourceTurnId —— host 落库的用户消息用同一个 ID，reload/合并按 ID 天然去重。
 */
export function buildNeoTagSourceMessage(params: BuildNeoTagSourceMessageParams): Message {
  return {
    id: params.result.sourceTurnId,
    role: 'user',
    content: params.envelope.content,
    timestamp: params.timestamp ?? Date.now(),
    attachments: params.envelope.attachments,
    metadata: {
      neoTag: {
        workCardId: params.result.detail.workCard.id,
        sourceConversationId: params.sourceConversationId,
        sourceTurnId: params.result.sourceTurnId,
      },
    },
  };
}

export async function submitNeoTagDraft(
  params: SubmitNeoTagDraftParams,
): Promise<CreateNeoWorkCardDraftResult | null> {
  const request = buildNeoWorkCardDraftRequest(params);
  if (!request) return null;
  return params.runNeoTag(request);
}

export interface SubmitNeoTagContinuationParams {
  envelope: ConversationEnvelope;
  conversationId: string;
  continuationTarget: { workCardId: string; title: string };
  requesterUserId: string;
  runContinuation: (input: ContinueNeoWorkCardRequest) => Promise<ContinueNeoWorkCardResult>;
}

/** @neo 续接（ADR-033）：chip 即意图，@neo 前缀可有可无；正文空则报人话错误。 */
export async function submitNeoTagContinuation(
  params: SubmitNeoTagContinuationParams,
): Promise<ContinueNeoWorkCardResult> {
  const parsed = parseLeadingNeoTagInvocation(params.envelope.content);
  const userText = (parsed ? parsed.userText : params.envelope.content).trim();
  if (!userText) {
    throw new Error('写一下要 Neo 接着做什么。');
  }
  return params.runContinuation({
    workCardId: params.continuationTarget.workCardId,
    conversationId: params.conversationId,
    userText,
    requesterUserId: params.requesterUserId,
    selectedArtifactIds: params.envelope.attachments?.map((attachment) => attachment.id) ?? [],
    clientSourceMessageId: params.envelope.clientMessageId,
  });
}

/** 续接轮本地补显：机制同 buildNeoTagSourceMessage（同 ID 落库去重）。 */
export function buildNeoTagContinuationMessage(params: {
  envelope: ConversationEnvelope;
  conversationId: string;
  workCardId: string;
  roundTurnId: string;
  timestamp?: number;
}): Message {
  return {
    id: params.roundTurnId,
    role: 'user',
    content: params.envelope.content,
    timestamp: params.timestamp ?? Date.now(),
    attachments: params.envelope.attachments,
    metadata: {
      neoTag: {
        workCardId: params.workCardId,
        sourceConversationId: params.conversationId,
        sourceTurnId: params.roundTurnId,
      },
    },
  };
}
