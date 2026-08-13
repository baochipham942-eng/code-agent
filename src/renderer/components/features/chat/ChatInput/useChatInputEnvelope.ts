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
import { useComposerStore } from '../../../../stores/composerStore';
import { useModeStore } from '../../../../stores/modeStore';

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
    // 命令 chip 快照（/goal 等）：提交链路稍后把它拼回正文前缀，这里随 envelope 进
    // context → message.metadata，回放时用户消息上方能渲染「这一轮用了什么命令」。
    // 读 getState 而非参数：发送瞬间的快照，不进入 useCallback 依赖（chip 变化不该重建 envelope builder）。
    const pendingCommandSnapshot = useComposerStore.getState().pendingCommand ?? undefined;
    const nextContext = parsedMentions
      ? {
          ...baseContext,
          ...(preferredAgentId ? { preferredAgentId } : {}),
          ...(preferredAgent?.name ? { preferredAgentName: preferredAgent.name } : {}),
          ...(selectedAgent ? { selectedAgent } : {}),
          ...(promptCommand ? { selectedPromptCommand: promptCommand } : {}),
          ...(pendingCommandSnapshot ? { pendingCommand: pendingCommandSnapshot } : {}),
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
          ...(pendingCommandSnapshot ? { pendingCommand: pendingCommandSnapshot } : {}),
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

    const modeState = useModeStore.getState();
    return {
      content,
      attachments: nextAttachments && nextAttachments.length > 0 ? nextAttachments : undefined,
      // 提交时取现值而非订阅快照：composer 常驻，订阅值会被 useCallback 依赖数组冻住。
      // 这是用户真实提交路径的逐轮联网开关（#1102 只接了 ChatView.buildEnvelope 的
      // 编辑/重发旁路，真机复验抓出主路径漏接）。
      searchEnabled: modeState.searchEnabled,
      thinkingEnabled: modeState.thinkingEnabled,
      ...(modeState.effortLevelExplicit ? { effortLevel: modeState.effortLevel } : {}),
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
