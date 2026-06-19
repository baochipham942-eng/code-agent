import { useCallback } from 'react';
import type { MessageAttachment } from '@shared/contract';
import type {
  ComposerAgentSelection,
  ComposerPromptCommandSelection,
  ConversationEnvelope,
  ConversationEnvelopeContext,
  ConversationVoiceInputMetadata,
  RuntimeInputMode,
} from '@shared/contract/conversationEnvelope';
import type { useWorkbenchBrowserSession } from '../../../../hooks/useWorkbenchBrowserSession';
import { parseLeadingAgentMentions } from './agentMentionRouting';
import { buildBrowserSessionIntentSnapshot } from '../../../../utils/browserExecutionIntent';

/** ChatInput 中 agent chip / 注册表条目的统一形态（id + name）。 */
interface BuildEnvelopeAgentEntry {
  id: string;
  name: string;
}

export interface UseChatInputEnvelopeParams {
  swarmAgents: Parameters<typeof parseLeadingAgentMentions>[1];
  agentEntries: readonly BuildEnvelopeAgentEntry[];
  activeAgentId: string | null;
  browserSession: ReturnType<typeof useWorkbenchBrowserSession>;
  voiceInputContext: { anchor: string; metadata: ConversationVoiceInputMetadata } | null;
  buildContext: () => ConversationEnvelopeContext | undefined;
  pendingPromptCommand: ComposerPromptCommandSelection | null;
  pendingAgentSelection: ComposerAgentSelection | null;
}

export type BuildEnvelope = (
  rawContent: string,
  nextAttachments?: MessageAttachment[],
  nextRuntimeInputMode?: RuntimeInputMode,
  preferredAgentIdOverride?: string | null,
  selectedAgentOverride?: ComposerAgentSelection | null,
) => ConversationEnvelope;

/**
 * 把 ChatInput 的消息封装逻辑（buildEnvelope）抽出为独立 hook：解析前导 @agent 提及、
 * 合并 composer 基础上下文、注入 voice/promptCommand/selectedAgent/浏览器会话/runtime 输入模式。
 * 行为与原组件内联 useCallback 完全一致，依赖经 params 注入。
 */
export function useChatInputEnvelope(params: UseChatInputEnvelopeParams): BuildEnvelope {
  const {
    swarmAgents,
    agentEntries,
    activeAgentId,
    browserSession,
    voiceInputContext,
    buildContext,
    pendingPromptCommand,
    pendingAgentSelection,
  } = params;

  return useCallback((
    rawContent: string,
    nextAttachments?: MessageAttachment[],
    nextRuntimeInputMode?: RuntimeInputMode,
    preferredAgentIdOverride?: string | null,
    selectedAgentOverride?: ComposerAgentSelection | null,
  ): ConversationEnvelope => {
    const parsedMentions = parseLeadingAgentMentions(rawContent, swarmAgents);
    const content = parsedMentions ? parsedMentions.content : rawContent.trim();
    const baseContext = buildContext();
    const voiceInput = voiceInputContext && rawContent.includes(voiceInputContext.anchor)
      ? voiceInputContext.metadata
      : undefined;
    const preferredAgentId = preferredAgentIdOverride === undefined ? activeAgentId : preferredAgentIdOverride;
    const hasExplicitAgentSelection = preferredAgentIdOverride !== undefined || activeAgentId !== null;
    const preferredAgent = preferredAgentId
      ? agentEntries.find((entry) => entry.id === preferredAgentId) ?? null
      : null;
    const promptCommand = pendingPromptCommand && content.startsWith(`/${pendingPromptCommand.name}`)
      ? pendingPromptCommand
      : undefined;
    let selectedAgent: ComposerAgentSelection | undefined;
    if (selectedAgentOverride !== undefined) {
      selectedAgent = selectedAgentOverride ?? undefined;
    } else if (hasExplicitAgentSelection && pendingAgentSelection?.id === preferredAgentId) {
      selectedAgent = pendingAgentSelection;
    } else if (hasExplicitAgentSelection && preferredAgent) {
      selectedAgent = {
        id: preferredAgent.id,
        name: preferredAgent.name,
        token: preferredAgent.name || preferredAgent.id,
        via: 'agent_chip',
      };
    } else if (hasExplicitAgentSelection && preferredAgentId === null) {
      selectedAgent = { id: null, name: 'Default', token: 'default', via: 'agent_command' };
    }
    const nextContext = parsedMentions
      ? {
          ...baseContext,
          ...(preferredAgentId ? { preferredAgentId } : {}),
          ...(preferredAgent?.name ? { preferredAgentName: preferredAgent.name } : {}),
          ...(selectedAgent ? { selectedAgent } : {}),
          ...(promptCommand ? { selectedPromptCommand: promptCommand } : {}),
          ...(voiceInput ? { voiceInput } : {}),
          routing: {
            mode: 'direct' as const,
            targetAgentIds: parsedMentions.targetAgentIds,
          },
        }
      : {
          ...baseContext,
          ...(preferredAgentId ? { preferredAgentId } : {}),
          ...(preferredAgent?.name ? { preferredAgentName: preferredAgent.name } : {}),
          ...(selectedAgent ? { selectedAgent } : {}),
          ...(promptCommand ? { selectedPromptCommand: promptCommand } : {}),
          ...(voiceInput ? { voiceInput } : {}),
        };
    const browserSessionMode = nextContext?.executionIntent?.browserSessionMode;
    const context = browserSessionMode
      ? {
          ...nextContext,
          executionIntent: {
            ...nextContext.executionIntent,
            browserSessionSnapshot: buildBrowserSessionIntentSnapshot({
              mode: browserSessionMode,
              browserSession,
            }),
          },
        }
      : nextContext;
    const runtimeScopedContext = nextRuntimeInputMode
      ? {
          ...context,
          runtimeInput: {
            mode: nextRuntimeInputMode,
          },
        }
      : context;

    return {
      content,
      attachments: nextAttachments && nextAttachments.length > 0 ? nextAttachments : undefined,
      context: runtimeScopedContext,
    };
  }, [
    activeAgentId,
    agentEntries,
    browserSession,
    buildContext,
    pendingAgentSelection,
    pendingPromptCommand,
    swarmAgents,
    voiceInputContext,
  ]);
}
