// ============================================================================
// ChatView - Main Chat Interface (Enhanced UI/UX - Terminal Noir)
// ============================================================================

import React, { useCallback, useRef, useState, useEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import { useComposerStore } from '../stores/composerStore';
import { useSessionStore } from '../stores/sessionStore';
import { useTaskStore } from '../stores/taskStore';
import { useModeStore } from '../stores/modeStore';
import { useSwarmStore } from '../stores/swarmStore';
import { useAgent } from '../hooks/useAgent';
import { useRequireAuth } from '../hooks/useRequireAuth';
import { useTurnProjection } from '../hooks/useTurnProjection';
import { useTurnExecutionClarity } from '../hooks/useTurnExecutionClarity';
import { TurnBasedTraceView } from './features/chat/TurnBasedTraceView';
import { PinnedTodoBar } from './features/chat/PinnedTodoBar';
import { SessionDiffSummary } from './features/chat/SessionDiffSummary';
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
import { useLocalBridgeStore } from '../stores/localBridgeStore';
import { useMessageActionStore } from '../stores/messageActionStore';
import { useEvalCenterStore } from '../stores/evalCenterStore';
import { isWebMode } from '../utils/platform';

// PlanPanel moved to inline display in TurnBasedTraceView
import { SemanticResearchIndicator } from './features/chat/SemanticResearchIndicator';
import { RewindPanel } from './RewindPanel';
// PermissionCard moved to inline display in TurnBasedTraceView
import type { MessageAttachment, StreamRecoverySnapshot, TaskPlan } from '../../shared/contract';
import type { ConversationEnvelope } from '@shared/contract/conversationEnvelope';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../services/ipcService';
import {
  Bot,
  Code2,
  FileQuestion,
  Image,
  Sparkles,
  Terminal,
  Keyboard,
  AlertTriangle,
} from 'lucide-react';
export const ChatView: React.FC = () => {
  const appWorkingDirectory = useAppStore((state) => state.workingDirectory);
  const loadReviewQueue = useEvalCenterStore((state) => state.loadReviewQueue);
  const {
    currentSessionId,
    hasOlderMessages,
    isLoadingOlder,
    loadOlderMessages,
    streamSnapshot,
  } = useSessionStore();
  const launchRequests = useSwarmStore((state) => state.launchRequests);
  const { messages, isProcessing, sendMessage, cancel, researchDetected, dismissResearchDetected, isInterrupting } = useAgent();
  const isPaused = useModeStore((s) => s.isPaused);
  const setIsPaused = useModeStore((s) => s.setIsPaused);
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
        return;
      }

      try {
        const response = await window.domainAPI?.invoke<TaskPlan | null>(IPC_DOMAINS.PLANNING, 'getPlan');
        if (!response?.success) {
          throw new Error(response?.error?.message || 'Failed to fetch plan');
        }
        setPlan(response.data || null);
      } catch (error) {
        console.error('Failed to fetch plan:', error);
        setPlan(null);
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
  }, [currentSessionId]);

  // Wave 5: 使用 taskStore 判断当前会话是否在处理中（支持多任务并行）
  const { sessionStates } = useTaskStore();
  const currentSessionState = currentSessionId ? sessionStates[currentSessionId] : null;
  const isCurrentSessionProcessing = currentSessionState?.status === 'running' || currentSessionState?.status === 'queued';
  // 如果 taskStore 有状态，使用会话级别状态；否则回退到全局状态
  const effectiveIsProcessing = currentSessionState ? isCurrentSessionProcessing : isProcessing;

  // Auto-reset isPaused when processing finishes
  useEffect(() => {
    if (!effectiveIsProcessing && isPaused) {
      setIsPaused(false);
    }
  }, [effectiveIsProcessing, isPaused, setIsPaused]);
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
  const projection = useTurnExecutionClarity(baseProjection);

  // Global drop zone state
  const chatInputRef = useRef<ChatInputHandle>(null);
  const [isGlobalDragOver, setIsGlobalDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const { processFile, processFolderEntry } = useFileUpload();

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
    dragCounterRef.current = 0;
    setIsGlobalDragOver(false);

    const items = e.dataTransfer.items;
    const newAttachments: import('../../shared/contract').MessageAttachment[] = [];

    if (items) {
      const entries: FileSystemEntry[] = [];
      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry?.();
        if (entry) entries.push(entry);
      }
      for (const entry of entries) {
        if (entry.isFile) {
          const fileEntry = entry as FileSystemFileEntry;
          const file = await new Promise<File>((resolve, reject) => {
            fileEntry.file(resolve, reject);
          });
          const attachment = await processFile(file);
          if (attachment) newAttachments.push(attachment);
        } else if (entry.isDirectory) {
          const dirEntry = entry as FileSystemDirectoryEntry;
          const folderAttachment = await processFolderEntry(dirEntry, entry.name);
          if (folderAttachment) newAttachments.push(folderAttachment);
        }
      }
    } else {
      const files = Array.from(e.dataTransfer.files);
      for (const file of files) {
        const attachment = await processFile(file);
        if (attachment) newAttachments.push(attachment);
      }
    }

    if (newAttachments.length > 0) {
      chatInputRef.current?.addAttachments(newAttachments);
    }
  }, [processFile, processFolderEntry]);
  // 发送消息需要登录
  const handleSendEnvelope = useCallback(async (envelope: ConversationEnvelope) => {
    await requireAuthAsync(async () => {
      await sendMessage(envelope);
    });
  }, [requireAuthAsync, sendMessage]);

  const handleSendMessage = useCallback(async (content: string, attachments?: MessageAttachment[]) => {
    await handleSendEnvelope(buildEnvelope(content, attachments));
  }, [buildEnvelope, handleSendEnvelope]);

  return (
    <div
        className="flex-1 flex overflow-hidden relative"
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
              dragCounterRef.current = 0;
              setIsGlobalDragOver(false);
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
      <div className="flex-1 flex flex-col min-w-0">
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
        <div className="flex-1 overflow-hidden">
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
            />
          )}
        </div>

        {/* Semantic Research Indicator - 检测到需要深度研究时显示 */}
        {researchDetected && (
          <div className="px-6 w-full">
            <SemanticResearchIndicator
              intent={researchDetected.intent}
              confidence={researchDetected.confidence}
              suggestedDepth={researchDetected.suggestedDepth}
              reasoning={researchDetected.reasoning}
              visible={true}
              onDismiss={dismissResearchDetected}
            />
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

        {/* 会话级 Diff 聚合卡（Codex 风格 X files changed +A -B / Review changes ↗）*/}
        <SessionDiffSummary messages={messages} />

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
          isPaused={isPaused}
          onPause={() => setIsPaused(true)}
          onResume={() => setIsPaused(false)}
          hasPlan={false}
        />
      </div>

      {/* Plan is now inline in TurnBasedTraceView */}

      {/* Rewind Panel (Esc+Esc) */}
      <RewindPanel isOpen={showRewindPanel} onClose={() => setShowRewindPanel(false)} />
    </div>
  );
};



// 建议卡片类型
interface SuggestionItem {
  icon: React.ElementType;
  text: string;
  description: string;
  color: string;
  borderColor: string;
  iconColor: string;
}

// 默认建议卡片（gen8）
const defaultSuggestions: SuggestionItem[] = [
  {
    icon: Sparkles,
    text: '做一个 3D 旋转相册',
    description: 'CSS 3D 效果',
    color: 'from-blue-500/20 to-cyan-500/20',
    borderColor: 'border-blue-500/20',
    iconColor: 'text-blue-400',
  },
  {
    icon: Code2,
    text: '做一个代码编辑器',
    description: '语法高亮/行号',
    color: 'from-emerald-500/20 to-teal-500/20',
    borderColor: 'border-emerald-500/20',
    iconColor: 'text-emerald-400',
  },
  {
    icon: Terminal,
    text: '做一个流程图编辑器',
    description: '拖拽连线节点',
    color: 'from-purple-500/20 to-pink-500/20',
    borderColor: 'border-purple-500/20',
    iconColor: 'text-purple-400',
  },
  {
    icon: FileQuestion,
    text: '做一个粒子动画',
    description: 'Canvas 特效',
    color: 'from-red-500/20 to-orange-500/20',
    borderColor: 'border-red-500/20',
    iconColor: 'text-red-400',
  },
];

// Keyboard shortcuts for empty state
const shortcuts = [
  { keys: ['⌘', 'F'], label: '搜索消息' },
  { keys: ['⌘', '⇧', 'P'], label: '命令面板' },
  { keys: ['Esc', 'Esc'], label: '回溯' },
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
    <div className="h-full flex flex-col items-center justify-center text-center px-6 py-12">
      {/* Hero Section */}
      <div className="relative mb-8 animate-fade-in">
        {/* Glow effect */}
        <div className="absolute inset-0 w-24 h-24 mx-auto rounded-3xl bg-gradient-to-br from-primary-500/30 to-accent-purple/30 blur-2xl" />

        {/* Icon */}
        <div className="relative w-20 h-20 rounded-3xl bg-gradient-to-br from-primary-500 to-accent-purple flex items-center justify-center shadow-2xl shadow-primary-500/30 animate-glow-pulse">
          <Bot className="w-10 h-10 text-white" />
        </div>

        {/* Decorative elements */}
        <div className="absolute -top-2 -right-2 w-6 h-6 rounded-lg bg-accent-cyan/20 border border-accent-cyan/30 flex items-center justify-center animate-bounce" style={{ animationDelay: '0.5s', animationDuration: '2s' }}>
          <Sparkles className="w-3 h-3 text-accent-cyan" />
        </div>
        <div className="absolute -bottom-1 -left-2 w-5 h-5 rounded-lg bg-accent-emerald/20 border border-accent-emerald/30 flex items-center justify-center animate-bounce" style={{ animationDelay: '1s', animationDuration: '2.5s' }}>
          <Terminal className="w-2.5 h-2.5 text-accent-emerald" />
        </div>
      </div>

      {/* Title */}
      <h1 className="text-2xl font-bold text-zinc-200 mb-2 animate-fade-in" style={{ animationDelay: '100ms' }}>
        Code Agent
      </h1>

      {/* Subtitle */}
      <p className="text-zinc-400 max-w-md mb-8 leading-relaxed animate-fade-in" style={{ animationDelay: '200ms' }}>
        你的 AI 编程助手。我可以帮你编写、调试、解释和测试代码。
        从下方建议开始，或输入你自己的问题。
      </p>

      {/* Suggestion Cards */}
      <div className="grid grid-cols-2 gap-3 max-w-lg w-full mb-10">
        {suggestions.map((suggestion, index) => (
          <SuggestionCard
            key={suggestion.text}
            {...suggestion}
            onSend={onSend}
            delay={300 + index * 75}
          />
        ))}
      </div>

      {/* Keyboard Shortcuts */}
      <div className="flex items-center gap-6 animate-fade-in" style={{ animationDelay: '600ms' }}>
        <Keyboard className="w-4 h-4 text-zinc-600" />
        {shortcuts.map((s) => (
          <div key={s.label} className="flex items-center gap-1.5">
            <div className="flex items-center gap-0.5">
              {s.keys.map((k) => (
                <kbd
                  key={k}
                  className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-zinc-800 border border-zinc-700 text-zinc-400"
                >
                  {k}
                </kbd>
              ))}
            </div>
            <span className="text-xs text-zinc-600">{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// Suggestion card component
interface SuggestionCardProps {
  icon: React.ElementType;
  text: string;
  description: string;
  color: string;
  borderColor: string;
  iconColor: string;
  onSend: (message: string) => void;
  delay: number;
}

const SuggestionCard: React.FC<SuggestionCardProps> = ({
  icon: Icon,
  text,
  description,
  color,
  borderColor,
  iconColor,
  onSend,
  delay,
}) => {
  return (
    <button
      onClick={() => onSend(text)}
      className={`group relative p-4 rounded-2xl text-left
                  bg-gradient-to-br ${color}
                  border ${borderColor}
                  hover:border-primary-500/30 hover:shadow-lg hover:shadow-primary-500/5
                  transition-all duration-300 ease-out-expo
                  hover:scale-[1.02] active:scale-[0.98]
                  animate-fade-in-up`}
      style={{ animationDelay: `${delay}ms` }}
    >
      {/* Icon */}
      <div className={`w-9 h-9 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center mb-3 group-hover:scale-110 transition-transform duration-300`}>
        <Icon className={`w-4.5 h-4.5 ${iconColor}`} />
      </div>

      {/* Text */}
      <div className="text-sm font-medium text-zinc-200 group-hover:text-zinc-200 transition-colors mb-0.5">
        {text}
      </div>
      <div className="text-xs text-zinc-500 group-hover:text-zinc-400 transition-colors">
        {description}
      </div>

      {/* Hover arrow */}
      <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-all duration-300 transform translate-x-1 group-hover:translate-x-0">
        <svg className="w-4 h-4 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </div>
    </button>
  );
};
