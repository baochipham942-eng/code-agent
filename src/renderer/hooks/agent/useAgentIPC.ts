// useAgentIPC owns send/cancel IPC calls and direct-routing metadata.
import { useCallback, type MutableRefObject } from 'react';
import { generateMessageId } from '@shared/utils/id';
import type { Message } from '@shared/contract';
import type {
  ConversationEnvelope,
  ConversationEnvelopeContext,
  RuntimeInputMode,
  WorkbenchMessageMetadata,
} from '@shared/contract/conversationEnvelope';
import type { MessageMetadata } from '@shared/contract/message';
import { normalizeDesignBrief, type DesignBrief } from '@shared/contract/designBrief';
import { directionTokens } from '@/design/direction-tokens';
import { IPC_CHANNELS } from '@shared/ipc';
import type { SwarmAgentState } from '@shared/contract/swarm';
import { createLogger } from '../../utils/logger';
import { useAppStore } from '../../stores/appStore';
import { useWorkspaceModeStore } from '../../stores/workspaceModeStore';
import { useDesignCanvasStore } from '../../components/design/designCanvasStore';
import { buildCanvasSnapshot } from '../../components/design/buildCanvasSnapshot';
import { useSessionStore } from '../../stores/sessionStore';
import { useSwarmStore } from '../../stores/swarmStore';
import { useTaskStore, type SessionStatus as TaskSessionStatus } from '../../stores/taskStore';
import { useTurnExecutionStore } from '../../stores/turnExecutionStore';
import { toast } from '../../hooks/useToast';
import ipcService from '../../services/ipcService';

const logger = createLogger('useAgent');

/**
 * Direct routing 目前不走 AppService 的 turnSystemContext，所以仍需要把 brief
 * prepend 到发送给目标 agent 的隐藏内容里。普通/interrupt 路径会走 context.designBrief。
 */
function formatDesignBriefReminder(brief: DesignBrief): string {
  const lines = [
    '<system-reminder kind="design-brief-json">',
    '当前会话已锁定 design brief，按此结构化 JSON 直接出 artifact，不要再 emit question-form。',
  ];
  if (brief.referenceScreenshot) {
    lines.push(
      '用户选择「匹配参考截图」模式：请查看用户在本轮附带的参考截图，从图中提取配色/字体/版式/间距并尽力复刻，而不是套用预设方向。',
    );
  }
  lines.push(JSON.stringify(brief, null, 2), '</system-reminder>');
  return lines.join('\n');
}

function applyDesignBriefToContent(content: string, brief: DesignBrief | undefined): string {
  if (!brief) return content;
  const reminder = formatDesignBriefReminder(brief);
  return `${reminder}\n\n${content}`;
}

function enrichDesignBrief(brief: DesignBrief | undefined): DesignBrief | undefined {
  if (!brief) return undefined;
  return normalizeDesignBrief({
    ...brief,
    directionTokens: brief.directionTokens || (brief.direction ? directionTokens[brief.direction] : undefined),
  });
}

function withDesignBriefContext(
  context: ConversationEnvelopeContext | undefined,
  brief: DesignBrief | undefined,
): ConversationEnvelopeContext | undefined {
  if (!brief) return context;
  return {
    ...(context || {}),
    designBrief: brief,
  };
}

// ADR-026 D1-B：design 模式发轮时附带画布快照，供 agent ProposeCanvasOps 引用真实节点 id。
// 仅 design 模式且画布非空时附带（避免无谓 prompt 膨胀）；运行时态，不进 DB。
function withCanvasSnapshotContext(
  context: ConversationEnvelopeContext | undefined,
): ConversationEnvelopeContext | undefined {
  if (useWorkspaceModeStore.getState().workspaceMode !== 'design') return context;
  const cs = useDesignCanvasStore.getState();
  if (cs.nodes.length === 0) return context;
  const canvasSnapshot = buildCanvasSnapshot({ nodes: cs.nodes, connectors: cs.connectors, shapes: cs.shapes });
  if (canvasSnapshot.nodes.length === 0) return context;
  return { ...(context || {}), canvasSnapshot };
}

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

export function isRuntimeBusyStatus(status: TaskSessionStatus | undefined): boolean {
  return status === 'running'
    || status === 'paused'
    || status === 'queued';
}

function isRuntimeCancellingStatus(status: TaskSessionStatus | undefined): boolean {
  return status === 'cancelling';
}

function markLatestUserMessageRunCancelled(cancelledAt: number): void {
  const sessionStore = useSessionStore.getState();
  const latestUser = [...sessionStore.messages]
    .reverse()
    .find((message) => message.role === 'user' && !message.isMeta);
  if (!latestUser) return;

  sessionStore.updateMessage(latestUser.id, {
    metadata: {
      ...latestUser.metadata,
      workbench: {
        ...latestUser.metadata?.workbench,
        runCancellation: {
          status: 'cancelled',
          cancelledAt,
          reason: 'user_cancelled',
        },
      },
    },
  });
}

export function getRuntimeFollowupFailureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || 'Unknown error');
  if (/already cancelling/i.test(raw)) {
    return '上一轮还在暂停或收尾，等它回到运行中再发。草稿还在输入框里。';
  }
  if (/agent not initialized|no active session|not initialized/i.test(raw)) {
    return '当前任务还没准备好接收引导消息，稍后再发一次。';
  }
  return `引导消息没发出去：${raw}`;
}

export function getAgentSendFailureMessage(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';
  const message = raw.trim();
  return message
    ? `Error: ${message}`
    : 'Error: 消息发送失败，但前端没有收到具体错误。请查看后台日志。';
}

export function getRuntimeInputMode(context?: ConversationEnvelopeContext): RuntimeInputMode {
  return context?.runtimeInput?.mode === 'redirect' ? 'redirect' : 'supplement';
}

export function getRuntimeInputSuccessMessage(mode: RuntimeInputMode): string {
  return mode === 'redirect' ? '已改道处理' : '已加入当前任务';
}

export function getRuntimeInputQueuedMessage(mode: RuntimeInputMode): string {
  return mode === 'redirect'
    ? '已排队，本轮回复结束后按这条重新处理。'
    : '已排队，本轮回复结束后作为下一条发送。';
}

export interface QueuedRuntimeInput {
  id: string;
  sessionId: string;
  envelope: ConversationEnvelope;
  content: string;
  mode: RuntimeInputMode;
  attachmentsCount: number;
  createdAt: number;
}

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
  if (context.preferredAgentId !== undefined) {
    metadata.preferredAgentId = context.preferredAgentId;
  }
  if (context.preferredAgentName !== undefined) {
    metadata.preferredAgentName = context.preferredAgentName;
  }
  if (context.selectedAgent) {
    metadata.selectedAgent = { ...context.selectedAgent };
  }
  if (context.selectedPromptCommand) {
    metadata.selectedPromptCommand = {
      ...context.selectedPromptCommand,
      hints: context.selectedPromptCommand.hints ? [...context.selectedPromptCommand.hints] : undefined,
    };
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
  if (context.turnCapabilityScopeMode) {
    metadata.turnCapabilityScopeMode = context.turnCapabilityScopeMode;
  }
  if (context.designBrief) {
    metadata.designBrief = context.designBrief;
  }
  if (context.executionIntent) {
    metadata.executionIntent = {
      ...context.executionIntent,
    };
  }
  if (context.runtimeInput) {
    metadata.runtimeInputMode = context.runtimeInput.mode;
    if (context.runtimeInput.delivery) {
      metadata.runtimeInputDelivery = context.runtimeInput.delivery;
    }
  }
  if (context.voiceInput) {
    metadata.voiceInput = { ...context.voiceInput };
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
  enqueueRuntimeInput: (input: QueuedRuntimeInput) => void;
  isProcessing: boolean;
  setIsProcessing: AppStoreState['setIsProcessing'];
  setSessionProcessing: AppStoreState['setSessionProcessing'];
}

export function useAgentIPC({
  addMessage,
  currentSessionId,
  currentTurnMessageIdRef,
  enqueueRuntimeInput,
  isProcessing,
  setIsProcessing,
  setSessionProcessing,
}: UseAgentIPCArgs) {
  // Send a message to the agent
  // Turn-based model: 不再预创建 placeholder，等待后端 turn_start 事件
  // 运行中继续发送时，排队到当前回复结束后作为下一轮用户消息发送
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
      let effectiveSessionId = envelope.sessionId ?? currentSessionId;
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

      // 读取当前 session 锁定的 design brief（来自 question-form 提交，仅运行时内存态）。
      // 三条 IPC 路径（direct routing / runtime follow-up / auto）都会在 content 前面 prepend
      // 一段 <system-reminder> 让下一轮 LLM 按 brief 出 artifact，不进 store/DB。
      const sessionDesignBrief = enrichDesignBrief(effectiveSessionId
        ? useSessionStore.getState().getSessionDesignBrief(effectiveSessionId)
        : undefined);
      const contextWithDesignBrief = withCanvasSnapshotContext(
        withDesignBriefContext(context, sessionDesignBrief),
      );

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
          metadata: toMessageMetadata(contextWithDesignBrief, directRouting.targets, directRouting.missingTargetIds),
        };
        addMessage(userMessage);

        const rollbackDirectMessage = () => {
          const sessionState = useSessionStore.getState();
          sessionState.setMessages(sessionState.messages.filter((message) => message.id !== userMessage.id));
        };

        try {
          const directMessage = applyDesignBriefToContent(content.trim(), sessionDesignBrief);
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
        ? (
            useAppStore.getState().isSessionProcessing(effectiveSessionId)
            || isRuntimeBusyStatus(useTaskStore.getState().sessionStates[effectiveSessionId]?.status)
          )
        : isProcessing;
      const currentTaskStatus = effectiveSessionId
        ? useTaskStore.getState().sessionStates[effectiveSessionId]?.status
        : undefined;

      if (isRuntimeCancellingStatus(currentTaskStatus)) {
        throw new Error('Session is already cancelling');
      }

      // 运行中发送的新输入默认排到下一轮，当前流式回复继续完成。
      if (isCurrentSessionProcessing) {
        const runtimeInputMode = getRuntimeInputMode(contextWithDesignBrief);
        logger.info('sendMessage - session processing, queueing runtime input for next turn', {
          isCurrentSessionProcessing,
          runtimeInputMode,
        });

        const queuedMessageId = generateMessageId();
        const queuedContext: ConversationEnvelopeContext | undefined = contextWithDesignBrief
          ? {
              ...contextWithDesignBrief,
              runtimeInput: {
                mode: runtimeInputMode,
                delivery: 'queued_next_turn',
              },
            }
          : {
              runtimeInput: {
                mode: runtimeInputMode,
                delivery: 'queued_next_turn',
              },
            };
        enqueueRuntimeInput({
          id: queuedMessageId,
          sessionId: effectiveSessionId!,
          envelope: {
            ...envelope,
            content: envelope.content,
            attachments,
            context: queuedContext,
            clientMessageId: queuedMessageId,
            sessionId: effectiveSessionId!,
          },
          content,
          mode: runtimeInputMode,
          attachmentsCount: attachments?.length || 0,
          createdAt: Date.now(),
        });
        toast.info(getRuntimeInputQueuedMessage(runtimeInputMode));
        return;
      }

      // Add user message with UUID
      const userMessage: Message = {
        id: generateMessageId(),
        role: 'user',
        content,
        timestamp: Date.now(),
        attachments,
        metadata: toMessageMetadata(contextWithDesignBrief),
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
      useTaskStore.getState().updateSessionState(effectiveSessionId!, {
        status: 'running',
        startTime: Date.now(),
      });
      currentTurnMessageIdRef.current = null; // 重置 turn tracking

      try {
        // Send to main process
        // Note: Don't set isProcessing to false here, it will be set by agent_complete event
        logger.debug('Calling invoke agent:send-message');
        const messagePayload: ConversationEnvelope = {
          ...envelope,
          clientMessageId: userMessage.id,
          context: contextWithDesignBrief,
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
          content: getAgentSendFailureMessage(error),
          timestamp: Date.now(),
        };
        addMessage(errorMessage);
        // 按会话清除处理状态
        setSessionProcessing(effectiveSessionId!, false);
        // taskStore 也必须重置，否则会话永远卡在 'running'：
        // 后续消息全部进入"运行中排队"分支但没有 run 去消费，表现为永远不回复
        useTaskStore.getState().updateSessionState(effectiveSessionId!, {
          status: 'error',
          error: String(error),
        });
      }
    },
    [addMessage, enqueueRuntimeInput, setSessionProcessing, isProcessing, currentSessionId]
  );

  // Cancel the current operation
  const cancel = useCallback(async () => {
    const targetSessionId = currentSessionId;
    try {
      if (targetSessionId) {
        const currentState = useTaskStore.getState().sessionStates[targetSessionId];
        useTaskStore.getState().updateSessionState(targetSessionId, {
          ...currentState,
          status: 'cancelling',
        });
        markLatestUserMessageRunCancelled(Date.now());
      }
      await ipcService.invoke('agent:cancel', targetSessionId ? { sessionId: targetSessionId } : undefined);
      // 按会话清除处理状态
      if (targetSessionId) {
        useTaskStore.getState().updateSessionState(targetSessionId, { status: 'cancelled' });
        setSessionProcessing(targetSessionId, false);
      } else {
        setIsProcessing(false);
      }
    } catch (error) {
      logger.error('Cancel error', error);
      if (targetSessionId) {
        useTaskStore.getState().updateSessionState(targetSessionId, { status: 'idle' });
      }
    }
  }, [setIsProcessing, setSessionProcessing, currentSessionId]);

  return {
    sendMessage,
    cancel,
  };
}
