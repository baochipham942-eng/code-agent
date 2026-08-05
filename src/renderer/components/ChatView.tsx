// ============================================================================
// ChatView - Main Chat Interface (Enhanced UI/UX - Terminal Noir)
// ============================================================================

import React, { useCallback, useRef, useState, useEffect } from 'react';
import { useShallow } from 'zustand/shallow';
import { useAppStore } from '../stores/appStore';
import { useProjectChatSeedConsumption } from './features/chat/useProjectChatSeed';
import { useComposerStore } from '../stores/composerStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSessionUIStore } from '../stores/sessionUIStore';
import { useStreamingMessageAccumulatorStore } from '../stores/streamingMessageAccumulatorStore';
import { useTaskStore } from '../stores/taskStore';
import { useSwarmStore } from '../stores/swarmStore';
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
import { NewSessionWelcome } from './features/chat/NewSessionWelcome';
import { EmptySessionArea } from './features/chat/SessionSwitchSkeleton';
import { MemberConversationView } from './features/expert/MemberConversationView';
import { useMemberViewStore } from '../stores/memberViewStore';
export { buildDefaultSuggestions } from './features/chat/NewSessionWelcome';
import { SurfaceExecutionChatPanel } from './features/surfaceExecution/SurfaceExecutionChatPanel';
import { PinnedTodoBar } from './features/chat/PinnedTodoBar';
import { SessionRecapBanner } from './features/chat/SessionRecapBanner';
import { ForkSourceHint } from './features/chat/ForkSourceHint';
import { ChatTraceFallback } from './features/chat/ChatTraceFallback';
import { ErrorBoundary } from './ErrorBoundary';
import { ActiveConversationRewindBanner } from './features/chat/ActiveConversationRewindBanner';
import { ChatInput } from './features/chat/ChatInput';
import { UserQuestionCard } from './UserQuestionCard';
import { applyVoicePartialsToProjection } from '../utils/voicePartialOverlay';
import { useVoiceCallStore } from '../stores/voiceCallStore';
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
import type { AppSettings, Message, MessageAttachment, StreamRecoverySnapshot, TaskPlan } from '../../shared/contract';
import type { RewindConversationResult } from '@shared/contract/sessionRewind';
import type { ConversationEnvelope, ConversationEnvelopeContext } from '@shared/contract/conversationEnvelope';
import { useI18n } from '../hooks/useI18n';
import { localeForLanguage } from '../utils/i18nTime';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../services/ipcService';
import { formatChannelSessionSource } from './features/chat/chatViewSessionSource';
import { submitSteerEnvelope } from './features/chat/chatViewSteer';
import { collectDroppedAttachments } from './features/chat/ChatInput/utils';
import { applyStreamingMessageDeltasToProjection } from '../utils/streamingProjectionOverlay';
import { isStreamRecoveryMessage } from '../utils/streamRecoveryMessage';
import { recordStreamingPerformanceCounter } from '../utils/streamingPerformanceMetrics';
import { findSearchMatchForPendingJump } from '../utils/sessionSearchJump';
import { buildProjectGoalChatStart } from '../utils/projectGoalChatSeed';
import { isDragPointInsideVisibleRect } from '../utils/dragBounds';
import { Image, AlertTriangle, MessageSquare, X } from 'lucide-react';

export async function handleQueuedSteerOutcome(
  currentSessionId: string | null,
  hydrateQueuedRuntimeInputs: (sessionId: string) => Promise<void>,
  queuedToastMessage: string,
): Promise<void> {
  toast.info(queuedToastMessage);
  if (currentSessionId) await hydrateQueuedRuntimeInputs(currentSessionId);
}

export const ChatView: React.FC = () => {
  const { t } = useI18n();
  const appWorkingDirectory = useAppStore((state) => state.workingDirectory);
  const setAppWorkingDirectory = useAppStore((state) => state.setWorkingDirectory);
  const setComposerWorkingDirectory = useComposerStore((state) => state.setWorkingDirectory);
  const viewingMemberId = useMemberViewStore((state) => state.viewingMemberId);
  const setTaskPlan = useAppStore((state) => state.setTaskPlan);
  const openSettingsTab = useAppStore((state) => state.openSettingsTab);
  const {
    currentSessionId,
    sessions,
    hasOlderMessages,
    isLoading: isSessionLoading,
    isHydratingSession,
    isCreatingSession,
    isLoadingOlder,
    loadOlderMessages,
    setMessages,
    streamSnapshot,
  } = useSessionStore();
  const currentSession = sessions.find((session) => session.id === currentSessionId);
  const channelSessionSource = formatChannelSessionSource(currentSession);
  const launchRequests = useSwarmStore((state) => state.launchRequests);
  // 订阅节流快照而非原始 entries：原始 entries 每 token 变一次，会把投影重算推到 token 频率
  const streamingMessageEntries = useStreamingMessageAccumulatorStore((state) => state.visibleEntries);
  const neoWorkCards = useNeoWorkCardStore(useShallow((state) =>
    selectNeoWorkCardDetailsForConversation(state, currentSessionId),
  ));
  const loadNeoWorkCardsForConversation = useNeoWorkCardStore((state) => state.loadForConversation);
  const {
    messages,
    sendMessage,
    cancel,
    researchDetected,
    dismissResearchDetected,
    isInterrupting,
    queuedRuntimeInputs,
    hydrateQueuedRuntimeInputs,
    cancelQueuedRuntimeInput,
    sendQueuedRuntimeInput,
  } = useAgent();
  const buildComposerContext = useComposerStore((state) => state.buildContext);
  const hydrateComposer = useComposerStore((state) => state.hydrateFromSession);
  // G2 打断式选项卡：当前会话有待答的 AskUserQuestion 时，卡片遮盖 composer，
  // 语义 = 必须先回答（或显式跳过）才能继续输入。队首先答，答完露出下一题。
  const pendingUserQuestion = useSessionStore((state) =>
    currentSessionId
      ? (state.pendingUserQuestionsBySessionId?.get(currentSessionId)?.[0] ?? null)
      : null,
  );
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
      (content: string, context?: Pick<ConversationEnvelopeContext, 'localityAnchor'>) => {
        const envelope = buildEnvelope(content);
        // ADR-040：定点反馈的结构化锚点并进 composer context，host 侧补 revision 后
        // 落 user message metadata，供写前 guard 对账。不带锚点时 envelope 一字不变。
        return sendMessage(
          context?.localityAnchor
            ? { ...envelope, context: { ...envelope.context, localityAnchor: context.localityAnchor } }
            : envelope,
        );
      },
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
  const [rewindRefreshToken, setRewindRefreshToken] = useState(0);

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

  // D1 停止全部：spawn_agent 超前台预算会把成员转后台，主 loop 本轮正常收尾 →
  // 主会话回落 idle → 发送键变回发送形态，「停止全部」的入口就此消失，
  // agentAppService.cancel 里现成的级联（planApproval/launchApproval/spawnGuard.cancelSession/
  // parallelCoordinators）根本没人触发。所以按钮形态要额外看「本会话还有活着的成员」。
  // 只喂按钮形态，不并进 effectiveIsProcessing —— 后者还管 steer 路由、seed 消费、
  // 回溯横幅禁用，并进去会把「主 loop 空闲时发新消息」误路由成运行中补充。
  const swarmActiveSessionId = useSwarmStore((state) => state.activeSessionId);
  const swarmIsRunning = useSwarmStore((state) => state.isRunning);
  const swarmHasLiveAgents = useSwarmStore((state) => state.agents.some(
    (agent) => agent.status === 'running' || agent.status === 'ready' || agent.status === 'pending',
  ));
  const hasStoppableSwarmWork = Boolean(currentSessionId)
    && swarmActiveSessionId === currentSessionId
    && (swarmIsRunning || swarmHasLiveAgents);

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
      const toolName = data?.tool || t.chat.unknownTool;

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
  }, [bridgeStatus, bridgeVersion, workingDirectory, compareVersions, t]);

  const { requireAuthAsync } = useRequireAuth();

  // 目录选择并入新任务流程（批C2）：沿用原 SidebarWorkspaceRow 的同一条数据通道——
  // composer + appStore 同写，并持久化到当前会话，让工作区分组归位、agent 拿到正确 cwd。
  const applyWorkingDirectory = React.useCallback(async (selectedPath: string) => {
    setComposerWorkingDirectory(selectedPath);
    setAppWorkingDirectory(selectedPath);
    const sessionId = useSessionStore.getState().currentSessionId;
    if (sessionId) {
      try {
        await window.domainAPI?.invoke(IPC_DOMAINS.SESSION, 'update', {
          sessionId,
          updates: { workingDirectory: selectedPath },
        });
      } catch (err) {
        console.error('Failed to persist session workingDirectory:', err);
      }
    }
  }, [setAppWorkingDirectory, setComposerWorkingDirectory]);

  // Turn-based trace projection
  const baseProjection = useTurnProjection(messages, currentSessionId, effectiveIsProcessing, launchRequests, neoWorkCards);
  const clarityProjection = useTurnExecutionClarity(baseProjection);
  // 通话 partial：只叠加在「正在通话的那条会话」上，且不写任何 store（§7.5）
  const voiceCallPhase = useVoiceCallStore((state) => state.phase);
  const voiceCallSessionId = useVoiceCallStore((state) => state.sessionId);
  const voicePartialUser = useVoiceCallStore((state) => state.partialUser);
  const voicePartialAssistant = useVoiceCallStore((state) => state.partialAssistant);
  const voiceStartedAt = useVoiceCallStore((state) => state.startedAt);
  // 必须 memo：这个元素是 TurnBasedTraceView 的 itemContent 依赖，每渲染新建一个
  // 就等于每次 ChatView 重渲染都往 react-virtuoso 的 store 里发布一份新 itemContent。
  // virtuoso 每渲染在 layout effect 里全量发布 props，发布即通知订阅者
  // （useSyncExternalStore → forceStoreRerender），于是"ChatView 渲染"被放大成
  // 同步嵌套更新；只要上游有一条高频重渲染源，就会打满 React 的 50 层嵌套上限。
  const forkSourceHint = React.useMemo(
    () => <ForkSourceHint sessionId={currentSessionId} />,
    [currentSessionId],
  );
  const projection = React.useMemo(
    () => applyVoicePartialsToProjection(
      applyStreamingMessageDeltasToProjection(clarityProjection, messages, streamingMessageEntries),
      {
        live: voiceCallPhase === 'live' && voiceCallSessionId === currentSessionId,
        user: voicePartialUser,
        assistant: voicePartialAssistant,
        startedAt: voiceStartedAt,
      },
    ),
    [
      clarityProjection, messages, streamingMessageEntries, currentSessionId,
      voiceCallPhase, voiceCallSessionId, voicePartialUser, voicePartialAssistant, voiceStartedAt,
    ],
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
        toast.info(t.chat.configureModelKeyFirst);
        openSettingsTab('model');
        return false;
      }
      toast.info(t.chat.configureModelFirst);
      openSettingsTab('model');
      return false;
    } catch {
      return true;
    }
  }, [openSettingsTab, t]);

  // 发送消息需要登录
  // @neo 提交分支已移除（2026-07-29 拍板）：输入框不再有工作卡/续接交互，
  // @neo 字样按普通文本消息发送；工作卡从 Neo 协同页发起。
  const handleSendEnvelope = useCallback(async (envelope: ConversationEnvelope): Promise<boolean> => {
    const didSend = await requireAuthAsync(async () => {
      const modelReady = await ensureModelConfigured();
      if (!modelReady) return false;
      await sendMessage(envelope);
      return true;
    });
    return didSend === true;
  }, [
    currentSessionId,
    ensureModelConfigured,
    requireAuthAsync,
    sendMessage,
  ]);

  const handleSteerEnvelope = useCallback((envelope: ConversationEnvelope) => (
    submitSteerEnvelope(
      envelope,
      currentSessionId,
      () => handleQueuedSteerOutcome(
        currentSessionId,
        hydrateQueuedRuntimeInputs,
        t.chatInput.runtimeInputQueuedAfterAdjustment,
      ),
    )
  ), [currentSessionId, hydrateQueuedRuntimeInputs, t]);

  const handleSendMessage = useCallback(async (content: string, attachments?: MessageAttachment[]) => {
    return handleSendEnvelope(buildEnvelope(content, attachments));
  }, [buildEnvelope, handleSendEnvelope]);

  // D-1「重试该轮」锚点：streamSnapshot.turnId 是每轮流式开始时现铸的 UUID（streamHandler.ts
  // beginTurn(generateMessageId())），跟触发它的用户消息 id 毫无关联，snapshot 里也没有任何
  // 字段指回原始用户消息——唯一可靠锚点是结构性推导：addMessage 一律无条件清空 streamSnapshot
  // (sessionStore.ts addMessage)，所以只要 streamSnapshot 还在，messages 数组末尾就不可能是
  // 之后新增的消息；跳过末尾合入的 recovery 消息（F4，id=snapshot.turnId）后，末位就是触发
  // 这轮的用户消息。取不到（数组为空或末位不是 user）就不重试。
  const retryTurnMessage = deriveRetryTurnMessage(streamSnapshot, messages);

  // 对话式建角色：入口（能力中心 · 专家 / AgentSwitcher）起新会话后写入种子消息，
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

  // 项目协作空间底部输入框：composer 已建好新会话、乐观上屏首条用户消息（落地即在
  // 时间线上）并落 seed（完整 envelope，clientMessageId 与乐观消息同 id）。
  // 消费端抽到 useProjectChatSeed（可单测）：目标会话就绪后把 envelope 真正发给 agent
  // （sendMessage 按 id 去重不双份）；发送失败回滚乐观消息。
  useProjectChatSeedConsumption({ currentSessionId, effectiveIsProcessing, handleSendEnvelope });

  const handleRequestPromptRewind = useCallback((messageId: string, content: string) => {
    if (!currentSessionId) return;
    if (effectiveIsProcessing) {
      toast.warning(t.chat.rewindWhileRunning);
      return;
    }
    setPendingPromptRewind({ messageId, content });
  }, [currentSessionId, effectiveIsProcessing, t]);

  const handleConfirmPromptRewind = useCallback(async () => {
    if (!currentSessionId || !pendingPromptRewind || isPromptRewinding) return;
    setIsPromptRewinding(true);
    try {
      const result = await ipcService.invokeDomain<RewindConversationResult>(
        IPC_DOMAINS.SESSION,
        'rewindConversation',
        {
          sessionId: currentSessionId,
          anchorUserMessageId: pendingPromptRewind.messageId,
          idempotencyKey: `rewind:${currentSessionId}:${pendingPromptRewind.messageId}:${crypto.randomUUID()}`,
        },
      );
      setMessages(result.activeMessages);
      chatInputRef.current?.setDraft(result.draft);
      setPendingPromptRewind(null);
      setRewindRefreshToken((token) => token + 1);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setIsPromptRewinding(false);
    }
  }, [currentSessionId, isPromptRewinding, pendingPromptRewind, setMessages, t]);

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
          className="absolute inset-0 flex items-center justify-center bg-zinc-900/80 backdrop-blur-sm z-50 border-2 border-dashed border-accent-accessible rounded-xl"
          onDragOver={handleGlobalDragOver}
          onDragLeave={handleGlobalDragLeave}
          onDrop={handleGlobalDrop}
        >
          <div className="flex flex-col items-center gap-3 text-accent-accessible pointer-events-none">
            <Image className="w-12 h-12" />
            <span className="text-lg font-medium">{t.chat.dropFilesHere}</span>
          </div>
        </div>
      )}
      {/* Main Chat
          pr 让出一条滚动条宽的窄带（现象 9 右轨对齐，Sidebar 2026-07-27 同款先例）：
          消息列表滚动、底栏/横幅不滚动——全局 6px 占位式滚动条一出现，
          滚动区内容盒就比兄弟块窄 6px，摘要卡 ∨ / 错误条 ✕ / 发送 ↑ 于是不同轴。
          主栏统一缩到内轨，trace 滚动容器再用负 margin 把窄带要回（见下）。 */}
      <div className="flex-1 min-h-0 flex flex-col min-w-0 pr-[var(--scrollbar-size)]">
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
          <StreamRecoveryBanner
            snapshot={streamSnapshot}
            retryMessage={retryTurnMessage}
            onSend={handleSendMessage}
          />
        )}

        {channelSessionSource && (
          <div className="mx-4 mt-2 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-xs text-zinc-400">
            <MessageSquare className="h-3.5 w-3.5 text-zinc-500" />
            <span className="truncate">{channelSessionSource}</span>
          </div>
        )}

        {/* 回会话追赶提示（A6）：离开期间产出变了什么，一句话 */}
        <SessionRecapBanner sessionId={currentSessionId} />

        <ActiveConversationRewindBanner
          sessionId={currentSessionId}
          refreshToken={rewindRefreshToken}
          disabled={effectiveIsProcessing}
          onRestored={(result) => {
            setMessages(result.activeMessages);
            toast.success(
              t.chat.rewindRestored.replace(
                '{count}',
                String(result.restoredMessageCount),
              ),
            );
          }}
        />

        <SurfaceExecutionChatPanel conversationId={currentSessionId} />

        {/* Messages - Turn-based trace view（查看某位成员时整块换成他的对话）
            负 margin 把主栏让出的滚动条窄带要回：Virtuoso 滚动条摆进窄带，
            内容盒回到与 composer/横幅相同的内轨；配合 global.css 对该 scroller 的
            overflow-y:scroll 恒定占位，右轨与「列表是否溢出」无关（现象 9）。
            负 margin 只能加在这层——它自己有 overflow-hidden，加到子级会被裁掉。 */}
        <div className="flex-1 min-h-0 overflow-hidden mr-[calc(var(--scrollbar-size)*-1)]">
          {viewingMemberId ? (
            <MemberConversationView sessionId={currentSessionId} />
          ) : projection.turns.length === 0 ? (
            // 三态分明（工单 2026-08-01）：加载中（hydration 未完）→ 骨架屏；
            // 真空会话（hydration 完成且零消息）→ #874 的「继续上次的会话」空态；
            // 冷启动未定会话 → 空白占位。加载中绝不能误渲染成空态/欢迎页。
            <EmptySessionArea
              isHydratingSession={isHydratingSession}
              settled={!!currentSessionId && !isSessionLoading}
              welcome={
                <NewSessionWelcome
                  onSend={handleSendMessage}
                  workingDirectory={currentSessionWorkingDirectory}
                  workbenchSnapshot={currentSession?.workbenchSnapshot}
                  session={currentSession}
                />
              }
            />
          ) : (
            // 会话级错误边界：消息区一旦渲染失败（如虚拟列表反馈环打满 React 嵌套
            // 更新上限），只塌陷这一块并允许重试，不再让 App 级边界罩死整个应用。
            // key 绑会话 —— 切走再切回自动复位，不用用户手动点重试。
            <ErrorBoundary
              key={currentSessionId ?? 'no-session'}
              fallback={<ChatTraceFallback />}
            >
              <TurnBasedTraceView
                projection={projection}
                hasOlderMessages={hasOlderMessages}
                isLoadingOlder={isLoadingOlder}
                onLoadOlder={loadOlderMessages}
                searchMatches={searchMatches}
                activeMatchIndex={activeMatchIndex}
                onRewindUserPrompt={handleRequestPromptRewind}
                beforeFirstUserMessage={forkSourceHint}
              />
            </ErrorBoundary>
          )}
        </div>

        <div className="shrink-0">
          {/* Semantic Research Indicator - 检测到需要深度研究时显示 */}
          {researchDetected && (
            <div className="w-full chat-col-pad">
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
          {/* onSelect 真正落盘（此前只关弹窗把选择丢掉了——批C2 顺带修正） */}
          <DirectoryPickerModal
            isOpen={showDirPicker}
            onSelect={(directory) => {
              setShowDirPicker(false);
              void applyWorkingDirectory(directory);
            }}
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

          {/* G2 打断式选项卡：有待答问题时遮盖/替换输入区（拍板形态，非 Modal 非内联卡） */}
          {pendingUserQuestion && (
            <UserQuestionCard request={pendingUserQuestion} />
          )}

          {/* Input —— 待答问题期间保持挂载但隐藏（草稿不丢），卡片答复后自动恢复 */}
          <div className={pendingUserQuestion ? 'hidden' : undefined}>
            <ChatInput
              ref={chatInputRef}
              onSend={handleSendEnvelope}
              onSteer={handleSteerEnvelope}
              disabled={effectiveIsProcessing || isCreatingSession}
              isProcessing={effectiveIsProcessing}
              hasStoppableBackgroundWork={hasStoppableSwarmWork}
              isInterrupting={isInterrupting}
              onStop={cancel}
              queuedRuntimeInputs={queuedRuntimeInputs}
              onCancelQueuedRuntimeInput={cancelQueuedRuntimeInput}
              onSendQueuedRuntimeInput={sendQueuedRuntimeInput}
              hasPlan={false}
            />
          </div>
        </div>
      </div>

      {/* Plan is now inline in TurnBasedTraceView */}

      {/* Rewind Panel (Esc+Esc) */}
      <RewindPanel isOpen={showRewindPanel} onClose={() => setShowRewindPanel(false)} />
      <ConfirmDialog
        isOpen={Boolean(pendingPromptRewind)}
        title={t.chat.rewindConfirmTitle}
        message={
          <div className="space-y-3 text-sm text-zinc-400 leading-relaxed">
            <p>{t.chat.rewindConfirmLine1}</p>
            <p>{t.chat.rewindConfirmLine2}</p>
          </div>
        }
        variant="warning"
        confirmText={isPromptRewinding ? t.chat.rewindInProgress : t.chat.rewindConfirmAction}
        cancelText={t.common.cancel}
        confirmDisabled={isPromptRewinding}
        onConfirm={handleConfirmPromptRewind}
        onCancel={() => {
          if (!isPromptRewinding) setPendingPromptRewind(null);
        }}
      />
    </div>
  );
};



/**
 * D-1「重试该轮」锚点推导：streamSnapshot.turnId 是每轮流式开始时现铸的 UUID
 * （streamHandler.ts beginTurn(generateMessageId())），跟触发它的用户消息 id 毫无
 * 关联，snapshot 里也没有任何字段指回原始用户消息——唯一可靠锚点是结构性推导：
 * addMessage 一律无条件清空 streamSnapshot（sessionStore.ts addMessage），所以只要
 * streamSnapshot 还在，messages 数组末尾就不可能有之后新增的消息；中断的助手回复
 * 会以 id=snapshot.turnId 的 recovery 消息合入末尾（streamRecoveryMessage，F4），
 * 跳过它之后，末位消息必然就是触发这轮的用户消息。取不到（数组为空或末位不是
 * user）就返回 null，不重试。
 */
export function deriveRetryTurnMessage(
  streamSnapshot: StreamRecoverySnapshot | null,
  messages: Message[],
): Message | null {
  if (!streamSnapshot || messages.length === 0) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isStreamRecoveryMessage(message, streamSnapshot.turnId)) continue;
    return message.role === 'user' ? message : null;
  }
  return null;
}

export const StreamRecoveryBanner: React.FC<{
  snapshot: StreamRecoverySnapshot;
  /** 触发这轮中断的原始用户消息；找不到可靠锚点时为 null，不渲染重试按钮。 */
  retryMessage: Message | null;
  onSend: (content: string, attachments?: MessageAttachment[]) => Promise<boolean>;
}> = ({ snapshot, retryMessage, onSend }) => {
  const { t, language } = useI18n();
  // 无现成 dismiss 通道（streamSnapshot 只在发新消息/切会话时被清空），本地记住已关闭
  // 的 turnId 即可；换了新的未完成流（不同 turnId）时横幅照常重新出现。
  const [dismissedTurnId, setDismissedTurnId] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const handleRetryClick = async () => {
    if (!retryMessage || isRetrying) return;
    setIsRetrying(true);
    try {
      await onSend(retryMessage.content, retryMessage.attachments);
    } finally {
      setIsRetrying(false);
    }
  };
  const toolNames = snapshot.toolCalls
    .map((toolCall) => toolCall.name || toolCall.id)
    .filter(Boolean)
    .slice(0, 3);
  const extraCount = Math.max(0, snapshot.toolCalls.length - toolNames.length);
  const timeLabel = new Date(snapshot.timestamp).toLocaleTimeString(localeForLanguage(language), {
    hour: '2-digit',
    minute: '2-digit',
  });

  if (dismissedTurnId === snapshot.turnId) {
    return null;
  }

  return (
    <div className="chat-col-pad pt-3">
      {/* bar 内边距对齐 composer/摘要卡的 px-3：✕ 右缘 = −1(border)−12 = −13px，
          与摘要卡 ∨、发送 ↑ 同一条右轨（现象 9）。 */}
      <div className="max-w-3xl mx-auto flex items-start gap-3 rounded-lg border border-badge-warning/25 bg-amber-500/10 px-3 py-3 text-sm text-status-warning-soft">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-status-warning-soft dark:text-badge-warning [.high-contrast-dark_&]:text-badge-warning" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{t.chat.streamInterruptedTitle}</div>
          <div className="mt-1 text-status-warning-soft dark:text-status-warning-soft/80 [.high-contrast-dark_&]:text-status-warning-soft/80">
            {snapshot.toolCalls.length > 0
              ? t.chat.streamInterruptedToolCalls
                  .replace('{count}', String(snapshot.toolCalls.length))
                  .replace('{names}', `${toolNames.join(', ')}${extraCount ? ` +${extraCount}` : ''}`)
              : t.chat.streamInterruptedText}
          </div>
          <div className="mt-1 text-xs text-status-warning-soft dark:text-status-warning-soft/60 [.high-contrast-dark_&]:text-status-warning-soft/60">
            {timeLabel}
          </div>
          {retryMessage && (
            <button
              type="button"
              onClick={handleRetryClick}
              disabled={isRetrying}
              className="mt-2 inline-flex items-center rounded-md border border-badge-warning/30 bg-amber-500/10 px-2 py-1 text-xs font-medium text-status-warning-soft transition-colors hover:bg-amber-500/20 disabled:cursor-wait disabled:opacity-70"
            >
              {isRetrying ? t.chat.retryTurnInProgress : t.chat.retryTurn}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => setDismissedTurnId(snapshot.turnId)}
          className="shrink-0 rounded-md p-1 text-status-warning-soft/60 transition-colors hover:bg-white/[0.06] hover:text-status-warning-soft"
          aria-label={t.common.close}
          title={t.common.close}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
};
