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
import { TaskStatusBar } from './features/chat/TaskStatusBar';

import { PreviewPanel } from './PreviewPanel';
import { PlanPanel } from './features/chat/PlanPanel';
import { SemanticResearchIndicator } from './features/chat/SemanticResearchIndicator';
import { RewindPanel } from './RewindPanel';
import { PermissionCard } from './PermissionDialog/PermissionCard';
import type { Message, MessageAttachment, TaskPlan } from '../../shared/types';
import { IPC_CHANNELS } from '@shared/ipc';
import {
  Bot,
  Code2,
  FileQuestion,
  Sparkles,
  Terminal,
  Zap,
} from 'lucide-react';

export const ChatView: React.FC = () => {
  const { showPreviewPanel } = useAppStore();
  const { currentSessionId } = useSessionStore();
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
        const planData = await window.electronAPI?.invoke(IPC_CHANNELS.PLANNING_GET_PLAN);
        setPlan(planData || null);
      } catch (error) {
        console.error('Failed to fetch plan:', error);
        setPlan(null);
      }
    };

    fetchPlan();

    // 监听 Plan 更新事件
    const unsubscribe = window.electronAPI?.on(IPC_CHANNELS.PLANNING_EVENT, () => {
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
  const { requireAuthAsync } = useRequireAuth();
  const virtuosoRef = useRef<VirtuosoHandle>(null);

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
    <div className="flex-1 flex overflow-hidden">
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
              itemContent={renderMessageItem}
              followOutput="smooth"
              defaultItemHeight={100}
              overscan={400}
              className="h-full"
              components={{
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

        {/* Permission Card - 浮动在输入框上方 */}
        <PermissionCard />

        {/* Input */}
        <ChatInput
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

// Thinking indicator - Claude/ChatGPT style, left-aligned, no avatar
const ThinkingIndicator: React.FC = () => {
  const { inputTokens, outputTokens } = useStatusStore();
  const totalTokens = inputTokens + outputTokens;

  // 格式化 token 数
  const formatTokens = (n: number): string => {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return n.toString();
  };

  return (
    <div className="animate-slideUp">
      {/* Thinking indicator - simple dots */}
      <div className="inline-flex items-center gap-2">
        {/* Typing dots */}
        <div className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-primary-400 typing-dot" style={{ animationDelay: '0ms' }} />
          <span className="w-1.5 h-1.5 rounded-full bg-primary-400 typing-dot" style={{ animationDelay: '150ms' }} />
          <span className="w-1.5 h-1.5 rounded-full bg-primary-400 typing-dot" style={{ animationDelay: '300ms' }} />
        </div>
        <span className="text-sm text-zinc-400">思考中</span>
        {totalTokens > 0 && (
          <span className="text-xs text-zinc-500 font-mono">
            · {formatTokens(totalTokens)} tokens
          </span>
        )}
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
      <h1 className="text-2xl font-bold text-zinc-100 mb-2 animate-fade-in" style={{ animationDelay: '100ms' }}>
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
        <span>小提示：按 <kbd className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono text-2xs">/</kbd> 可访问命令</span>
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
      <div className="text-sm font-medium text-zinc-200 group-hover:text-white transition-colors mb-0.5">
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
