// ============================================================================
// ChatView - Main Chat Interface (Enhanced UI/UX - Terminal Noir)
// ============================================================================

import React, { useRef, useEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useAgent } from '../hooks/useAgent';
import { useRequireAuth } from '../hooks/useRequireAuth';
import { MessageBubble } from './MessageBubble';
import { ChatInput } from './ChatInput';
import { TodoPanel } from './TodoPanel';
import { PreviewPanel } from './PreviewPanel';
import {
  Bot,
  Code2,
  Bug,
  FileQuestion,
  TestTube2,
  Sparkles,
  Terminal,
  Zap
} from 'lucide-react';

export const ChatView: React.FC = () => {
  const { currentGeneration, showPreviewPanel } = useAppStore();
  const { todos } = useSessionStore();
  const { messages, isProcessing, sendMessage } = useAgent();
  const { requireAuthAsync } = useRequireAuth();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 发送消息需要登录
  const handleSendMessage = async (content: string) => {
    await requireAuthAsync(async () => {
      await sendMessage(content);
    });
  };

  // Show Gen 3+ todo panel if there are todos
  const showTodoPanel = currentGeneration.tools.includes('todo_write') && todos.length > 0;

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Main Chat */}
      <div className="flex-1 flex flex-col min-w-0 bg-gradient-to-b from-surface-950 to-void">
        {/* Messages */}
        <div className="flex-1 overflow-y-auto scroll-smooth">
          {messages.length === 0 ? (
            <EmptyState generation={currentGeneration.name} generationId={currentGeneration.id} onSend={handleSendMessage} />
          ) : (
            <div className="max-w-3xl mx-auto py-6 px-4 space-y-6">
              {messages
                // 过滤空的 assistant 占位消息（没有内容也没有工具调用）
                .filter((message) => {
                  if (message.role === 'assistant') {
                    const hasContent = message.content && message.content.trim().length > 0;
                    const hasToolCalls = message.toolCalls && message.toolCalls.length > 0;
                    return hasContent || hasToolCalls;
                  }
                  return true;
                })
                .map((message, index) => (
                <div
                  key={message.id}
                  className="animate-fade-in-up"
                  style={{ animationDelay: `${Math.min(index * 50, 200)}ms` }}
                >
                  <MessageBubble message={message} />
                </div>
              ))}

              {/* Processing indicator - Typing animation */}
              {isProcessing && <ThinkingIndicator />}

              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input */}
        <ChatInput onSend={handleSendMessage} disabled={isProcessing} />
      </div>

      {/* Todo Panel (Gen 3+) - hide when preview panel is open */}
      {showTodoPanel && !showPreviewPanel && <TodoPanel />}

      {/* HTML Preview Panel */}
      {showPreviewPanel && <PreviewPanel />}
    </div>
  );
};

// Thinking indicator with typing dots
const ThinkingIndicator: React.FC = () => {
  return (
    <div className="flex items-start gap-3 animate-fade-in">
      {/* AI Avatar */}
      <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-accent-purple to-accent-pink flex items-center justify-center shrink-0 shadow-lg shadow-purple-500/20">
        <Bot className="w-4 h-4 text-white" />
      </div>

      {/* Thinking bubble */}
      <div className="flex items-center gap-3 px-5 py-3.5 rounded-2xl bg-zinc-800/60 border border-zinc-700/50">
        {/* Typing dots */}
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-primary-400 typing-dot" style={{ animationDelay: '0ms' }} />
          <span className="w-2 h-2 rounded-full bg-primary-400 typing-dot" style={{ animationDelay: '150ms' }} />
          <span className="w-2 h-2 rounded-full bg-primary-400 typing-dot" style={{ animationDelay: '300ms' }} />
        </div>
        <span className="text-sm text-zinc-400">思考中...</span>
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
  // Gen3: 子代理和规划
  gen3: [
    {
      icon: Code2,
      text: '规划一个新功能',
      description: '创建实现计划',
      color: 'from-blue-500/20 to-cyan-500/20',
      borderColor: 'border-blue-500/20',
      iconColor: 'text-blue-400',
    },
    {
      icon: Bug,
      text: '调试复杂问题',
      description: '分步骤排查',
      color: 'from-red-500/20 to-orange-500/20',
      borderColor: 'border-red-500/20',
      iconColor: 'text-red-400',
    },
    {
      icon: FileQuestion,
      text: '研究代码架构',
      description: '启动子任务探索',
      color: 'from-purple-500/20 to-pink-500/20',
      borderColor: 'border-purple-500/20',
      iconColor: 'text-purple-400',
    },
    {
      icon: TestTube2,
      text: '设计测试方案',
      description: '规划测试用例',
      color: 'from-emerald-500/20 to-teal-500/20',
      borderColor: 'border-emerald-500/20',
      iconColor: 'text-emerald-400',
    },
  ],
  // Gen4: 技能和网络
  gen4: [
    {
      icon: Sparkles,
      text: '使用技能提交代码',
      description: '/commit 快捷命令',
      color: 'from-blue-500/20 to-cyan-500/20',
      borderColor: 'border-blue-500/20',
      iconColor: 'text-blue-400',
    },
    {
      icon: Terminal,
      text: '获取最新文档',
      description: '从网络获取信息',
      color: 'from-emerald-500/20 to-teal-500/20',
      borderColor: 'border-emerald-500/20',
      iconColor: 'text-emerald-400',
    },
    {
      icon: Code2,
      text: '创建并提交 PR',
      description: '完整开发流程',
      color: 'from-purple-500/20 to-pink-500/20',
      borderColor: 'border-purple-500/20',
      iconColor: 'text-purple-400',
    },
    {
      icon: Bug,
      text: '查询 API 文档',
      description: '获取外部知识',
      color: 'from-red-500/20 to-orange-500/20',
      borderColor: 'border-red-500/20',
      iconColor: 'text-red-400',
    },
  ],
  // Gen5: 记忆和 RAG
  gen5: [
    {
      icon: Code2,
      text: '记住项目规范',
      description: '存储长期记忆',
      color: 'from-blue-500/20 to-cyan-500/20',
      borderColor: 'border-blue-500/20',
      iconColor: 'text-blue-400',
    },
    {
      icon: FileQuestion,
      text: '搜索历史对话',
      description: '语义记忆检索',
      color: 'from-purple-500/20 to-pink-500/20',
      borderColor: 'border-purple-500/20',
      iconColor: 'text-purple-400',
    },
    {
      icon: Terminal,
      text: '索引代码库',
      description: '建立代码索引',
      color: 'from-emerald-500/20 to-teal-500/20',
      borderColor: 'border-emerald-500/20',
      iconColor: 'text-emerald-400',
    },
    {
      icon: Bug,
      text: '回顾之前的修复',
      description: '检索相似问题',
      color: 'from-red-500/20 to-orange-500/20',
      borderColor: 'border-red-500/20',
      iconColor: 'text-red-400',
    },
  ],
  // Gen6: Computer Use
  gen6: [
    {
      icon: Code2,
      text: '截图当前界面',
      description: '视觉观察分析',
      color: 'from-blue-500/20 to-cyan-500/20',
      borderColor: 'border-blue-500/20',
      iconColor: 'text-blue-400',
    },
    {
      icon: Terminal,
      text: '自动化浏览器操作',
      description: 'Computer Use',
      color: 'from-emerald-500/20 to-teal-500/20',
      borderColor: 'border-emerald-500/20',
      iconColor: 'text-emerald-400',
    },
    {
      icon: FileQuestion,
      text: '测试网页功能',
      description: '模拟用户交互',
      color: 'from-purple-500/20 to-pink-500/20',
      borderColor: 'border-purple-500/20',
      iconColor: 'text-purple-400',
    },
    {
      icon: Bug,
      text: '截图调试 UI',
      description: '可视化问题定位',
      color: 'from-red-500/20 to-orange-500/20',
      borderColor: 'border-red-500/20',
      iconColor: 'text-red-400',
    },
  ],
  // Gen7: 多代理协同
  gen7: [
    {
      icon: Code2,
      text: '启动多代理开发',
      description: '并行协作编码',
      color: 'from-blue-500/20 to-cyan-500/20',
      borderColor: 'border-blue-500/20',
      iconColor: 'text-blue-400',
    },
    {
      icon: Terminal,
      text: '分配子任务',
      description: '代理间协调',
      color: 'from-emerald-500/20 to-teal-500/20',
      borderColor: 'border-emerald-500/20',
      iconColor: 'text-emerald-400',
    },
    {
      icon: FileQuestion,
      text: '编排工作流',
      description: '复杂任务拆解',
      color: 'from-purple-500/20 to-pink-500/20',
      borderColor: 'border-purple-500/20',
      iconColor: 'text-purple-400',
    },
    {
      icon: Bug,
      text: '协作修复 Bug',
      description: '多代理联合调试',
      color: 'from-red-500/20 to-orange-500/20',
      borderColor: 'border-red-500/20',
      iconColor: 'text-red-400',
    },
  ],
  // Gen8: 自我进化
  gen8: [
    {
      icon: Sparkles,
      text: '优化执行策略',
      description: '自我学习改进',
      color: 'from-blue-500/20 to-cyan-500/20',
      borderColor: 'border-blue-500/20',
      iconColor: 'text-blue-400',
    },
    {
      icon: Code2,
      text: '创建新工具',
      description: '动态扩展能力',
      color: 'from-emerald-500/20 to-teal-500/20',
      borderColor: 'border-emerald-500/20',
      iconColor: 'text-emerald-400',
    },
    {
      icon: FileQuestion,
      text: '自我评估性能',
      description: '反思与改进',
      color: 'from-purple-500/20 to-pink-500/20',
      borderColor: 'border-purple-500/20',
      iconColor: 'text-purple-400',
    },
    {
      icon: Bug,
      text: '自动修复流程',
      description: '闭环问题解决',
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
