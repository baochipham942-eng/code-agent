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
import type { SteerOrQueueOutcome } from '@shared/contract/appService';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import { VoiceSchemas } from '@shared/ipc/schemas';
import type { SwarmAgentState } from '@shared/contract/swarm';
import { createLogger } from '../../utils/logger';
import { useAppStore } from '../../stores/appStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSwarmStore } from '../../stores/swarmStore';
import { useTaskStore } from '../../stores/taskStore';
import { readInstalledVoiceCall } from '../useVoiceLiveRuntime';
import { useTurnExecutionStore } from '../../stores/turnExecutionStore';
import ipcService from '../../services/ipcService';
import { typedInvokeDomain } from '../../services/typedInvoke';
import { useI18n } from '../useI18n';
import { interpolate } from '../../i18n/interpolate';
import {
  applyDesignAcceptanceContractToContent,
  applyDesignBriefToContent,
  applyDesignCanvasSessionToContent,
  applyDesignCodeHandoffToContent,
  enrichDesignBrief,
  withCanvasSnapshotContext,
  withDesignBriefContext,
  withDesignCanvasActiveIntent,
  withHandoffContext,
} from './agentDesignContext';
import {
  getAgentSendFailureMessage,
  getRuntimeInputMode,
  isDurableRunRolloutUnavailable,
  isRuntimeBusyStatus,
  isRuntimeCancellingStatus,
  isSessionBusyRunConflict,
  markLatestUserMessageRunCancelled,
  requestCancelUntilSettled,
  resolveEffectiveSessionIdForSend,
  waitForDurableRunReady,
  type CancelSettlementResponse,
} from './agentRuntimeFollowup';
import {
  chatSendInflightKey,
  claimSendInflight,
  type ChatSendDelivery,
} from '../../utils/chatSendState';
import {
  buildSendFailureRetryAnchor,
  markOptimisticUserSendFailed,
  replaceOptimisticUserMessage,
  upsertOptimisticUserMessage,
} from '../../utils/optimisticUserSend';

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

export function getRuntimeInputSuccessMessage(mode: RuntimeInputMode): string {
  return mode === 'redirect' ? '已改道处理' : '已加入当前任务';
}

export interface SendMessageOptions {
  silentFailure?: boolean;
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
  if (context.pendingCommand) {
    metadata.pendingCommand = { ...context.pendingCommand };
  }
  if (context.routing) {
    metadata.routingMode = context.routing.mode;
    if (context.routing.targetAgentIds?.length) {
      metadata.targetAgentIds = [...context.routing.targetAgentIds];
      if (directTargets.length > 0) {
        metadata.targetAgentNames = directTargets.map((target) => target.name);
      }
    }
    // targetAgentIds are routing intent. Actual delivery evidence is recorded
    // only after Host replies; preflight candidates must never be persisted as
    // delivered because a target can finish between availability check and send.
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
  if (context.designAcceptanceContract) {
    metadata.designAcceptanceContract = context.designAcceptanceContract;
  }
  if (context.designCodeHandoff) {
    metadata.designCodeHandoff = context.designCodeHandoff;
  }
  if (context.executionIntent) {
    metadata.executionIntent = {
      ...context.executionIntent,
    };
  }
  if (context.runtimeInput) {
    metadata.runtimeInputMode = context.runtimeInput.mode;
  }
  if (context.voiceInput) {
    metadata.voiceInput = { ...context.voiceInput };
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function toMessageMetadata(
  context?: ConversationEnvelopeContext,
  directTargets: DirectRoutingTarget[] = [],
): MessageMetadata | undefined {
  const workbench = toWorkbenchMetadata(context, directTargets);
  return workbench ? { workbench } : undefined;
}

interface UseAgentIPCArgs {
  addMessage: SessionStoreState['addMessage'];
  currentSessionId: string | null;
  currentTurnMessageIdRef: MutableRefObject<string | null>;
  isProcessing: boolean;
  setIsProcessing: AppStoreState['setIsProcessing'];
  setSessionProcessing: AppStoreState['setSessionProcessing'];
}

export function useAgentIPC({
  addMessage,
  currentSessionId,
  currentTurnMessageIdRef,
  isProcessing,
  setIsProcessing,
  setSessionProcessing,
}: UseAgentIPCArgs) {
  const { t } = useI18n();
  // Send a message to the agent
  // Turn-based model: 不再预创建 placeholder，等待后端 turn_start 事件
  // 运行中继续发送时，直接交给前台 brain；短暂拒收由 host 输入投递层缓冲重投。
  const sendMessage = useCallback(
    async (envelope: ConversationEnvelope, options?: SendMessageOptions) => {
      // 外层只用 content/attachments 做空消息检查；context 在 claimSendInflight 内层
      // 重新解构后才用得上，这里带上它就是个未用变量（eslint 棘轮 +1）。
      const { content, attachments } = envelope;
      logger.debug('sendMessage called', { contentPreview: content.substring(0, 50), sessionId: currentSessionId });

      // 空消息检查
      if (!content.trim() && !attachments?.length) {
        logger.debug('sendMessage blocked - empty content');
        return { outcome: 'failed' as const };
      }

      // 建会话竞态：点「新会话」后 create 尚未完成时，composer 仍挂在旧 currentSessionId。
      // await 进行中的 create 并把消息绑到新会话；运行会话 = composer 会话重新成立。
      if (useSessionStore.getState().getPendingSessionCreate()) {
        logger.info('sendMessage - awaiting in-flight session create before bind');
      }
      const effectiveSessionId = await resolveEffectiveSessionIdForSend({
        envelopeSessionId: envelope.sessionId,
        getCurrentSessionId: () => useSessionStore.getState().currentSessionId,
        getPendingSessionCreate: () => useSessionStore.getState().getPendingSessionCreate(),
        createFallbackSession: async () => {
          logger.warn('sendMessage - no current session, creating fallback');
          const created = await useSessionStore.getState().createSession('新对话');
          if (!created) {
            const tempId = `web-session-${Date.now()}`;
            logger.warn('sendMessage - session creation failed, using temp sessionId', { tempId });
            useSessionStore.setState({ currentSessionId: tempId });
            return { id: tempId };
          }
          return created;
        },
      });

      const clientMessageId = envelope.clientMessageId ?? generateMessageId();
      const outboundEnvelope: ConversationEnvelope = {
        ...envelope,
        clientMessageId,
        sessionId: effectiveSessionId ?? envelope.sessionId,
      };

      return claimSendInflight(
        chatSendInflightKey(effectiveSessionId ?? 'none', clientMessageId),
        async (): Promise<ChatSendDelivery> => {
      const envelope = outboundEnvelope;
      const { content, attachments, context } = envelope;
      const swarmState = useSwarmStore.getState();
      const sessionSnapshot = swarmState.activeSessionId === effectiveSessionId && swarmState.activeRunId
        ? {
            runId: swarmState.activeRunId,
            agents: swarmState.agents,
          }
        : Object.values(swarmState.runSnapshots)
            .filter((snapshot) => snapshot.sessionId === effectiveSessionId)
            .sort((left, right) => {
              if (left.isRunning !== right.isRunning) return left.isRunning ? -1 : 1;
              return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
            })[0];
      const swarmAgents = sessionSnapshot?.agents ?? [];
      const directRouting = resolveDirectRouting(envelope, swarmAgents);

      // 读取当前 session 锁定的 design brief（来自 question-form 提交，仅运行时内存态）。
      // 三条 IPC 路径（direct routing / runtime follow-up / auto）都会在 content 前面 prepend
      // 一段 <system-reminder> 让下一轮 LLM 按 brief 出 artifact，不进 store/DB。
      const sessionDesignBrief = enrichDesignBrief(effectiveSessionId
        ? useSessionStore.getState().getSessionDesignBrief(effectiveSessionId)
        : undefined);
      const contextWithDesignContext = withDesignCanvasActiveIntent(
        withHandoffContext(
          withCanvasSnapshotContext(
            withDesignBriefContext(context, sessionDesignBrief),
          ),
        ),
        effectiveSessionId,
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
        return { outcome: 'failed' as const };
      }

      if (directRouting.kind === 'send') {
        const directRunId = sessionSnapshot!.runId;
        const isDirectScopeActive = () => {
          const sessionState = useSessionStore.getState();
          const currentSwarm = useSwarmStore.getState();
          return sessionState.currentSessionId === effectiveSessionId
            && currentSwarm.activeSessionId === effectiveSessionId
            && currentSwarm.activeRunId === directRunId;
        };
        const addDirectMessage = (message: Message) => {
          if (isDirectScopeActive()) useSessionStore.getState().addMessage(message);
        };
        const userMessage: Message = {
          id: generateMessageId(),
          role: 'user',
          content,
          timestamp: Date.now(),
          metadata: toMessageMetadata(contextWithDesignContext, directRouting.targets),
        };
        addDirectMessage(userMessage);

        const rollbackDirectMessage = () => {
          if (!isDirectScopeActive()) return;
          const sessionState = useSessionStore.getState();
          sessionState.setMessages(sessionState.messages.filter((message) => message.id !== userMessage.id));
        };

        try {
          const directMessage = applyDesignCanvasSessionToContent(
            applyDesignCodeHandoffToContent(
              applyDesignAcceptanceContractToContent(
                applyDesignBriefToContent(content.trim(), sessionDesignBrief),
                contextWithDesignContext?.designAcceptanceContract,
              ),
              contextWithDesignContext?.designCodeHandoff,
            ),
            effectiveSessionId,
          );
          const results = await Promise.allSettled(
            directRouting.targets.map((target) =>
              Promise.resolve().then(() => ipcService.invoke(IPC_CHANNELS.SWARM_SEND_USER_MESSAGE, {
                agentId: target.id,
                message: directMessage,
                sessionId: effectiveSessionId!,
                runId: directRunId,
                messageId: userMessage.id,
                timestamp: userMessage.timestamp,
                metadata: userMessage.metadata,
              })),
            ),
          );

          const deliveredTargets = directRouting.targets.filter((_, index) => {
            const result = results[index];
            return result?.status === 'fulfilled' && Boolean(result.value?.delivered);
          });
          // Multi-target Direct uses one canonical session message. A single
          // successful persistence makes that shared turn durable for every
          // delivered target; duplicate inserts on later targets are idempotent.
          const canonicalPersisted = results.some((result) => (
            result.status === 'fulfilled' && Boolean(result.value?.persisted)
          ));
          const unpersistedTargetIds = canonicalPersisted
            ? []
            : deliveredTargets.map((target) => target.id);
          const failedTargetIds = directRouting.targets
            .filter((_, index) => {
              const result = results[index];
              return result?.status === 'rejected' || !result?.value?.delivered;
            })
            .map((target) => target.id);

          if (deliveredTargets.length === 0) {
            rollbackDirectMessage();
            const externalFailure = results.find((result) => (
              result.status === 'fulfilled' && result.value?.failure?.code === 'external_engine'
            ));
            const externalLabel = externalFailure?.status === 'fulfilled'
              ? externalFailure.value.failure?.engineLabel
              : undefined;
            addDirectMessage({
              id: generateMessageId(),
              role: 'assistant',
              content: externalLabel
                ? interpolate(t.expert.memberBar.rejectExternalEngine, { engine: externalLabel })
                : 'Direct 路由发送失败，消息未送达，也没有写入当前 Team 记录。请重试，或切回 Auto / Parallel。',
              timestamp: Date.now(),
            });
            return { outcome: 'failed' as const };
          }

          if (effectiveSessionId) {
            useTurnExecutionStore.getState().recordRoutingEvidence(effectiveSessionId, {
              kind: 'direct',
              mode: 'direct',
              timestamp: userMessage.timestamp,
              turnMessageId: userMessage.id,
              targetAgentIds: directRouting.targetIds,
              targetAgentNames: directRouting.targets.map((target) => target.name),
              deliveredTargetIds: deliveredTargets.map((target) => target.id),
              missingTargetIds: [...directRouting.missingTargetIds, ...failedTargetIds],
            });
          }

          if (isDirectScopeActive()) {
            useAppStore.getState().setSelectedSwarmAgentId(deliveredTargets[0]?.id || null);
          }

          const undeliveredTargetIds = [...directRouting.missingTargetIds, ...failedTargetIds];
          if (undeliveredTargetIds.length > 0 || unpersistedTargetIds.length > 0) {
            const details = [
              undeliveredTargetIds.length > 0 ? `未送达 ${undeliveredTargetIds.join('、')}` : '',
              unpersistedTargetIds.length > 0
                ? `已送达但未写入 Team 记录 ${unpersistedTargetIds.join('、')}`
                : '',
            ].filter(Boolean).join('；');
            addDirectMessage({
              id: generateMessageId(),
              role: 'assistant',
              content: `已发送给 ${deliveredTargets.map((target) => target.name).join('、')}。${details}。`,
              timestamp: Date.now(),
            });
          }
        } catch (error) {
          rollbackDirectMessage();
          addDirectMessage({
            id: generateMessageId(),
            role: 'assistant',
            content: 'Direct 路由发送失败，消息未送达，也没有写入当前 Team 记录。请重试，或切回 Auto / Parallel。',
            timestamp: Date.now(),
          });
          logger.error('direct routing send failed', error);
          return { outcome: 'failed' as const };
        }
        return { outcome: 'sent' as const };
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

      const deliverToForegroundBrain = async (
        clientMessageId?: string,
      ): Promise<ChatSendDelivery> => {
        const runtimeInputMode = getRuntimeInputMode(contextWithDesignContext);
        const messageId = clientMessageId ?? generateMessageId();
        const runtimeContext: ConversationEnvelopeContext | undefined = contextWithDesignContext
          ? {
              ...contextWithDesignContext,
              runtimeInput: { mode: runtimeInputMode },
            }
          : { runtimeInput: { mode: runtimeInputMode } };
        const runtimeEnvelope: ConversationEnvelope = {
          ...envelope,
          content: envelope.content,
          attachments,
          context: runtimeContext,
          clientMessageId: messageId,
          sessionId: effectiveSessionId!,
        };
        try {
          const outcome = await ipcService.invokeDomain<SteerOrQueueOutcome>(
            IPC_DOMAINS.AGENT,
            'interrupt',
            runtimeEnvelope,
          );
          const optimisticUser = {
            id: messageId,
            role: 'user' as const,
            content: runtimeEnvelope.content,
            attachments: runtimeEnvelope.attachments,
            timestamp: Date.now(),
            metadata: toMessageMetadata(runtimeContext),
          };
          if (
            !replaceOptimisticUserMessage(optimisticUser)
            && !useSessionStore.getState().messages.some((message) => message.id === messageId)
          ) {
            addMessage(optimisticUser);
          }
          logger.info('sendMessage - foreground input delivery accepted', { outcome: outcome.outcome });
          return outcome;
        } catch (error) {
          logger.error('Foreground input delivery failed', error);
          addMessage({
            id: generateMessageId(),
            role: 'assistant',
            content: getAgentSendFailureMessage(error),
            timestamp: Date.now(),
          });
          return { outcome: 'failed' as const };
        }
      };

      if (isCurrentSessionProcessing) {
        const voiceCall = await readInstalledVoiceCall();
        // 收成一个「可注入的会话 id」而不是布尔量：后面 payload 直接用它，
        // 类型自然收窄，不必在调用点写非空断言。
        const voiceInjectSessionId = !attachments?.length
          && voiceCall.phase === 'live'
          && effectiveSessionId
          && voiceCall.sessionId === effectiveSessionId
          ? effectiveSessionId
          : undefined;
        if (voiceInjectSessionId !== undefined) {
          try {
            const injection = await typedInvokeDomain(VoiceSchemas.INJECT_USER_TEXT, {
              action: 'injectUserText',
              payload: {
                neoSessionId: voiceInjectSessionId,
                text: content,
              },
            });
            if (injection.success && injection.data.outcome === 'injected') {
              logger.info('sendMessage - routed busy text into live voice call');
              return { outcome: 'sent' as const };
            }
            logger.info('sendMessage - voice text injection fell back to foreground input delivery', {
              reason: injection.success
                ? injection.data.outcome === 'fallback' ? injection.data.reason : injection.data.outcome
                : injection.error.code,
            });
          } catch (error) {
            // The typed path must have a durable escape hatch even if the voice
            // bridge itself is unavailable during teardown.
            logger.warn('sendMessage - voice text injection failed; using foreground input delivery', {
              message: error instanceof Error ? error.message : String(error),
            });
          }
        } else {
          logger.info('sendMessage - session processing, delivering runtime input to foreground brain', {
            isCurrentSessionProcessing,
          });
        }
        return deliverToForegroundBrain(envelope.clientMessageId);
      }

      // Add user message with UUID
      const userMessage: Message = {
        id: envelope.clientMessageId ?? generateMessageId(),
        role: 'user',
        content,
        timestamp: Date.now(),
        attachments,
        metadata: toMessageMetadata(contextWithDesignContext),
      };
      logger.debug('Adding user message', { id: userMessage.id, attachmentsCount: attachments?.length || 0 });
      // 乐观上屏去重：协作空间 composer 在切会话前已把同 id 消息放上时间线（落地即
      // 进行中态），这里再 append 就是双份。失败气泡编辑重发走同一 id 替换，不新开一条。
      upsertOptimisticUserMessage(userMessage, addMessage);

      // 不再预创建 assistant placeholder
      // 后端会在每轮迭代开始时发送 turn_start 事件，前端据此创建消息
      // 这样可以确保：
      // 1. 每轮 Agent Loop 对应一条消息
      // 2. 工具调用后的新响应会创建新消息，而不是追加到旧消息

      // 按会话设置处理状态（允许多会话并发）
      const previousTaskState = effectiveSessionId
        ? useTaskStore.getState().sessionStates[effectiveSessionId]
        : undefined;
      setSessionProcessing(effectiveSessionId!, true);
      useTaskStore.getState().updateSessionState(effectiveSessionId!, {
        status: 'running',
        startTime: Date.now(),
      });
      currentTurnMessageIdRef.current = null; // 重置 turn tracking
      const messagePayload: ConversationEnvelope = {
        ...envelope,
        // 设计画布冷启动引导已改为服务端按轮注入 systemPrompt/turnSystemContext
        // （context.executionIntent.designCanvasActive，见 canvasSessionReminder.ts），
        // 不再 prepend 进 content——content 会被原样持久化+渲染为用户气泡，此前的
        // renderer 侧 prepend 会把 <system-reminder> 全文泄漏进用户可见消息。
        clientMessageId: userMessage.id,
        context: contextWithDesignContext,
        sessionId: effectiveSessionId,
      };

      try {
        // Send to main process
        // Note: Don't set isProcessing to false here, it will be set by agent_complete event
        logger.debug('Calling invoke agent:send-message');
        logger.debug('messagePayload', { type: typeof messagePayload, isObject: typeof messagePayload === 'object' });
        if (typeof messagePayload === 'object') {
          logger.debug('Attachments being sent', { attachments: attachments?.map(a => ({ name: a.name, category: a.category, hasData: !!a.data, dataLen: a.data?.length, path: a.path, hasPath: !!a.path })) });
        }
        await ipcService.invoke('agent:send-message', messagePayload);
        logger.debug('invoke returned');
      } catch (error) {
        logger.error('Agent error', error);
        // 撞上上一轮的收尾窗口（agent_complete 已发、流还没关，run 仍占着 session）：
        // 这不是失败，排到下一轮。复用 userMessage.id 当 clientMessageId，上屏去重
        // 会认出它是同一条，不会重复显示。
        if (isSessionBusyRunConflict(error)) {
          if (effectiveSessionId) {
            setSessionProcessing(effectiveSessionId, false);
            useTaskStore.getState().updateSessionState(
              effectiveSessionId,
              previousTaskState ?? { status: 'idle' },
            );
          }
          return deliverToForegroundBrain(userMessage.id);
        }
        // 冷启动窗口：durable 就绪前 host 一律回 503，等就绪后原样重发一次。
        // 重发失败要按「重发的那个错」收口，所以另起一个变量——不能改写 catch 参数
        // （no-ex-assign：被改写的 error 会让后面每一处引用都要回头确认它现在指谁）。
        let sendFailure: unknown = error;
        if (isDurableRunRolloutUnavailable(sendFailure) && await waitForDurableRunReady()) {
          try {
            await ipcService.invoke('agent:send-message', messagePayload);
            return { outcome: 'sent' as const };
          } catch (retryError) {
            logger.error('Agent retry after durable run rollout completed failed', retryError);
            sendFailure = retryError;
          }
        }
        if (options?.silentFailure === true) {
          if (effectiveSessionId) {
            setSessionProcessing(effectiveSessionId, false);
            // 恢复发送前的终态，避免本次乐观 running 状态阻塞队列层的下一次重试。
            useTaskStore.getState().updateSessionState(
              effectiveSessionId,
              previousTaskState ?? { status: 'idle' },
            );
          }
          throw sendFailure;
        }
        markOptimisticUserSendFailed(userMessage.id);
        const retryAnchor = buildSendFailureRetryAnchor(userMessage, effectiveSessionId);
        // 错误时创建一条错误消息
        const errorMessage: Message = {
          id: generateMessageId(),
          role: 'assistant',
          content: isDurableRunRolloutUnavailable(sendFailure)
            ? t.common.durableRunStartupTimeout
            : getAgentSendFailureMessage(sendFailure),
          timestamp: Date.now(),
          // 失败用户气泡留在时间线上；错误卡「重试」仍锚到失败那条并带原
          // clientMessageId。纯附件消息 content 为空，锚点不能按文本判。
          ...(retryAnchor ? { metadata: retryAnchor } : {}),
        };
        addMessage(errorMessage);
        // 按会话清除处理状态
        setSessionProcessing(effectiveSessionId!, false);
        // taskStore 也必须重置，否则会话永远卡在 'running'：
        // 后续消息全部进入"运行中排队"分支但没有 run 去消费，表现为永远不回复
        useTaskStore.getState().updateSessionState(effectiveSessionId!, {
          status: 'error',
          error: String(sendFailure),
        });
        return { outcome: 'failed' as const };
      }
      return { outcome: 'sent' as const };
        });
    },
    [addMessage, setSessionProcessing, isProcessing, currentSessionId, t]
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
      const confirmed = targetSessionId
        ? await requestCancelUntilSettled({
            sessionId: targetSessionId,
            requestCancel: async (selector) => ipcService.invoke('agent:cancel', selector) as Promise<CancelSettlementResponse | undefined>,
            isCancellationActive: () => (
              useTaskStore.getState().sessionStates[targetSessionId]?.status === 'cancelling'
            ),
            wait: () => new Promise((resolve) => setTimeout(resolve, 250)),
          })
        : (await ipcService.invoke('agent:cancel', undefined), true);
      // Honest settle: only mark cancelled when the route confirmed terminal.
      // If SSE settled first, its event handler already owns the final state.
      if (targetSessionId) {
        if (confirmed) {
          useTaskStore.getState().updateSessionState(targetSessionId, { status: 'cancelled' });
          setSessionProcessing(targetSessionId, false);
        }
      } else if (confirmed) {
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
