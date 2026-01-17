// ============================================================================
// ChatView - Main Chat Interface (Enhanced UI/UX - Terminal Noir)
// ============================================================================

import React, { useRef, useEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useAgent } from '../hooks/useAgent';
import { MessageBubble } from './MessageBubble';
import { ChatInput } from './ChatInput';
import { TodoPanel } from './TodoPanel';
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
  const { currentGeneration } = useAppStore();
  const { todos } = useSessionStore();
  const { messages, isProcessing, sendMessage } = useAgent();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSendMessage = async (content: string) => {
    await sendMessage(content);
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
            <EmptyState generation={currentGeneration.name} onSend={handleSendMessage} />
          ) : (
            <div className="max-w-3xl mx-auto py-6 px-4 space-y-6">
              {messages.map((message, index) => (
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

      {/* Todo Panel (Gen 3+) */}
      {showTodoPanel && <TodoPanel />}
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
        <span className="text-sm text-zinc-400">Thinking...</span>
      </div>
    </div>
  );
};

// Suggestion card data
const suggestions = [
  {
    icon: Code2,
    text: 'Create a React component',
    description: 'Build UI components',
    color: 'from-blue-500/20 to-cyan-500/20',
    borderColor: 'border-blue-500/20',
    iconColor: 'text-blue-400',
  },
  {
    icon: Bug,
    text: 'Fix a bug in my code',
    description: 'Debug and resolve issues',
    color: 'from-red-500/20 to-orange-500/20',
    borderColor: 'border-red-500/20',
    iconColor: 'text-red-400',
  },
  {
    icon: FileQuestion,
    text: 'Explain this function',
    description: 'Understand code logic',
    color: 'from-purple-500/20 to-pink-500/20',
    borderColor: 'border-purple-500/20',
    iconColor: 'text-purple-400',
  },
  {
    icon: TestTube2,
    text: 'Write unit tests',
    description: 'Ensure code quality',
    color: 'from-emerald-500/20 to-teal-500/20',
    borderColor: 'border-emerald-500/20',
    iconColor: 'text-emerald-400',
  },
];

// Empty state component with enhanced design
const EmptyState: React.FC<{ generation: string; onSend: (message: string) => void }> = ({
  generation,
  onSend,
}) => {
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
        Your AI-powered coding companion. I can help you write, debug, explain, and test code.
        Start with a suggestion below or type your own request.
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
        <span>Quick tip: Press <kbd className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono text-2xs">/</kbd> to access commands</span>
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
