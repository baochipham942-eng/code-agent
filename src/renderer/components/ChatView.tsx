// ============================================================================
// ChatView - Main Chat Interface (Enhanced UI/UX - Terminal Noir)
// ============================================================================

import React, { useMemo, useCallback, useRef, useState, useEffect } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useTaskStore } from '../stores/taskStore';
import { useStatusStore } from '../stores/statusStore';
import { useAgent } from '../hooks/useAgent';
import { useRequireAuth } from '../hooks/useRequireAuth';
import { MessageBubble } from './features/chat/MessageBubble';
import { ChatInput } from './features/chat/ChatInput';
import type { ChatInputHandle } from './features/chat/ChatInput';
import { useFileUpload } from './features/chat/ChatInput/useFileUpload';
import { TaskStatusBar } from './features/chat/TaskStatusBar';
import { LocalBridgePrompt } from './features/chat/LocalBridgePrompt';
import { BridgeUpdatePrompt } from './features/chat/BridgeUpdatePrompt';
import { DirectoryPickerModal } from './features/chat/DirectoryPickerModal';
import { useLocalBridgeStore } from '../stores/localBridgeStore';
import { isWebMode } from '../utils/platform';
import { getModelDisplayLabel } from '@shared/constants';

import { PreviewPanel } from './PreviewPanel';
import { PlanPanel } from './features/chat/PlanPanel';
import { SemanticResearchIndicator } from './features/chat/SemanticResearchIndicator';
import { RewindPanel } from './RewindPanel';
import { PermissionCard } from './PermissionDialog/PermissionCard';
import type { Message, MessageAttachment, TaskPlan } from '../../shared/types';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../services/ipcService';
import {
  Bot,
  Code2,
  FileQuestion,
  Image,
  Sparkles,
  Terminal,
  Zap,
} from 'lucide-react';

export const ChatView: React.FC = () => {
  const { showPreviewPanel } = useAppStore();
  const { currentSessionId, hasOlderMessages, isLoadingOlder, loadOlderMessages } = useSessionStore();
  const { messages, isProcessing, sendMessage, cancel, researchDetected, dismissResearchDetected, isInterrupting } = useAgent();

  // Plan 状态
  const [plan, setPlan] = useState<TaskPlan | null>(null);
  const [showPlanPanel, setShowPlanPanel] = useState(false);

  // Rewind Panel 状态 (Esc+Esc)
  const [showRewindPanel, setShowRewindPanel] = useState(false);
  const lastEscRef = useRef<number>(0);

  // Esc+Esc 检测
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
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
  }, []);

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
    const newAttachments: import('../../shared/types').MessageAttachment[] = [];

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
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // Pagination: firstItemIndex for Virtuoso prepend support
  const START_INDEX = 100000;
  const [firstItemIndex, setFirstItemIndex] = useState(START_INDEX);
  const prevMessagesRef = useRef<Message[]>([]);

  // Detect when older messages are prepended
  useEffect(() => {
    const prev = prevMessagesRef.current;
    if (
      messages.length > prev.length &&
      prev.length > 0 &&
      messages[messages.length - 1]?.id === prev[prev.length - 1]?.id
    ) {
      // Messages were prepended (last message same, but more messages at start)
      const delta = messages.length - prev.length;
      setFirstItemIndex(i => i - delta);
    } else if (prev.length > 0 && messages.length > 0 && messages[0]?.id !== prev[0]?.id && messages[messages.length - 1]?.id !== prev[prev.length - 1]?.id) {
      // Session switched - reset
      setFirstItemIndex(START_INDEX);
    }
    prevMessagesRef.current = messages;
  }, [messages]);

  // Handle scroll to top - load older messages
  const handleStartReached = useCallback(() => {
    if (hasOlderMessages && !isLoadingOlder) {
      loadOlderMessages();
    }
  }, [hasOlderMessages, isLoadingOlder, loadOlderMessages]);

  // Filter empty assistant placeholder messages and isMeta messages (Skill system)
  const filteredMessages = useMemo(() => {
    return messages.filter((message) => {
      // Compaction 消息始终显示（折叠摘要卡片）
      if (message.compaction) {
        return true;
      }

      // Skill 系统：isMeta 消息不渲染到 UI（仅发送给模型）
      if (message.isMeta) {
        return false;
      }

      // 过滤 tool 消息：工具结果已在 assistant 消息的 toolCalls[].result 中展示
      // tool 消息的 content 是原始 JSON，不应显示给用户
      if (message.role === 'tool') {
        return false;
      }

      if (message.role === 'assistant') {
        const hasContent = message.content && message.content.trim().length > 0;
        const hasToolCalls = message.toolCalls && message.toolCalls.length > 0;
        return hasContent || hasToolCalls;
      }
      return true;
    });
  }, [messages]);

  // 发送消息需要登录
  const handleSendMessage = useCallback(async (content: string, attachments?: MessageAttachment[]) => {
    await requireAuthAsync(async () => {
      await sendMessage(content, attachments);
    });
  }, [requireAuthAsync, sendMessage]);

  // Render individual message item
  const renderMessageItem = useCallback((_index: number, message: Message) => (
    <div className="px-6 py-1 w-full">
      <MessageBubble message={message} />
    </div>
  ), []);

  // Footer component for processing indicator
  const Footer = useCallback(() => {
    if (!effectiveIsProcessing) return null;

    return (
      <div className="px-6 py-1 w-full">
        <ThinkingIndicator />
      </div>
    );
  }, [effectiveIsProcessing, cancel]);

  return (
    <div
        className="flex-1 flex overflow-hidden relative"
        onDragEnter={handleGlobalDragEnter}
        onDragOver={handleGlobalDragOver}
        onDragLeave={handleGlobalDragLeave}
        onDrop={handleGlobalDrop}
      >
      {/* Global drag overlay */}
      {isGlobalDragOver && (
        <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/80 backdrop-blur-sm z-50 border-2 border-dashed border-primary-500 rounded-xl pointer-events-none">
          <div className="flex flex-col items-center gap-3 text-primary-400">
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

        {/* Messages */}
        <div className="flex-1 overflow-hidden">
          {filteredMessages.length === 0 ? (
            <EmptyState onSend={handleSendMessage} />
          ) : (
            <Virtuoso
              ref={virtuosoRef}
              data={filteredMessages}
              firstItemIndex={firstItemIndex}
              itemContent={renderMessageItem}
              startReached={handleStartReached}
              followOutput={(isAtBottom) => {
                // 流式输出时强制跟随：assistant 消息从 empty→有内容 时进入 filteredMessages，
                // 此时用户可能不在底部（因为空消息被 filter 掉了），需要强制滚动
                if (effectiveIsProcessing) return 'smooth';
                return isAtBottom ? 'smooth' : false;
              }}
              defaultItemHeight={100}
              overscan={400}
              className="h-full"
              components={{
                Header: () => hasOlderMessages ? (
                  <div className="flex justify-center py-3 text-gray-400 text-sm">
                    {isLoadingOlder ? '加载更早的消息...' : '↑ 滚动加载更多'}
                  </div>
                ) : null,
                Footer,
              }}
              increaseViewportBy={{ top: 200, bottom: 200 }}
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

        {/* Permission Card - 浮动在输入框上方 */}
        <PermissionCard />

        {/* Input */}
        <ChatInput
          ref={chatInputRef}
          onSend={handleSendMessage}
          disabled={effectiveIsProcessing}
          isProcessing={effectiveIsProcessing}
          isInterrupting={isInterrupting}
          onStop={cancel}
          hasPlan={!!plan}
          onPlanClick={() => setShowPlanPanel(true)}
        />
      </div>

      {/* HTML Preview Panel */}
      {showPreviewPanel && <PreviewPanel />}

      {/* Plan Panel Modal */}
      {showPlanPanel && plan && (
        <PlanPanel plan={plan} onClose={() => setShowPlanPanel(false)} />
      )}

      {/* Rewind Panel (Esc+Esc) */}
      <RewindPanel isOpen={showRewindPanel} onClose={() => setShowRewindPanel(false)} />
    </div>
  );
};

// 格式化会话耗时
function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

// 模型名称简写
function shortModelName(model: string): string {
  return getModelDisplayLabel(model).replace(/\s*\([^)]*\)\s*$/, '');
}

// Thinking indicator - Claude/ChatGPT style, left-aligned, no avatar
const ThinkingIndicator: React.FC = () => {
  const { inputTokens, outputTokens, contextUsagePercent, sessionStartTime } = useStatusStore();
  const { modelConfig } = useAppStore();
  const [elapsed, setElapsed] = useState(Date.now() - sessionStartTime);
  const totalTokens = inputTokens + outputTokens;

  useEffect(() => {
    const interval = setInterval(() => setElapsed(Date.now() - sessionStartTime), 1000);
    return () => clearInterval(interval);
  }, [sessionStartTime]);

  // 格式化 token 数
  const formatTokens = (n: number): string => {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return n.toString();
  };

  // 上下文百分比颜色
  const ctxColor =
    contextUsagePercent >= 85 ? 'text-red-400' :
    contextUsagePercent >= 60 ? 'text-amber-400' :
    'text-zinc-500';

  const modelName = modelConfig?.model ? shortModelName(modelConfig.model) : null;

  return (
    <div className="animate-slideUp">
      <div className="inline-flex items-center gap-2">
        {/* Typing dots */}
        <div className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-primary-400 typing-dot" style={{ animationDelay: '0ms' }} />
          <span className="w-1.5 h-1.5 rounded-full bg-primary-400 typing-dot" style={{ animationDelay: '150ms' }} />
          <span className="w-1.5 h-1.5 rounded-full bg-primary-400 typing-dot" style={{ animationDelay: '300ms' }} />
        </div>
        <span className="text-sm text-zinc-400">思考中</span>
        {modelName && (
          <span className="text-xs text-zinc-500 font-mono">· {modelName}</span>
        )}
        {contextUsagePercent > 0 && (
          <span className={`text-xs font-mono ${ctxColor}`}>
            · ctx {contextUsagePercent.toFixed(1)}%
          </span>
        )}
        {totalTokens > 0 && (
          <span className="text-xs text-zinc-500 font-mono">
            · {formatTokens(totalTokens)} tok
          </span>
        )}
        <span className="text-xs text-zinc-600 font-mono">· {formatElapsed(elapsed)}</span>
      </div>
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
      <p className="text-zinc-400 max-w-md mb-10 leading-relaxed animate-fade-in" style={{ animationDelay: '200ms' }}>
        你的 AI 编程助手。我可以帮你编写、调试、解释和测试代码。
        从下方建议开始，或输入你自己的问题。
      </p>

      {/* Suggestion Cards */}
      <div className="grid grid-cols-2 gap-3 max-w-lg w-full">
        {suggestions.map((suggestion, index) => (
          <SuggestionCard
            key={suggestion.text}
            {...suggestion}
            onSend={onSend}
            delay={300 + index * 75}
          />
        ))}
      </div>

      {/* Footer hint */}
      <div className="flex items-center gap-2 mt-10 text-xs text-zinc-600 animate-fade-in" style={{ animationDelay: '600ms' }}>
        <Zap className="w-3.5 h-3.5 text-primary-500/50" />
        <span>小提示：按 <kbd className="px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-400 font-mono text-2xs">/</kbd> 可访问命令</span>
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
