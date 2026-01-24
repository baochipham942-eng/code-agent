// ============================================================================
// ChatView - Main Chat Interface (Enhanced UI/UX - Terminal Noir)
// ============================================================================

import React, { useMemo, useCallback, useRef, useState, useEffect } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useTaskStore } from '../stores/taskStore';
import { useAgent } from '../hooks/useAgent';
import { useRequireAuth } from '../hooks/useRequireAuth';
import { MessageBubble } from './features/chat/MessageBubble';
import { ChatInput } from './features/chat/ChatInput';
import { TaskStatusBar } from './features/chat/TaskStatusBar';
import { TodoBar } from './TodoBar';
import { PreviewPanel } from './PreviewPanel';
import { PlanPanel } from './features/chat/PlanPanel';
import { SemanticResearchIndicator } from './features/chat/SemanticResearchIndicator';
import type { Message, MessageAttachment, TaskProgressData, TaskPlan } from '../../shared/types';
import { IPC_CHANNELS } from '@shared/ipc';
import {
  Bot,
  Code2,
  Bug,
  FileQuestion,
  Sparkles,
  Terminal,
  Zap,
  Brain,
  Loader2,
  Wrench,
  PenLine,
} from 'lucide-react';

export const ChatView: React.FC = () => {
  const { currentGeneration, showPreviewPanel } = useAppStore();
  const { todos, currentSessionId } = useSessionStore();
  const { messages, isProcessing, sendMessage, cancel, taskProgress, researchDetected, dismissResearchDetected } = useAgent();

  // Plan 状态
  const [plan, setPlan] = useState<TaskPlan | null>(null);
  const [showPlanPanel, setShowPlanPanel] = useState(false);

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
      // Skill 系统：isMeta 消息不渲染到 UI（仅发送给模型）
      if (message.isMeta) {
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

  // Show Gen 3+ todo bar if there are todos
  const showTodoBar = currentGeneration.tools.includes('todo_write') && todos.length > 0;

  // Render individual message item
  const renderMessageItem = useCallback((_index: number, message: Message) => (
    <div className="px-4 py-3 max-w-3xl mx-auto w-full">
      <MessageBubble message={message} />
    </div>
  ), []);

  // Footer component for processing indicator
  const Footer = useCallback(() => {
    if (!effectiveIsProcessing) return null;

    return (
      <div className="px-4 py-3 max-w-3xl mx-auto w-full">
        {taskProgress && taskProgress.phase !== 'completed'
          ? <EnhancedThinkingIndicator progress={taskProgress} />
          : <ThinkingIndicator />
        }
      </div>
    );
  }, [effectiveIsProcessing, taskProgress, cancel]);

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Main Chat */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Task Status Bar - 显示多任务状态 */}
        <TaskStatusBar className="shrink-0 mx-4 mt-2" />

        {/* Messages */}
        <div className="flex-1 overflow-hidden">
          {filteredMessages.length === 0 ? (
            <EmptyState generation={currentGeneration.name} generationId={currentGeneration.id} onSend={handleSendMessage} />
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
          <div className="px-4 max-w-3xl mx-auto w-full">
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

        {/* Todo Bar - compact progress above input */}
        {showTodoBar && (
          <div className="px-4 max-w-3xl mx-auto w-full">
            <TodoBar />
          </div>
        )}

        {/* Input */}
        <ChatInput
          onSend={handleSendMessage}
          disabled={effectiveIsProcessing}
          isProcessing={effectiveIsProcessing}
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
    </div>
  );
};

// Thinking indicator - Claude/ChatGPT style, left-aligned, no avatar
const ThinkingIndicator: React.FC = () => {
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
      </div>
    </div>
  );
};

// Enhanced thinking indicator with task progress - Claude/ChatGPT style
const EnhancedThinkingIndicator: React.FC<{ progress: TaskProgressData }> = ({ progress }) => {
  // 阶段配置
  const phaseConfig: Record<string, { icon: React.ReactNode; label: string; color: string }> = {
    thinking: {
      icon: <Brain className="w-3.5 h-3.5" />,
      label: '思考中',
      color: 'text-blue-400',
    },
    tool_pending: {
      icon: <Wrench className="w-3.5 h-3.5" />,
      label: '准备执行',
      color: 'text-amber-400',
    },
    tool_running: {
      icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
      label: '执行中',
      color: 'text-purple-400',
    },
    generating: {
      icon: <PenLine className="w-3.5 h-3.5" />,
      label: '生成中',
      color: 'text-emerald-400',
    },
  };

  const config = phaseConfig[progress.phase] || phaseConfig.thinking;
  const hasToolProgress = progress.phase === 'tool_running' && progress.toolTotal;

  return (
    <div className="animate-slideUp">
      {/* Progress indicator - no avatar, simple inline display */}
      <div className="inline-flex items-center gap-3">
        {/* Status icon and text */}
        <div className="flex items-center gap-2">
          <span className={config.color}>{config.icon}</span>
          <span className={`text-sm ${config.color}`}>
            {progress.step || config.label}
          </span>
        </div>

        {/* Tool progress bar */}
        {hasToolProgress && (
          <div className="flex items-center gap-2">
            <div className="w-20 h-1.5 bg-zinc-700/50 rounded-full overflow-hidden">
              <div
                className="h-full bg-purple-500 rounded-full transition-all duration-300"
                style={{ width: `${progress.progress || 0}%` }}
              />
            </div>
            <span className="text-xs text-zinc-500">
              {progress.toolIndex !== undefined && progress.toolTotal
                ? `${progress.toolIndex}/${progress.toolTotal}`
                : `${Math.round(progress.progress || 0)}%`}
            </span>
          </div>
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

// 按代际分组的建议卡片
// Gen1-2: 基础文件操作
// Gen3-4: 规划和技能
// Gen5-6: 记忆和自动化
// Gen7-8: 多代理和自我进化
const suggestionsByGeneration: Record<string, SuggestionItem[]> = {
  // Gen1: 基础文件操作
  gen1: [
    {
      icon: Terminal,
      text: '列出当前目录文件',
      description: '使用 bash 命令',
      color: 'from-emerald-500/20 to-teal-500/20',
      borderColor: 'border-emerald-500/20',
      iconColor: 'text-emerald-400',
    },
    {
      icon: FileQuestion,
      text: '读取 package.json',
      description: '查看项目配置',
      color: 'from-blue-500/20 to-cyan-500/20',
      borderColor: 'border-blue-500/20',
      iconColor: 'text-blue-400',
    },
    {
      icon: Code2,
      text: '创建一个新文件',
      description: '写入代码内容',
      color: 'from-purple-500/20 to-pink-500/20',
      borderColor: 'border-purple-500/20',
      iconColor: 'text-purple-400',
    },
    {
      icon: Bug,
      text: '修复文件中的 Bug',
      description: '编辑并修复代码',
      color: 'from-red-500/20 to-orange-500/20',
      borderColor: 'border-red-500/20',
      iconColor: 'text-red-400',
    },
  ],
  // Gen2: 搜索和导航
  gen2: [
    {
      icon: Terminal,
      text: '搜索所有 TypeScript 文件',
      description: '使用 glob 模式',
      color: 'from-emerald-500/20 to-teal-500/20',
      borderColor: 'border-emerald-500/20',
      iconColor: 'text-emerald-400',
    },
    {
      icon: FileQuestion,
      text: '查找 TODO 注释',
      description: '使用 grep 搜索',
      color: 'from-blue-500/20 to-cyan-500/20',
      borderColor: 'border-blue-500/20',
      iconColor: 'text-blue-400',
    },
    {
      icon: Code2,
      text: '分析项目结构',
      description: '列出目录内容',
      color: 'from-purple-500/20 to-pink-500/20',
      borderColor: 'border-purple-500/20',
      iconColor: 'text-purple-400',
    },
    {
      icon: Bug,
      text: '定位错误来源',
      description: '搜索错误关键字',
      color: 'from-red-500/20 to-orange-500/20',
      borderColor: 'border-red-500/20',
      iconColor: 'text-red-400',
    },
  ],
  // Gen3: 实用小应用
  gen3: [
    {
      icon: Code2,
      text: '做一个贪吃蛇游戏',
      description: '经典像素风格',
      color: 'from-emerald-500/20 to-teal-500/20',
      borderColor: 'border-emerald-500/20',
      iconColor: 'text-emerald-400',
    },
    {
      icon: Sparkles,
      text: '做一个番茄钟计时器',
      description: '专注工作 25 分钟',
      color: 'from-red-500/20 to-orange-500/20',
      borderColor: 'border-red-500/20',
      iconColor: 'text-red-400',
    },
    {
      icon: Terminal,
      text: '做一个密码生成器',
      description: '随机安全密码',
      color: 'from-purple-500/20 to-pink-500/20',
      borderColor: 'border-purple-500/20',
      iconColor: 'text-purple-400',
    },
    {
      icon: FileQuestion,
      text: '做一个记账本',
      description: '收支统计图表',
      color: 'from-blue-500/20 to-cyan-500/20',
      borderColor: 'border-blue-500/20',
      iconColor: 'text-blue-400',
    },
  ],
  // Gen4: 更多实用工具
  gen4: [
    {
      icon: Code2,
      text: '做一个打字练习器',
      description: '测试打字速度',
      color: 'from-emerald-500/20 to-teal-500/20',
      borderColor: 'border-emerald-500/20',
      iconColor: 'text-emerald-400',
    },
    {
      icon: Sparkles,
      text: '做一个抽奖转盘',
      description: '自定义奖品选项',
      color: 'from-purple-500/20 to-pink-500/20',
      borderColor: 'border-purple-500/20',
      iconColor: 'text-purple-400',
    },
    {
      icon: Terminal,
      text: '做一个 Markdown 编辑器',
      description: '实时预览效果',
      color: 'from-blue-500/20 to-cyan-500/20',
      borderColor: 'border-blue-500/20',
      iconColor: 'text-blue-400',
    },
    {
      icon: Bug,
      text: '做一个颜色选择器',
      description: 'RGB/HEX 转换',
      color: 'from-red-500/20 to-orange-500/20',
      borderColor: 'border-red-500/20',
      iconColor: 'text-red-400',
    },
  ],
  // Gen5: 进阶应用
  gen5: [
    {
      icon: Code2,
      text: '做一个俄罗斯方块',
      description: '经典休闲游戏',
      color: 'from-blue-500/20 to-cyan-500/20',
      borderColor: 'border-blue-500/20',
      iconColor: 'text-blue-400',
    },
    {
      icon: Sparkles,
      text: '做一个白噪音播放器',
      description: '雨声/咖啡厅/火焰',
      color: 'from-purple-500/20 to-pink-500/20',
      borderColor: 'border-purple-500/20',
      iconColor: 'text-purple-400',
    },
    {
      icon: Terminal,
      text: '做一个二维码生成器',
      description: '文字转二维码',
      color: 'from-emerald-500/20 to-teal-500/20',
      borderColor: 'border-emerald-500/20',
      iconColor: 'text-emerald-400',
    },
    {
      icon: FileQuestion,
      text: '做一个习惯打卡',
      description: '每日任务追踪',
      color: 'from-red-500/20 to-orange-500/20',
      borderColor: 'border-red-500/20',
      iconColor: 'text-red-400',
    },
  ],
  // Gen6: 视觉交互
  gen6: [
    {
      icon: Code2,
      text: '做一个画板工具',
      description: '自由绘图涂鸦',
      color: 'from-blue-500/20 to-cyan-500/20',
      borderColor: 'border-blue-500/20',
      iconColor: 'text-blue-400',
    },
    {
      icon: Sparkles,
      text: '做一个图片滤镜',
      description: '黑白/复古/模糊',
      color: 'from-purple-500/20 to-pink-500/20',
      borderColor: 'border-purple-500/20',
      iconColor: 'text-purple-400',
    },
    {
      icon: Terminal,
      text: '做一个截图标注工具',
      description: '添加箭头和文字',
      color: 'from-emerald-500/20 to-teal-500/20',
      borderColor: 'border-emerald-500/20',
      iconColor: 'text-emerald-400',
    },
    {
      icon: FileQuestion,
      text: '做一个拼图游戏',
      description: '上传图片拼图',
      color: 'from-red-500/20 to-orange-500/20',
      borderColor: 'border-red-500/20',
      iconColor: 'text-red-400',
    },
  ],
  // Gen7: 复杂应用
  gen7: [
    {
      icon: Code2,
      text: '做一个看板任务管理',
      description: '拖拽卡片排序',
      color: 'from-blue-500/20 to-cyan-500/20',
      borderColor: 'border-blue-500/20',
      iconColor: 'text-blue-400',
    },
    {
      icon: Sparkles,
      text: '做一个音乐可视化',
      description: '频谱动画效果',
      color: 'from-purple-500/20 to-pink-500/20',
      borderColor: 'border-purple-500/20',
      iconColor: 'text-purple-400',
    },
    {
      icon: Terminal,
      text: '做一个聊天界面',
      description: '仿微信/Slack',
      color: 'from-emerald-500/20 to-teal-500/20',
      borderColor: 'border-emerald-500/20',
      iconColor: 'text-emerald-400',
    },
    {
      icon: FileQuestion,
      text: '做一个数据仪表盘',
      description: '图表统计展示',
      color: 'from-red-500/20 to-orange-500/20',
      borderColor: 'border-red-500/20',
      iconColor: 'text-red-400',
    },
  ],
  // Gen8: 高级应用
  gen8: [
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
  ],
};

// 获取当前代际的建议卡片
function getSuggestionsForGeneration(genId: string): SuggestionItem[] {
  return suggestionsByGeneration[genId] || suggestionsByGeneration.gen3;
}

// Empty state component with enhanced design
const EmptyState: React.FC<{
  generation: string;
  generationId: string;
  onSend: (message: string) => void;
}> = ({
  generation,
  generationId,
  onSend,
}) => {
  // 获取当前代际对应的建议卡片
  const suggestions = getSuggestionsForGeneration(generationId);
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
        <span className="ml-2 text-lg font-medium text-gradient bg-gradient-to-r from-primary-400 to-accent-purple bg-clip-text text-transparent">
          {generation}
        </span>
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
