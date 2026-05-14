// ============================================================================
// ChatView - Main Chat Interface (Enhanced UI/UX - Terminal Noir)
// ============================================================================

import React, { useCallback, useRef, useState, useEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import { useComposerStore } from '../stores/composerStore';
import { useSessionStore } from '../stores/sessionStore';
import { useStreamingMessageAccumulatorStore } from '../stores/streamingMessageAccumulatorStore';
import { useTaskStore } from '../stores/taskStore';
import { useSwarmStore } from '../stores/swarmStore';
import { useAgent } from '../hooks/useAgent';
import { useRequireAuth } from '../hooks/useRequireAuth';
import { useTurnProjection } from '../hooks/useTurnProjection';
import { useTurnExecutionClarity } from '../hooks/useTurnExecutionClarity';
import { TurnBasedTraceView } from './features/chat/TurnBasedTraceView';
import { PinnedTodoBar } from './features/chat/PinnedTodoBar';
import { ChatInput } from './features/chat/ChatInput';
import type { ChatInputHandle } from './features/chat/ChatInput';
import { useFileUpload } from './features/chat/ChatInput/useFileUpload';
import { SwarmInlineMonitor } from './features/swarm/SwarmInlineMonitor';
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
import { useEvalCenterStore } from '../stores/evalCenterStore';
import { isWebMode } from '../utils/platform';
import { toast } from '../hooks/useToast';

// PlanPanel moved to inline display in TurnBasedTraceView
import { SemanticResearchIndicator } from './features/chat/SemanticResearchIndicator';
import { RewindPanel } from './RewindPanel';
// PermissionCard moved to inline display in TurnBasedTraceView
import type { MessageAttachment, StreamRecoverySnapshot, TaskPlan } from '../../shared/contract';
import type { PromptRewindResult } from '@shared/contract/appService';
import type { ConversationEnvelope } from '@shared/contract/conversationEnvelope';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../services/ipcService';
import { collectDroppedAttachments } from './features/chat/ChatInput/utils';
import { applyStreamingMessageDeltasToProjection } from '../utils/streamingProjectionOverlay';
import { recordStreamingPerformanceCounter } from '../utils/streamingPerformanceMetrics';
import {
  ArrowRight,
  Code2,
  Image,
  Mail,
  Search,
  Sparkles,
  AlertTriangle,
} from 'lucide-react';
export const ChatView: React.FC = () => {
  const appWorkingDirectory = useAppStore((state) => state.workingDirectory);
  const setTaskPlan = useAppStore((state) => state.setTaskPlan);
  const loadReviewQueue = useEvalCenterStore((state) => state.loadReviewQueue);
  const {
    currentSessionId,
    hasOlderMessages,
    isLoadingOlder,
    loadOlderMessages,
    setMessages,
    streamSnapshot,
  } = useSessionStore();
  const launchRequests = useSwarmStore((state) => state.launchRequests);
  const streamingMessageEntries = useStreamingMessageAccumulatorStore((state) => state.entries);
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

  useEffect(() => {
    hydrateComposer(currentSessionId, appWorkingDirectory);
  }, [appWorkingDirectory, currentSessionId, hydrateComposer]);

  useEffect(() => {
    void loadReviewQueue();
  }, [loadReviewQueue]);

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
  const baseProjection = useTurnProjection(messages, currentSessionId, effectiveIsProcessing, launchRequests);
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

  // Global drop zone state
  const chatInputRef = useRef<ChatInputHandle>(null);
  const [isGlobalDragOver, setIsGlobalDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const { processFile, processFolderEntry } = useFileUpload();
  const clearGlobalDragState = useCallback(() => {
    dragCounterRef.current = 0;
    setIsGlobalDragOver(false);
  }, []);

  useEffect(() => {
    if (!isGlobalDragOver) return;
    window.addEventListener('dragend', clearGlobalDragState);
    window.addEventListener('drop', clearGlobalDragState);
    window.addEventListener('blur', clearGlobalDragState);
    return () => {
      window.removeEventListener('dragend', clearGlobalDragState);
      window.removeEventListener('drop', clearGlobalDragState);
      window.removeEventListener('blur', clearGlobalDragState);
    };
  }, [clearGlobalDragState, isGlobalDragOver]);

  const handleGlobalDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setIsGlobalDragOver(true);
    }
  }, []);

  const handleGlobalDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleGlobalDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsGlobalDragOver(false);
    }
  }, []);

  const handleGlobalDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    clearGlobalDragState();

    const newAttachments = await collectDroppedAttachments(e.dataTransfer, processFile, processFolderEntry);

    if (newAttachments.length > 0) {
      chatInputRef.current?.addAttachments(newAttachments);
    }
  }, [clearGlobalDragState, processFile, processFolderEntry]);
  // 发送消息需要登录
  const handleSendEnvelope = useCallback(async (envelope: ConversationEnvelope): Promise<boolean> => {
    const didSend = await requireAuthAsync(async () => {
      await sendMessage(envelope);
      return true;
    });
    return didSend === true;
  }, [requireAuthAsync, sendMessage]);

  const handleSendMessage = useCallback(async (content: string, attachments?: MessageAttachment[]) => {
    return handleSendEnvelope(buildEnvelope(content, attachments));
  }, [buildEnvelope, handleSendEnvelope]);

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
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onDragLeave={(e) => {
            e.preventDefault();
            e.stopPropagation();
            // Only hide when leaving the overlay itself (not entering a child)
            if (e.currentTarget === e.target) {
              clearGlobalDragState();
            }
          }}
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

        {/* Messages - Turn-based trace view */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {projection.turns.length === 0 ? (
            <EmptyState onSend={handleSendMessage} />
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

// 新会话任务卡：覆盖工作生活四类入口（沟通安排 / 内容创作 / 调研对比 / 代码改动）。
const defaultSuggestions: SuggestionItem[] = [
  {
    icon: Mail,
    title: '写一封邮件或安排日程',
    description: '邮件、会议、待办都能直接落地',
    prompt: '帮我起草一封邮件或安排一个会议；如果信息还不全，先问我收件人、目的和关键时间，然后给一份可直接发的版本。',
    accent: 'bg-amber-500/10 border-amber-500/20',
    iconColor: 'text-amber-400',
  },
  {
    icon: Sparkles,
    title: '做一份方案 / 文档 / PPT',
    description: '从一句话开始，直接出可发的稿',
    prompt: '帮我做一份方案或文档；先用一两句话和我对齐目的、读者和篇幅，再直接出完整稿，不要只给大纲。',
    accent: 'bg-violet-500/10 border-violet-500/20',
    iconColor: 'text-violet-400',
  },
  {
    icon: Search,
    title: '查一个事 / 对比一组方案',
    description: '搜索 + 对比 + 给推荐',
    prompt: '帮我把这件事查清楚或把这几个选项对比一下；先确认我关心的判断维度，再给结论 + 理由，不要堆链接。',
    accent: 'bg-sky-500/10 border-sky-500/20',
    iconColor: 'text-blue-400',
  },
  {
    icon: Code2,
    title: '改一段代码',
    description: '小范围修改，跑贴边测试',
    prompt: '帮我改一段代码：先看清当前代码风格和上下文，只动必要文件，改完跑贴边测试和 typecheck 再交。',
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

// Empty state component with enhanced design
const EmptyState: React.FC<{
  onSend: (message: string) => void;
}> = ({
  onSend,
}) => {
  const suggestions = defaultSuggestions;

  return (
    <div className="h-full flex flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-2xl animate-fade-in">
        <div className="mb-5 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-zinc-100">新会话</h1>
            <p className="mt-1 text-sm text-zinc-500">
              把需求拆成可执行任务，第一轮先做到能验证。
            </p>
          </div>
        </div>

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
