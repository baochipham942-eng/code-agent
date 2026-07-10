// ============================================================================
// ChatView - Main Chat Interface (Enhanced UI/UX - Terminal Noir)
// ============================================================================

import React, { useCallback, useRef, useState, useEffect } from 'react';
import { useShallow } from 'zustand/shallow';
import { useAppStore } from '../stores/appStore';
import { useComposerStore } from '../stores/composerStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSessionUIStore } from '../stores/sessionUIStore';
import { useStreamingMessageAccumulatorStore } from '../stores/streamingMessageAccumulatorStore';
import { useTaskStore } from '../stores/taskStore';
import { useSwarmStore } from '../stores/swarmStore';
import { useAuthStore } from '../stores/authStore';
import {
  ensureNeoWorkCardLiveUpdates,
  isNeoWorkCardAwaitingRuntimeTerminal,
  NEO_WORK_CARD_LIVE_REFRESH_MS,
  selectNeoWorkCardDetailsForConversation,
  useNeoWorkCardStore,
} from '../stores/neoWorkCardStore';
import { useAgent } from '../hooks/useAgent';
import { useRequireAuth } from '../hooks/useRequireAuth';
import { useTurnProjection } from '../hooks/useTurnProjection';
import { useTurnExecutionClarity } from '../hooks/useTurnExecutionClarity';
import { TurnBasedTraceView } from './features/chat/TurnBasedTraceView';
import { PinnedTodoBar } from './features/chat/PinnedTodoBar';
import { ChatInput } from './features/chat/ChatInput';
import { GoalStatusBar } from './features/chat/GoalStatusBar';
import { buildGoalNoticeMessage } from './features/chat/goalNotice';
import type { ChatInputHandle } from './features/chat/ChatInput';
import { useFileUpload } from './features/chat/ChatInput/useFileUpload';
import { SwarmInlineMonitor } from './features/swarm/SwarmInlineMonitor';
import { WorkflowInlineMonitor } from './features/workflow/WorkflowInlineMonitor';
import { WorkflowLaunchCard } from './features/workflow/WorkflowLaunchCard';
import { TaskStatusBar } from './features/chat/TaskStatusBar';
import { LocalBridgePrompt } from './features/chat/LocalBridgePrompt';
import { BridgeUpdatePrompt } from './features/chat/BridgeUpdatePrompt';
import { DirectoryPickerModal } from './features/chat/DirectoryPickerModal';
import { ChatSearchBar } from './features/chat/ChatSearchBar';
import type { SearchMatch } from './features/chat/ChatSearchBar';
import { InlineStrip } from './features/chat/InlineStrip';
import { ConfirmDialog } from './composites/ConfirmDialog';
import { useLocalBridgeStore } from '../stores/localBridgeStore';
import { useMessageActionStore } from '../stores/messageActionStore';
import { isWebMode } from '../utils/platform';
import { toast } from '../hooks/useToast';
import { hasConfiguredDefaultRuntimeModel, hasConfiguredRuntimeModels } from '@shared/modelRuntime';
import { buildGoalSeedTodos } from '@shared/utils/goalTodos';

// PlanPanel moved to inline display in TurnBasedTraceView
import { SemanticResearchIndicator } from './features/chat/SemanticResearchIndicator';
import { RewindPanel } from './RewindPanel';
// PermissionCard moved to inline display in TurnBasedTraceView
import type { AppSettings, MessageAttachment, StreamRecoverySnapshot, TaskPlan } from '../../shared/contract';
import type { PromptRewindResult } from '@shared/contract/appService';
import type { ConversationEnvelope } from '@shared/contract/conversationEnvelope';
import type { SessionWorkbenchSnapshot } from '@shared/contract/sessionWorkspace';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../services/ipcService';
import { collectDroppedAttachments } from './features/chat/ChatInput/utils';
import { applyStreamingMessageDeltasToProjection } from '../utils/streamingProjectionOverlay';
import { recordStreamingPerformanceCounter } from '../utils/streamingPerformanceMetrics';
import { findSearchMatchForPendingJump } from '../utils/sessionSearchJump';
import { buildProjectGoalChatStart } from '../utils/projectGoalChatSeed';
import { isDragPointInsideVisibleRect } from '../utils/dragBounds';
import {
  buildNeoTagContinuationMessage,
  buildNeoTagSourceMessage,
  submitNeoTagContinuation,
  submitNeoTagDraft,
} from './features/chat/neoTagSubmit';
import {
  ArrowRight,
  BarChart3,
  Gamepad2,
  HardDrive,
  Image,
  Search,
  AlertTriangle,
  MessageSquare,
} from 'lucide-react';

function formatChannelSessionSource(session: ReturnType<typeof useSessionStore.getState>['sessions'][number] | undefined): string | null {
  if (session?.origin?.kind !== 'channel') return null;
  const metadata = session.origin.metadata || {};
  const channelType = typeof metadata.channelType === 'string'
    ? metadata.channelType
    : typeof metadata.channelId === 'string'
      ? metadata.channelId
      : 'channel';
  const platform = channelType === 'feishu'
    ? 'Feishu'
    : channelType === 'lark'
      ? 'Lark'
      : channelType === 'telegram'
        ? 'Telegram'
        : channelType;
  const accountName = typeof metadata.accountName === 'string' ? metadata.accountName : undefined;
  const chatName = typeof metadata.chatName === 'string'
    ? metadata.chatName
    : typeof metadata.chatId === 'string'
      ? metadata.chatId
      : session.origin.name;
  return [platform, accountName, chatName].filter(Boolean).join(' · ');
}

export const ChatView: React.FC = () => {
  const appWorkingDirectory = useAppStore((state) => state.workingDirectory);
  const setTaskPlan = useAppStore((state) => state.setTaskPlan);
  const openSettingsTab = useAppStore((state) => state.openSettingsTab);
  const {
    currentSessionId,
    sessions,
    hasOlderMessages,
    isLoading: isSessionLoading,
    isLoadingOlder,
    loadOlderMessages,
    setMessages,
    streamSnapshot,
  } = useSessionStore();
  const currentSession = sessions.find((session) => session.id === currentSessionId);
  const channelSessionSource = formatChannelSessionSource(currentSession);
  const launchRequests = useSwarmStore((state) => state.launchRequests);
  const streamingMessageEntries = useStreamingMessageAccumulatorStore((state) => state.entries);
  const authUser = useAuthStore((state) => state.user);
  const neoWorkCards = useNeoWorkCardStore(useShallow((state) =>
    selectNeoWorkCardDetailsForConversation(state, currentSessionId),
  ));
  const runNeoTag = useNeoWorkCardStore((state) => state.createAndRun);
  const loadNeoWorkCardsForConversation = useNeoWorkCardStore((state) => state.loadForConversation);
  const {
    messages,
    sendMessage,
    cancel,
    researchDetected,
    dismissResearchDetected,
    isInterrupting,
    queuedRuntimeInputs,
    cancelQueuedRuntimeInput,
    sendQueuedRuntimeInput,
  } = useAgent();
  const buildComposerContext = useComposerStore((state) => state.buildContext);
  const hydrateComposer = useComposerStore((state) => state.hydrateFromSession);
  const currentSessionWorkingDirectory = currentSession
    ? currentSession.workingDirectory ?? null
    : appWorkingDirectory ?? null;

  useEffect(() => {
    ensureNeoWorkCardLiveUpdates();
  }, []);

  useEffect(() => {
    hydrateComposer(currentSessionId, appWorkingDirectory);
  }, [appWorkingDirectory, currentSessionId, hydrateComposer]);

  useEffect(() => {
    if (!currentSessionId) return;
    void loadNeoWorkCardsForConversation(currentSessionId).catch((error) => {
      console.warn('Failed to load Neo work cards:', error);
    });
  }, [currentSessionId, loadNeoWorkCardsForConversation]);

  const hasNeoWorkCardAwaitingRuntimeTerminal = neoWorkCards.some((detail) =>
    isNeoWorkCardAwaitingRuntimeTerminal(detail.workCard.status)
  );

  useEffect(() => {
    if (!currentSessionId || !hasNeoWorkCardAwaitingRuntimeTerminal) return;
    const interval = window.setInterval(() => {
      void loadNeoWorkCardsForConversation(currentSessionId).catch((error) => {
        console.warn('Failed to refresh Neo work cards:', error);
      });
    }, NEO_WORK_CARD_LIVE_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [currentSessionId, hasNeoWorkCardAwaitingRuntimeTerminal, loadNeoWorkCardsForConversation]);

  const buildEnvelope = useCallback((content: string, attachments?: MessageAttachment[]): ConversationEnvelope => ({
    content,
    ...(attachments?.length ? { attachments } : {}),
    context: buildComposerContext(),
  }), [buildComposerContext]);

  // Register message action store (edit / regenerate)
  const messageActionRegister = useMessageActionStore((s) => s.register);
  const messageActionUnregister = useMessageActionStore((s) => s.unregister);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  useEffect(() => {
    messageActionRegister(
      (content: string) => sendMessage(buildEnvelope(content)),
      () => messagesRef.current,
    );
    return () => messageActionUnregister();
  }, [buildEnvelope, sendMessage, messageActionRegister, messageActionUnregister]);

  // Plan 状态
  const [plan, setPlan] = useState<TaskPlan | null>(null);
  // Plan is now inline in TurnBasedTraceView (no modal state needed)

  // Rewind Panel 状态 (Esc+Esc)
  const [showRewindPanel, setShowRewindPanel] = useState(false);
  const lastEscRef = useRef<number>(0);

  // Search 状态
  const [showSearch, setShowSearch] = useState(false);
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([]);
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const pendingSearchJump = useSessionUIStore((state) => state.pendingSearchJump);
  const setPendingSearchJump = useSessionUIStore((state) => state.setPendingSearchJump);
  const [pendingPromptRewind, setPendingPromptRewind] = useState<{
    messageId: string;
    content: string;
  } | null>(null);
  const [isPromptRewinding, setIsPromptRewinding] = useState(false);

  const handleSearchMatchesChange = useCallback((matches: SearchMatch[], activeIdx: number) => {
    setSearchMatches(matches);
    setActiveMatchIndex(activeIdx);
  }, []);

  const handleActiveMatchChange = useCallback((activeIdx: number) => {
    setActiveMatchIndex(activeIdx);
  }, []);

  // Esc+Esc 检测 + Cmd+F 搜索
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl+F: 打开搜索
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setShowSearch(true);
        return;
      }
      if (e.key === 'Escape') {
        if (showSearch) {
          setShowSearch(false);
          return;
        }
        const now = Date.now();
        if (now - lastEscRef.current < 500) {
          setShowRewindPanel(true);
          lastEscRef.current = 0; // Reset to avoid triple-tap
        } else {
          lastEscRef.current = now;
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showSearch]);

  // 获取 Plan 数据
  useEffect(() => {
    const fetchPlan = async () => {
      if (!currentSessionId) {
        setPlan(null);
        setTaskPlan(null);
        return;
      }

      setPlan(null);
      setTaskPlan(null);

      try {
        const response = await window.domainAPI?.invoke<TaskPlan | null>(
          IPC_DOMAINS.PLANNING,
          'getPlan',
          { sessionId: currentSessionId },
        );
        if (!response?.success) {
          throw new Error(response?.error?.message || 'Failed to fetch plan');
        }
        const nextPlan = response.data || null;
        setPlan(nextPlan);
        setTaskPlan(nextPlan);
      } catch (error) {
        console.error('Failed to fetch plan:', error);
        setPlan(null);
        setTaskPlan(null);
      }
    };

    fetchPlan();

    // 监听 Plan 更新事件
    const unsubscribe = ipcService.on(IPC_CHANNELS.PLANNING_EVENT, () => {
      fetchPlan();
    });

    return () => {
      unsubscribe?.();
    };
  }, [currentSessionId, setTaskPlan]);

  // Wave 5: 使用 taskStore 判断当前会话是否在处理中（支持多任务并行）
  const { sessionStates } = useTaskStore();
  const currentSessionState = currentSessionId ? sessionStates[currentSessionId] : null;
  const isCurrentSessionProcessing = currentSessionState?.status === 'running' || currentSessionState?.status === 'queued';
  const isCurrentSessionLocallyProcessing = useAppStore((state) =>
    currentSessionId ? state.processingSessionIds?.has(currentSessionId) ?? false : false
  );
  // 当前 session 没有 taskStore 记录 = 这个 session 没在跑（新建/未发消息），不能继承全局 isProcessing
  // 否则别的 session 在 in-flight 时切到新 session，新 session 的 ChatInput 会错误显示运行中引导态
  // 历史选择：原 fallback 用全局 isProcessing 是为了向后兼容 Wave 5 之前的单任务模型，
  // 但多任务并行后这个 fallback 反而成了 state 跨 session 泄漏的源头
  const effectiveIsProcessing = isCurrentSessionProcessing || isCurrentSessionLocallyProcessing;

  // Bridge 拦截状态 (Phase 4)
  const [bridgePrompt, setBridgePrompt] = useState<{ toolName: string } | null>(null);
  const [bridgeUpdatePrompt, setBridgeUpdatePrompt] = useState<{ currentVersion: string; requiredVersion: string } | null>(null);
  const [showDirPicker, setShowDirPicker] = useState(false);
  const { status: bridgeStatus, version: bridgeVersion, workingDirectory } = useLocalBridgeStore();
  const { setShowSettings } = useAppStore();

  // Bridge 最低版本要求
  const MIN_BRIDGE_VERSION = '0.1.0';

  // 简单 semver 比较
  const compareVersions = useCallback((a: string, b: string): number => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      const diff = (pa[i] || 0) - (pb[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }, []);

  // 前往设置页 MCP tab
  const handleGoToSettings = useCallback(() => {
    setBridgePrompt(null);
    setBridgeUpdatePrompt(null);
    setShowSettings(true);
    // 延迟派发导航事件，等 Modal 挂载
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('settings-navigate', { detail: { tab: 'mcp' } }));
    }, 100);
  }, [setShowSettings]);

  // 监听 bridge-tool-call 事件（Web 模式下拦截本地工具调用）
  useEffect(() => {
    if (!isWebMode()) return;

    const handler = (e: Event) => {
      const data = (e as CustomEvent).detail;
      const toolName = data?.tool || '未知工具';

      // 1. Bridge 未连接
      if (bridgeStatus !== 'connected') {
        setBridgePrompt({ toolName });
        return;
      }

      // 2. 版本过低
      if (bridgeVersion && compareVersions(bridgeVersion, MIN_BRIDGE_VERSION) < 0) {
        setBridgeUpdatePrompt({
          currentVersion: bridgeVersion,
          requiredVersion: MIN_BRIDGE_VERSION,
        });
        return;
      }

      // 3. 未选择工作目录
      if (!workingDirectory) {
        setShowDirPicker(true);
        return;
      }

      // 4. 一切就绪 - 正常执行（后续 Phase 会实现实际调用）
    };

    window.addEventListener('bridge-tool-call', handler);
    return () => window.removeEventListener('bridge-tool-call', handler);
  }, [bridgeStatus, bridgeVersion, workingDirectory, compareVersions]);

  const { requireAuthAsync } = useRequireAuth();

  // Turn-based trace projection
  const baseProjection = useTurnProjection(messages, currentSessionId, effectiveIsProcessing, launchRequests, neoWorkCards);
  const clarityProjection = useTurnExecutionClarity(baseProjection);
  const projection = React.useMemo(
    () => applyStreamingMessageDeltasToProjection(clarityProjection, messages, streamingMessageEntries),
    [clarityProjection, messages, streamingMessageEntries],
  );

  useEffect(() => {
    recordStreamingPerformanceCounter('stream.projection.base_commit');
  }, [baseProjection]);

  useEffect(() => {
    if (Object.keys(streamingMessageEntries).length === 0) return;
    recordStreamingPerformanceCounter('stream.projection.overlay_commit');
  }, [projection, streamingMessageEntries]);

  useEffect(() => {
    if (pendingSearchJump?.sessionId !== currentSessionId) {
      return;
    }

    const match = findSearchMatchForPendingJump(projection, pendingSearchJump);
    if (match) {
      setShowSearch(true);
      setSearchMatches([match]);
      setActiveMatchIndex(0);
      setPendingSearchJump(null);
      return;
    }

    if (projection.turns.length > 0 && Date.now() - pendingSearchJump.createdAt > 3000) {
      setShowSearch(true);
      setPendingSearchJump(null);
    }
  }, [currentSessionId, pendingSearchJump, projection, setPendingSearchJump]);

  // Global drop zone state
  const chatInputRef = useRef<ChatInputHandle>(null);
  const globalDropZoneRef = useRef<HTMLDivElement>(null);
  const [isGlobalDragOver, setIsGlobalDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const { processFile, processFolderEntry } = useFileUpload();
  const clearGlobalDragState = useCallback(() => {
    dragCounterRef.current = 0;
    setIsGlobalDragOver(false);
  }, []);
  const isDragInsideGlobalDropZone = useCallback((event: { clientX: number; clientY: number }) => {
    const rect = globalDropZoneRef.current?.getBoundingClientRect();
    if (!rect) return false;
    return isDragPointInsideVisibleRect(event, rect, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
  }, []);

  useEffect(() => {
    if (!isGlobalDragOver) return;
    const handleWindowDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      if (!isDragInsideGlobalDropZone(event)) {
        clearGlobalDragState();
      }
    };
    const handleWindowDragLeave = (event: DragEvent) => {
      if (!isDragInsideGlobalDropZone(event)) {
        clearGlobalDragState();
      }
    };
    window.addEventListener('dragend', clearGlobalDragState);
    window.addEventListener('drop', clearGlobalDragState);
    window.addEventListener('blur', clearGlobalDragState);
    window.addEventListener('dragover', handleWindowDragOver, true);
    window.addEventListener('dragleave', handleWindowDragLeave, true);
    return () => {
      window.removeEventListener('dragend', clearGlobalDragState);
      window.removeEventListener('drop', clearGlobalDragState);
      window.removeEventListener('blur', clearGlobalDragState);
      window.removeEventListener('dragover', handleWindowDragOver, true);
      window.removeEventListener('dragleave', handleWindowDragLeave, true);
    };
  }, [clearGlobalDragState, isDragInsideGlobalDropZone, isGlobalDragOver]);

  const handleGlobalDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!e.dataTransfer.types.includes('Files')) return;
    dragCounterRef.current++;
    if (isDragInsideGlobalDropZone(e)) {
      setIsGlobalDragOver(true);
    }
  }, [isDragInsideGlobalDropZone]);

  const handleGlobalDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!e.dataTransfer.types.includes('Files')) return;
    if (!isDragInsideGlobalDropZone(e)) {
      clearGlobalDragState();
      return;
    }
    e.dataTransfer.dropEffect = 'copy';
    setIsGlobalDragOver(true);
  }, [clearGlobalDragState, isDragInsideGlobalDropZone]);

  const handleGlobalDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragInsideGlobalDropZone(e)) {
      clearGlobalDragState();
      return;
    }
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsGlobalDragOver(false);
    }
  }, [clearGlobalDragState, isDragInsideGlobalDropZone]);

  const handleGlobalDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    clearGlobalDragState();

    const newAttachments = await collectDroppedAttachments(e.dataTransfer, processFile, processFolderEntry);

    if (newAttachments.length > 0) {
      chatInputRef.current?.addAttachments(newAttachments);
    }
  }, [clearGlobalDragState, processFile, processFolderEntry]);
  const ensureModelConfigured = useCallback(async (): Promise<boolean> => {
    try {
      const settings = await ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get');
      if (hasConfiguredDefaultRuntimeModel(settings)) {
        return true;
      }
      if (hasConfiguredRuntimeModels(settings)) {
        toast.info('当前主任务模型未配置 API Key，请切换到已配置的模型后再发送。');
        openSettingsTab('model');
        return false;
      }
      toast.info('先配置一个模型后再发送。');
      openSettingsTab('model');
      return false;
    } catch {
      return true;
    }
  }, [openSettingsTab]);

  // 发送消息需要登录
  const handleSendEnvelope = useCallback(async (envelope: ConversationEnvelope): Promise<boolean> => {
    const neoResult = await requireAuthAsync(async () => {
      if (!currentSessionId) return null;
      try {
        // @neo 跨会话续接（ADR-035）：chip 即意图 —— 有续接目标就走同卡追加轮，
        // 执行落当前会话（过程流式可见），本地补显同 ID 去重。
        const continuationTarget = useNeoWorkCardStore.getState().continuationTarget;
        if (continuationTarget) {
          const continuation = await submitNeoTagContinuation({
            envelope,
            conversationId: currentSessionId,
            continuationTarget,
            requesterUserId: authUser?.id ?? 'local-user',
            runContinuation: useNeoWorkCardStore.getState().continueAndRun,
          });
          const roundMessage = buildNeoTagContinuationMessage({
            envelope,
            conversationId: currentSessionId,
            workCardId: continuationTarget.workCardId,
            roundTurnId: continuation.roundTurnId,
          });
          if (!messagesRef.current.some((message) => message.id === roundMessage.id)) {
            useSessionStore.getState().addMessage(roundMessage);
          }
          useNeoWorkCardStore.getState().setContinuationTarget(null);
          return true;
        }
        const result = await submitNeoTagDraft({
          envelope,
          sourceConversationId: currentSessionId,
          projectId: currentSession?.projectId ?? null,
          workspacePath: currentSessionWorkingDirectory,
          requesterUserId: authUser?.id ?? 'local-user',
          runNeoTag,
        });
        if (!result) return null;
        // @neo = 正常 agent 聊天：用户那句原话按普通用户消息进会话（BUG1）。
        // host 落库的用户消息与这里同 ID（sourceTurnId），reload 不会出现双份。
        const sourceMessage = buildNeoTagSourceMessage({
          envelope,
          sourceConversationId: currentSessionId,
          result,
        });
        if (!messagesRef.current.some((message) => message.id === sourceMessage.id)) {
          useSessionStore.getState().addMessage(sourceMessage);
        }
        // 轻量化重设计:@neo = 正常 agent 聊天,不弹 toast(回复直接流式出现在对话里)。
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
        return false;
      }
    });
    if (neoResult !== null && neoResult !== undefined) {
      return neoResult === true;
    }

    const didSend = await requireAuthAsync(async () => {
      const modelReady = await ensureModelConfigured();
      if (!modelReady) return false;
      await sendMessage(envelope);
      return true;
    });
    return didSend === true;
  }, [
    authUser?.id,
    runNeoTag,
    currentSession?.projectId,
    currentSessionId,
    currentSessionWorkingDirectory,
    ensureModelConfigured,
    requireAuthAsync,
    sendMessage,
  ]);

  const handleSendMessage = useCallback(async (content: string, attachments?: MessageAttachment[]) => {
    return handleSendEnvelope(buildEnvelope(content, attachments));
  }, [buildEnvelope, handleSendEnvelope]);

  // 对话式建角色：入口（RolesTab / AgentSwitcher）起新会话后写入种子消息，
  // 这里在新会话就绪后自动发出可见的种子消息，触发 create-role skill。
  const pendingRoleChatSeed = useAppStore((state) => state.pendingRoleChatSeed);
  useEffect(() => {
    if (!pendingRoleChatSeed || !currentSessionId || effectiveIsProcessing) return;
    const seed = pendingRoleChatSeed;
    useAppStore.getState().setPendingRoleChatSeed(null);
    void handleSendMessage(seed);
  }, [pendingRoleChatSeed, currentSessionId, effectiveIsProcessing, handleSendMessage]);

  const pendingProjectGoalChatSeed = useAppStore((state) => state.pendingProjectGoalChatSeed);
  useEffect(() => {
    if (!pendingProjectGoalChatSeed || !currentSessionId || effectiveIsProcessing) return;
    if (pendingProjectGoalChatSeed.sessionId !== currentSessionId) return;

    const seed = pendingProjectGoalChatSeed;
    useAppStore.getState().setPendingProjectGoalChatSeed(null);
    const start = buildProjectGoalChatStart(seed, buildEnvelope(seed.content));
    useAppStore.getState().startGoalRun(currentSessionId, start.runInit);
    useSessionStore.getState().setTodos(buildGoalSeedTodos(start.goalText));
    useSessionStore.getState().addMessage(buildGoalNoticeMessage({
      kind: 'start',
      goal: start.goalText,
    }));
    void handleSendEnvelope(start.envelope).then((sent) => {
      if (!sent) {
        useAppStore.getState().clearGoalRun(currentSessionId);
      }
    }).catch(() => {
      useAppStore.getState().clearGoalRun(currentSessionId);
    });
  }, [pendingProjectGoalChatSeed, currentSessionId, effectiveIsProcessing, buildEnvelope, handleSendEnvelope]);

  const handleRequestPromptRewind = useCallback((messageId: string, content: string) => {
    if (!currentSessionId) return;
    if (effectiveIsProcessing) {
      toast.warning('会话还在运行，先停止后再回退。');
      return;
    }
    setPendingPromptRewind({ messageId, content });
  }, [currentSessionId, effectiveIsProcessing]);

  const handleConfirmPromptRewind = useCallback(async () => {
    if (!currentSessionId || !pendingPromptRewind || isPromptRewinding) return;
    setIsPromptRewinding(true);
    try {
      const result = await ipcService.invokeDomain<PromptRewindResult>(
        IPC_DOMAINS.SESSION,
        'rewindToPrompt',
        {
          sessionId: currentSessionId,
          userMessageId: pendingPromptRewind.messageId,
        },
      );
      setMessages(result.activeMessages);
      chatInputRef.current?.setDraft(result.draft);
      setPendingPromptRewind(null);
      toast.success(`已回到这条提示词，恢复 ${result.filesRestored + result.filesDeleted} 个文件。`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setIsPromptRewinding(false);
    }
  }, [currentSessionId, isPromptRewinding, pendingPromptRewind, setMessages]);

  return (
    <div
        ref={globalDropZoneRef}
        className="flex-1 min-h-0 flex overflow-hidden relative"
        onDragEnter={handleGlobalDragEnter}
        onDragOver={handleGlobalDragOver}
        onDragLeave={handleGlobalDragLeave}
        onDrop={handleGlobalDrop}
      >
      {/* Global drag overlay — captures events directly to avoid iframe drag counter desync */}
      {isGlobalDragOver && (
        <div
          className="absolute inset-0 flex items-center justify-center bg-zinc-900/80 backdrop-blur-sm z-50 border-2 border-dashed border-primary-500 rounded-xl"
          onDragOver={handleGlobalDragOver}
          onDragLeave={handleGlobalDragLeave}
          onDrop={handleGlobalDrop}
        >
          <div className="flex flex-col items-center gap-3 text-primary-400 pointer-events-none">
            <Image className="w-12 h-12" />
            <span className="text-lg font-medium">拖放文件或文件夹到这里</span>
          </div>
        </div>
      )}
      {/* Main Chat */}
      <div className="flex-1 min-h-0 flex flex-col min-w-0">
        {/* Task Status Bar - 显示多任务状态 */}
        <TaskStatusBar className="shrink-0 mx-4 mt-2" />

        {/* Todo Progress Panel 已移至右侧 TaskInfo 面板 */}

        {/* In-session search bar (Cmd+F) */}
        <ChatSearchBar
          visible={showSearch}
          projection={projection}
          onClose={() => setShowSearch(false)}
          onMatchesChange={handleSearchMatchesChange}
          onActiveMatchChange={handleActiveMatchChange}
        />

        {streamSnapshot && (
          <StreamRecoveryBanner snapshot={streamSnapshot} />
        )}

        {channelSessionSource && (
          <div className="mx-4 mt-2 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-xs text-zinc-400">
            <MessageSquare className="h-3.5 w-3.5 text-zinc-500" />
            <span className="truncate">{channelSessionSource}</span>
          </div>
        )}

        {/* Messages - Turn-based trace view */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {projection.turns.length === 0 ? (
            // 仅在「已确定当前会话 + 非加载中」时才渲染空状态默认页。
            // 冷启动初始化（currentSessionId 尚为 null）或会话切换异步加载期间
            // 渲染空白占位，避免闪现"新会话"默认页（见 switchSession/initializeSessionStore）。
            currentSessionId && !isSessionLoading ? (
              <NewSessionWelcome
                onSend={handleSendMessage}
                workingDirectory={currentSessionWorkingDirectory}
                workbenchSnapshot={currentSession?.workbenchSnapshot}
              />
            ) : (
              <div className="h-full" aria-hidden />
            )
          ) : (
            <TurnBasedTraceView
              projection={projection}
              hasOlderMessages={hasOlderMessages}
              isLoadingOlder={isLoadingOlder}
              onLoadOlder={loadOlderMessages}
              searchMatches={searchMatches}
              activeMatchIndex={activeMatchIndex}
              onRewindUserPrompt={handleRequestPromptRewind}
            />
          )}
        </div>

        <div className="shrink-0">
          {/* Semantic Research Indicator - 检测到需要深度研究时显示 */}
          {researchDetected && (
            <div className="w-full px-4">
              <div className="mx-auto max-w-3xl">
                <SemanticResearchIndicator
                  intent={researchDetected.intent}
                  confidence={researchDetected.confidence}
                  suggestedDepth={researchDetected.suggestedDepth}
                  reasoning={researchDetected.reasoning}
                  visible={true}
                  onDismiss={dismissResearchDetected}
                />
              </div>
            </div>
          )}

          {/* Bridge 拦截提示 (Phase 4) */}
          {bridgePrompt && (
            <LocalBridgePrompt
              toolName={bridgePrompt.toolName}
              onGoToSettings={handleGoToSettings}
              onDismiss={() => setBridgePrompt(null)}
            />
          )}
          {bridgeUpdatePrompt && (
            <BridgeUpdatePrompt
              currentVersion={bridgeUpdatePrompt.currentVersion}
              requiredVersion={bridgeUpdatePrompt.requiredVersion}
              onGoToSettings={handleGoToSettings}
              onDismiss={() => setBridgeUpdatePrompt(null)}
            />
          )}

          {/* 工作目录选择弹窗 (Phase 4) */}
          <DirectoryPickerModal
            isOpen={showDirPicker}
            onSelect={() => setShowDirPicker(false)}
            onClose={() => setShowDirPicker(false)}
          />

          {/* Permission Card moved inline into TurnBasedTraceView */}

          {/* Context inline strip - shows when > 50% */}
          <InlineStrip />

          {/* Pinned todo progress bar — visible above the input */}
          <PinnedTodoBar plan={plan} sessionId={currentSessionId} />

          {/* Background agents inline monitor (Codex 风格 sticky 浮层) */}
          <SwarmInlineMonitor />

          {/* dynamic-workflow 启动审批卡（仅有 pending 审批时显示，跑前确认） */}
          <WorkflowLaunchCard />

          {/* dynamic-workflow 进度树（≈ /workflows，仅 workflow run 中/失败时显示） */}
          <WorkflowInlineMonitor />

          {/* /goal 运行进度条（独立一行，仅 goal 运行中显示） */}
          <GoalStatusBar />

          {/* Input */}
          <ChatInput
            ref={chatInputRef}
            onSend={handleSendEnvelope}
            disabled={effectiveIsProcessing}
            isProcessing={effectiveIsProcessing}
            isInterrupting={isInterrupting}
            onStop={cancel}
            queuedRuntimeInputs={queuedRuntimeInputs}
            onCancelQueuedRuntimeInput={cancelQueuedRuntimeInput}
            onSendQueuedRuntimeInput={sendQueuedRuntimeInput}
            hasPlan={false}
          />
        </div>
      </div>

      {/* Plan is now inline in TurnBasedTraceView */}

      {/* Rewind Panel (Esc+Esc) */}
      <RewindPanel isOpen={showRewindPanel} onClose={() => setShowRewindPanel(false)} />
      <ConfirmDialog
        isOpen={Boolean(pendingPromptRewind)}
        title="回到这条提示词？"
        message={
          <div className="space-y-3 text-sm text-zinc-400 leading-relaxed">
            <p>会恢复工作区文件到这轮之前，并隐藏这条提示词及之后的对话。</p>
            <p>原提示词会放回输入框，下一轮只会基于回退后的 active 对话继续。</p>
          </div>
        }
        variant="warning"
        confirmText={isPromptRewinding ? '回退中...' : '确认回退'}
        cancelText="取消"
        confirmDisabled={isPromptRewinding}
        onConfirm={handleConfirmPromptRewind}
        onCancel={() => {
          if (!isPromptRewinding) setPendingPromptRewind(null);
        }}
      />
    </div>
  );
};



// 建议卡片类型
interface SuggestionItem {
  icon: React.ElementType;
  title: string;
  description: string;
  prompt: string;
  accent: string;
  iconColor: string;
}

// 新会话任务卡：一键直出可运行/可交互产物或真实 agent 产出，第一轮不追问、即见结果。
export const defaultSuggestions: SuggestionItem[] = [
  {
    icon: Gamepad2,
    title: '做个能玩的小游戏',
    description: '霓虹贪吃蛇，键盘直接开玩',
    prompt: '用单个 HTML 文件做一个能直接玩的霓虹风《贪吃蛇》：方向键控制、实时计分与最高分、随长度逐渐加速、撞墙或咬到自己结束并可一键重开；深色背景、霓虹描边、流畅动画。直接给出完整可运行的单文件，不要问我任何问题。',
    accent: 'bg-amber-500/10 border-amber-500/20',
    iconColor: 'text-amber-400',
  },
  {
    icon: BarChart3,
    title: '出一张可交互数据图表',
    description: '聊天里直接渲染，可切换可悬停',
    prompt: '在聊天里直接渲染一张折线图，不要写 HTML 文件、不要调用任何工具。直接在回复里输出一个代码块（语言标记用 chart 或 json 均可），内容是图表 JSON，schema：{"type":"line","title":"编程语言流行度趋势 (2015–2024)","xKey":"year","series":[{"key":"Python"},{"key":"JavaScript"},{"key":"TypeScript"},{"key":"Rust"},{"key":"Go"}],"data":[{"year":2015,"Python":64,"JavaScript":90,"TypeScript":20,"Rust":8,"Go":18}, … 每年一条直到 2024]}。流行度取 0–100、用你掌握的合理近似。只输出这个代码块加一句话说明，不要问我任何问题。',
    accent: 'bg-sky-500/10 border-sky-500/20',
    iconColor: 'text-blue-400',
  },
  {
    icon: Search,
    title: '搜一份最新行业简报',
    description: '联网汇总近一周 AI 要闻',
    prompt: '联网搜索过去一周 AI 行业最值得关注的 5 件事：每条给标题、一句话摘要、为什么重要、来源链接，最后用一句话总结整体趋势。直接联网开始，不要问我任何问题。',
    accent: 'bg-violet-500/10 border-violet-500/20',
    iconColor: 'text-violet-400',
  },
  {
    icon: HardDrive,
    title: '梳理磁盘空间占用',
    description: '找出最占地的目录，给清理建议',
    prompt: '帮我梳理这台 Mac 的磁盘占用：用命令找出主目录下最占空间的前 15 个目录/文件并按大小排序，识别其中可安全清理的缓存、临时文件和重复构建产物，给出每项预计可释放的空间和具体清理命令（先列出，不要直接执行删除）。直接开始，不要问我任何问题。',
    accent: 'bg-emerald-500/10 border-emerald-500/20',
    iconColor: 'text-emerald-400',
  },
];

const StreamRecoveryBanner: React.FC<{ snapshot: StreamRecoverySnapshot }> = ({ snapshot }) => {
  const toolNames = snapshot.toolCalls
    .map((toolCall) => toolCall.name || toolCall.id)
    .filter(Boolean)
    .slice(0, 3);
  const extraCount = Math.max(0, snapshot.toolCalls.length - toolNames.length);
  const timeLabel = new Date(snapshot.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="px-4 pt-3">
      <div className="max-w-3xl mx-auto flex items-start gap-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-300" />
        <div className="min-w-0">
          <div className="font-medium">上次回复在流式输出中断</div>
          <div className="mt-1 text-amber-100/80">
            {snapshot.toolCalls.length > 0
              ? `${snapshot.toolCalls.length} 个 tool call 只保留为恢复快照，未执行：${toolNames.join(', ')}${extraCount ? ` +${extraCount}` : ''}`
              : '部分文本已保留为恢复快照。'}
          </div>
          <div className="mt-1 text-xs text-amber-100/60">
            turn {snapshot.turnId.slice(0, 8)} - {timeLabel}
          </div>
        </div>
      </div>
    </div>
  );
};

// 新会话欢迎页（示例建议 + 工作区上下文标签）——不是通用空态，别并进 primitives/EmptyState
const NewSessionWelcome: React.FC<{
  onSend: (message: string) => void;
  workingDirectory?: string | null;
  workbenchSnapshot?: SessionWorkbenchSnapshot | null;
}> = ({
  onSend,
  workingDirectory,
  workbenchSnapshot,
}) => {
  const suggestions = defaultSuggestions;
  // 纯对话（无工作区）是默认形态，不必再标「空白会话」——用户反馈看不懂、是噪音。
  // 只有继承了项目/工作区上下文时才显示上下文标签（"项目会话 · name"），告诉用户这条会话带了上下文。
  const hasWorkspaceContext = Boolean(workingDirectory?.trim());
  const contextLabel = hasWorkspaceContext ? formatNewSessionContextLabel(workingDirectory) : null;
  const contextTitle = hasWorkspaceContext ? `继承工作区：${workingDirectory!.trim()}` : '';
  const contextDetails = hasWorkspaceContext
    ? buildNewSessionContextDetails(workbenchSnapshot)
    : null;

  return (
    <div className="h-full flex flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-2xl animate-fade-in">
        <div className="mb-5 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-zinc-100">想完成什么？</h1>
            <p className="mt-1 text-sm text-zinc-500">
              选一个示例，或者直接输入你想完成的事。
            </p>
          </div>
          {contextLabel && (
            <span
              title={contextTitle}
              className="shrink-0 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[11px] font-medium text-zinc-400"
            >
              {contextLabel}
            </span>
          )}
        </div>
        {contextDetails && (
          <div className="mb-4 truncate text-[11px] text-zinc-500">
            {contextDetails}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          {suggestions.map((suggestion, index) => (
            <SuggestionCard
              key={suggestion.title}
              {...suggestion}
              onSend={onSend}
              delay={100 + index * 60}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

function formatNewSessionContextLabel(workingDirectory?: string | null): string {
  const trimmed = workingDirectory?.trim();
  if (!trimmed) {
    return '空白会话';
  }
  const parts = trimmed.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  const name = parts[parts.length - 1] || trimmed;
  return `项目会话 · ${name}`;
}

function buildNewSessionContextDetails(snapshot?: SessionWorkbenchSnapshot | null): string | null {
  if (!snapshot) {
    return null;
  }

  const parts: string[] = [];
  const summary = snapshot.summary?.trim();
  if (summary && summary !== '纯对话') {
    parts.push(summary);
  }

  const recentTools = (snapshot.recentToolNames ?? [])
    .map((toolName) => toolName.trim())
    .filter(Boolean)
    .slice(0, 2);
  if (recentTools.length > 0) {
    const remaining = Math.max(0, (snapshot.recentToolNames?.length ?? 0) - recentTools.length);
    parts.push(`最近工具 ${recentTools.join(', ')}${remaining > 0 ? ` +${remaining}` : ''}`);
  }

  const skillCount = snapshot.skillIds?.length ?? 0;
  const connectorCount = snapshot.connectorIds?.length ?? 0;
  const mcpCount = snapshot.mcpServerIds?.length ?? 0;
  if (skillCount > 0) parts.push(`${skillCount} Skill`);
  if (connectorCount > 0) parts.push(`${connectorCount} Connector`);
  if (mcpCount > 0) parts.push(`${mcpCount} MCP`);

  return parts.length > 0 ? `继承：${parts.join(' · ')}` : null;
}

// Suggestion card component
interface SuggestionCardProps {
  icon: React.ElementType;
  title: string;
  description: string;
  prompt: string;
  accent: string;
  iconColor: string;
  onSend: (message: string) => void;
  delay: number;
}

const SuggestionCard: React.FC<SuggestionCardProps> = ({
  icon: Icon,
  title,
  description,
  prompt,
  accent,
  iconColor,
  onSend,
  delay,
}) => {
  return (
    <button
      onClick={() => onSend(prompt)}
      className={`group relative min-h-[128px] rounded-lg border p-4 text-left ${accent}
                  transition-colors duration-200 hover:border-white/[0.18] hover:bg-white/[0.05]
                  animate-fade-in-up`}
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.08] bg-black/20">
          <Icon className={`h-4 w-4 ${iconColor}`} />
        </div>
        <ArrowRight className="h-4 w-4 text-zinc-600 transition-colors group-hover:text-zinc-300" />
      </div>

      <div className="text-sm font-medium text-zinc-100">
        {title}
      </div>
      <div className="mt-1 text-xs leading-relaxed text-zinc-500">
        {description}
      </div>
    </button>
  );
};
