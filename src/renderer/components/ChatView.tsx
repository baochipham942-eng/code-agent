// ============================================================================
// ChatView - Main Chat Interface
// ============================================================================

import React, { useRef, useEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useAgent } from '../hooks/useAgent';
import { MessageBubble } from './MessageBubble';
import { ChatInput } from './ChatInput';
import { TodoPanel } from './TodoPanel';
import { Bot, Loader2 } from 'lucide-react';

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
      <div className="flex-1 flex flex-col min-w-0">
        {/* Messages */}
        <div className="flex-1 overflow-y-auto">
          {messages.length === 0 ? (
            <EmptyState generation={currentGeneration.name} onSend={handleSendMessage} />
          ) : (
            <div className="max-w-3xl mx-auto py-4 px-4 space-y-4">
              {messages.map((message) => (
                <MessageBubble key={message.id} message={message} />
              ))}

              {/* Processing indicator */}
              {isProcessing && (
                <div className="flex items-center gap-2 text-zinc-400 py-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-sm">Thinking...</span>
                </div>
              )}

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

// Empty state component
const EmptyState: React.FC<{ generation: string; onSend: (message: string) => void }> = ({ generation, onSend }) => {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-4">
      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center mb-4">
        <Bot className="w-8 h-8 text-white" />
      </div>
      <h2 className="text-xl font-semibold text-zinc-100 mb-2">
        Code Agent - {generation}
      </h2>
      <p className="text-zinc-400 max-w-md mb-6">
        I'm an AI coding assistant. I can help you write, edit, and understand
        code. Start by typing a message below.
      </p>
      <div className="flex flex-wrap gap-2 justify-center max-w-lg">
        <SuggestionChip text="Create a React component" onSend={onSend} />
        <SuggestionChip text="Fix a bug in my code" onSend={onSend} />
        <SuggestionChip text="Explain this function" onSend={onSend} />
        <SuggestionChip text="Write unit tests" onSend={onSend} />
      </div>
    </div>
  );
};

// Suggestion chip component
const SuggestionChip: React.FC<{ text: string; onSend: (message: string) => void }> = ({ text, onSend }) => {
  return (
    <button
      onClick={() => onSend(text)}
      className="px-3 py-1.5 rounded-full bg-zinc-800 hover:bg-zinc-700 text-sm text-zinc-300 hover:text-zinc-100 transition-colors"
    >
      {text}
    </button>
  );
};
