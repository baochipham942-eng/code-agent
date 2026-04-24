// useAgentIPC owns send/cancel IPC calls and direct-routing metadata.
import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { generateMessageId } from '@shared/utils/id';
import type { Message } from '@shared/contract';
import type { ConversationEnvelope, ConversationEnvelopeContext, WorkbenchMessageMetadata } from '@shared/contract/conversationEnvelope';
import type { MessageMetadata } from '@shared/contract/message';
import { IPC_CHANNELS } from '@shared/ipc';
import type { SwarmAgentState } from '@shared/contract/swarm';
import { createLogger } from '../../utils/logger';
import { useAppStore } from '../../stores/appStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSwarmStore } from '../../stores/swarmStore';
import { useTurnExecutionStore } from '../../stores/turnExecutionStore';
import ipcService from '../../services/ipcService';

const logger = createLogger('useAgent');

type AppStoreState = ReturnType<typeof useAppStore.getState>;
type SessionStoreState = ReturnType<typeof useSessionStore.getState>;

type DirectRoutingTarget = Pick<SwarmAgentState, 'id' | 'name'>;

type DirectRoutingResolution =
  | { kind: 'skip' }
  | {
      kind: 'error';
      reason: 'missing-target' | 'attachments-not-supported' | 'targets-unavailable';
      targetIds: string[];
    }
  | {
      kind: 'send';
      targets: DirectRoutingTarget[];
      targetIds: string[];
      missingTargetIds: string[];
    };

export function resolveDirectRouting(
  envelope: ConversationEnvelope,
  agents: DirectRoutingTarget[],
): DirectRoutingResolution {
  const routing = envelope.context?.routing;
  if (routing?.mode !== 'direct') {
    return { kind: 'skip' };
  }

  if ((envelope.attachments?.length || 0) > 0) {
    return {
      kind: 'error',
      reason: 'attachments-not-supported',
      targetIds: routing.targetAgentIds || [],
    };
  }

  const targetIds = Array.from(new Set(routing.targetAgentIds || []));
  if (targetIds.length === 0) {
    return {
      kind: 'error',
      reason: 'missing-target',
      targetIds,
    };
  }

  const agentMap = new Map(agents.map((agent) => [agent.id, agent]));
  const targets = targetIds
    .map((id) => agentMap.get(id))
    .filter((agent): agent is DirectRoutingTarget => Boolean(agent));

  if (targets.length === 0) {
    return {
      kind: 'error',
      reason: 'targets-unavailable',
      targetIds,
    };
  }

  return {
    kind: 'send',
    targets,
    targetIds,
    missingTargetIds: targetIds.filter((id) => !agentMap.has(id)),
  };
}

function toWorkbenchMetadata(
  context?: ConversationEnvelopeContext,
  directTargets: DirectRoutingTarget[] = [],
  missingTargetIds: string[] = [],
): WorkbenchMessageMetadata | undefined {
  if (!context) return undefined;

  const metadata: WorkbenchMessageMetadata = {};

  if (context.workingDirectory !== undefined) {
    metadata.workingDirectory = context.workingDirectory;
  }
  if (context.routing) {
    metadata.routingMode = context.routing.mode;
    if (context.routing.targetAgentIds?.length) {
      metadata.targetAgentIds = [...context.routing.targetAgentIds];
      if (directTargets.length > 0) {
        metadata.targetAgentNames = directTargets.map((target) => target.name);
      }
    }
    if (context.routing.mode === 'direct' && (directTargets.length > 0 || missingTargetIds.length > 0)) {
      metadata.directRoutingDelivery = {
        deliveredTargetIds: directTargets.map((target) => target.id),
        ...(directTargets.length > 0
          ? { deliveredTargetNames: directTargets.map((target) => target.name) }
          : {}),
        ...(missingTargetIds.length > 0 ? { missingTargetIds: [...missingTargetIds] } : {}),
      };
    }
  }
  if (context.selectedSkillIds?.length) {
    metadata.selectedSkillIds = [...context.selectedSkillIds];
  }
  if (context.selectedConnectorIds?.length) {
    metadata.selectedConnectorIds = [...context.selectedConnectorIds];
  }
  if (context.selectedMcpServerIds?.length) {
    metadata.selectedMcpServerIds = [...context.selectedMcpServerIds];
  }
  if (context.executionIntent) {
    metadata.executionIntent = {
      ...context.executionIntent,
    };
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function toMessageMetadata(
  context?: ConversationEnvelopeContext,
  directTargets: DirectRoutingTarget[] = [],
  missingTargetIds: string[] = [],
): MessageMetadata | undefined {
  const workbench = toWorkbenchMetadata(context, directTargets, missingTargetIds);
  return workbench ? { workbench } : undefined;
}

interface UseAgentIPCArgs {
  addMessage: SessionStoreState['addMessage'];
  currentSessionId: string | null;
  currentTurnMessageIdRef: MutableRefObject<string | null>;
  isProcessing: boolean;
  setIsInterrupting: Dispatch<SetStateAction<boolean>>;
  setIsProcessing: AppStoreState['setIsProcessing'];
  setSessionProcessing: AppStoreState['setSessionProcessing'];
}

export function useAgentIPC({
  addMessage,
  currentSessionId,
  currentTurnMessageIdRef,
  isProcessing,
  setIsInterrupting,
  setIsProcessing,
  setSessionProcessing,
}: UseAgentIPCArgs) {
  // Send a message to the agent
  // Turn-based model: 不再预创建 placeholder，等待后端 turn_start 事件
  // Claude Code 风格：如果正在处理中，自动触发中断
  const sendMessage = useCallback(
    async (envelope: ConversationEnvelope) => {
      const { content, attachments, context } = envelope;
      logger.debug('sendMessage called', { contentPreview: content.substring(0, 50), sessionId: currentSessionId });

      // 空消息检查
      if (!content.trim() && !attachments?.length) {
        logger.debug('sendMessage blocked - empty content');
        return;
      }

      // 没有会话时自动创建一个（web 模式下数据库可能未初始化，使用临时会话）
      let effectiveSessionId = currentSessionId;
      if (!effectiveSessionId) {
        logger.warn('sendMessage - no current session, creating fallback');
        const sessionStore = useSessionStore.getState();
        const created = await sessionStore.createSession('新对话');
        if (created) {
          effectiveSessionId = created.id;
        } else {
          // 数据库不可用时，设置一个临时 sessionId 让消息流程继续
          const tempId = `web-session-${Date.now()}`;
          logger.warn('sendMessage - session creation failed, using temp sessionId', { tempId });
          useSessionStore.setState({ currentSessionId: tempId });
          effectiveSessionId = tempId;
        }
      }

      const swarmAgents = useSwarmStore.getState().agents;
      const directRouting = resolveDirectRouting(envelope, swarmAgents);

      if (directRouting.kind === 'error') {
        const errorContent =
          directRouting.reason === 'attachments-not-supported'
            ? 'Direct 路由暂不支持附件，先去掉附件，或切回 Auto / Parallel。'
            : directRouting.reason === 'missing-target'
              ? 'Direct 模式还没选中 agent，先在输入框上方选一个目标 agent。'
              : 'Direct 模式选中的 agent 当前不可用，先检查 swarm 是否仍在运行。';

        addMessage({
          id: generateMessageId(),
          role: 'assistant',
          content: errorContent,
          timestamp: Date.now(),
        });
        return;
      }

      if (directRouting.kind === 'send') {
        const userMessage: Message = {
          id: generateMessageId(),
          role: 'user',
          content,
          timestamp: Date.now(),
          metadata: toMessageMetadata(context, directRouting.targets, directRouting.missingTargetIds),
        };
        addMessage(userMessage);

        const rollbackDirectMessage = () => {
          const sessionState = useSessionStore.getState();
          sessionState.setMessages(sessionState.messages.filter((message) => message.id !== userMessage.id));
        };

        try {
          const directMessage = content.trim();
          const results = await Promise.all(
            directRouting.targets.map((target) =>
              ipcService.invoke(IPC_CHANNELS.SWARM_SEND_USER_MESSAGE, {
                agentId: target.id,
                message: directMessage,
                sessionId: effectiveSessionId || undefined,
                messageId: userMessage.id,
                timestamp: userMessage.timestamp,
                metadata: userMessage.metadata,
              }),
            ),
          );

          const delivered = results.some((result) => result?.delivered);
          const persisted = effectiveSessionId
            ? results.some((result) => result?.persisted)
            : true;

          if (!delivered || !persisted) {
            throw new Error('Direct routing was not persisted to the current session');
          }

          if (effectiveSessionId) {
            useTurnExecutionStore.getState().recordRoutingEvidence(effectiveSessionId, {
              kind: 'direct',
              mode: 'direct',
              timestamp: userMessage.timestamp,
              turnMessageId: userMessage.id,
              targetAgentIds: directRouting.targetIds,
              targetAgentNames: directRouting.targets.map((target) => target.name),
              deliveredTargetIds: directRouting.targets.map((target) => target.id),
              missingTargetIds: directRouting.missingTargetIds,
            });
          }

          useAppStore.getState().setSelectedSwarmAgentId(directRouting.targets[0]?.id || null);

          if (directRouting.missingTargetIds.length > 0) {
            addMessage({
              id: generateMessageId(),
              role: 'assistant',
              content: `已发送给 ${directRouting.targets.map((target) => target.name).join('、')}。未命中 ${directRouting.missingTargetIds.join('、')}。`,
              timestamp: Date.now(),
            });
          }
        } catch (error) {
          rollbackDirectMessage();
          addMessage({
            id: generateMessageId(),
            role: 'assistant',
            content: 'Direct 路由发送失败，当前消息没有写入会话。请重试，或切回 Auto / Parallel。',
            timestamp: Date.now(),
          });
          logger.error('direct routing send failed', error);
        }
        return;
      }

      // 检查当前会话是否正在处理（允许其他会话并发发送）
      const isCurrentSessionProcessing = effectiveSessionId
        ? useAppStore.getState().isSessionProcessing(effectiveSessionId)
        : isProcessing;

      // Claude Code 风格：如果正在处理中，触发中断并继续新消息
      if (isCurrentSessionProcessing) {
        logger.info('sendMessage - session processing, triggering interrupt', { isCurrentSessionProcessing });

        // 添加用户消息到界面
        const userMessage: Message = {
          id: generateMessageId(),
          role: 'user',
          content,
          timestamp: Date.now(),
          attachments,
          metadata: toMessageMetadata(context),
        };
        addMessage(userMessage);

        setIsInterrupting(true);
        try {
          // 调用 interrupt action，后端会中断当前任务并继续新消息
          await ipcService.invokeDomain<void>('agent', 'interrupt', {
            ...envelope,
            sessionId: effectiveSessionId,
          });
          logger.debug('interrupt invoke returned');
        } catch (error) {
          logger.error('Interrupt error', error);
          setIsInterrupting(false);
          // 清除 processing 状态，避免永久卡死
          setSessionProcessing(effectiveSessionId!, false);
          // 错误时创建一条错误消息
          const errorMessage: Message = {
            id: generateMessageId(),
            role: 'assistant',
            content: `中断失败: ${error instanceof Error ? error.message : 'Unknown error'}`,
            timestamp: Date.now(),
          };
          addMessage(errorMessage);
        }
        return;
      }

      // Add user message with UUID
      const userMessage: Message = {
        id: generateMessageId(),
        role: 'user',
        content,
        timestamp: Date.now(),
        attachments,
        metadata: toMessageMetadata(context),
      };
      logger.debug('Adding user message', { id: userMessage.id, attachmentsCount: attachments?.length || 0 });
      addMessage(userMessage);

      // 不再预创建 assistant placeholder
      // 后端会在每轮迭代开始时发送 turn_start 事件，前端据此创建消息
      // 这样可以确保：
      // 1. 每轮 Agent Loop 对应一条消息
      // 2. 工具调用后的新响应会创建新消息，而不是追加到旧消息

      // 按会话设置处理状态（允许多会话并发）
      setSessionProcessing(effectiveSessionId!, true);
      currentTurnMessageIdRef.current = null; // 重置 turn tracking

      try {
        // Send to main process
        // Note: Don't set isProcessing to false here, it will be set by agent_complete event
        logger.debug('Calling invoke agent:send-message');
        const messagePayload: ConversationEnvelope = {
          ...envelope,
          sessionId: effectiveSessionId,
        };
        logger.debug('messagePayload', { type: typeof messagePayload, isObject: typeof messagePayload === 'object' });
        if (typeof messagePayload === 'object') {
          logger.debug('Attachments being sent', { attachments: attachments?.map(a => ({ name: a.name, category: a.category, hasData: !!a.data, dataLen: a.data?.length, path: a.path, hasPath: !!a.path })) });
        }
        await ipcService.invoke('agent:send-message', messagePayload);
        logger.debug('invoke returned');
      } catch (error) {
        logger.error('Agent error', error);
        // 错误时创建一条错误消息
        const errorMessage: Message = {
          id: generateMessageId(),
          role: 'assistant',
          content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          timestamp: Date.now(),
        };
        addMessage(errorMessage);
        // 按会话清除处理状态
        setSessionProcessing(effectiveSessionId!, false);
      }
    },
    [addMessage, setSessionProcessing, isProcessing, currentSessionId]
  );

  // Cancel the current operation
  const cancel = useCallback(async () => {
    try {
      await ipcService.invoke('agent:cancel', currentSessionId ? { sessionId: currentSessionId } : undefined);
      // 按会话清除处理状态
      if (currentSessionId) {
        setSessionProcessing(currentSessionId, false);
      } else {
        setIsProcessing(false);
      }
    } catch (error) {
      logger.error('Cancel error', error);
    }
  }, [setIsProcessing, setSessionProcessing, currentSessionId]);

  return {
    sendMessage,
    cancel,
  };
}
