import type { ConversationEnvelope } from '@shared/contract/conversationEnvelope';
import type {
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
  createDraft: (input: CreateNeoWorkCardDraftRequest) => Promise<CreateNeoWorkCardDraftResult>;
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
  const projectScope = params.projectId || workspacePath || 'current-project';
  const attachmentIds = params.envelope.attachments?.map((attachment) => attachment.id) ?? [];

  return {
    projectId: params.projectId ?? null,
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

export async function submitNeoTagDraft(
  params: SubmitNeoTagDraftParams,
): Promise<CreateNeoWorkCardDraftResult | null> {
  const request = buildNeoWorkCardDraftRequest(params);
  if (!request) return null;
  return params.createDraft(request);
}
