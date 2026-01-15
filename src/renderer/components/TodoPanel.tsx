// ============================================================================
// TodoPanel - Task Tracking Panel (Gen 3+)
// ============================================================================

import React from 'react';
import { useAppStore } from '../stores/appStore';
import { CheckCircle2, Circle, Loader2, ListTodo } from 'lucide-react';
import type { TodoItem } from '@shared/types';

export const TodoPanel: React.FC = () => {
  const { todos } = useAppStore();

  const completedCount = todos.filter((t) => t.status === 'completed').length;
  const totalCount = todos.length;
  const progress = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;

  return (
    <div className="w-72 border-l border-zinc-800 bg-zinc-900/50 flex flex-col">
      {/* Header */}
      <div className="p-3 border-b border-zinc-800">
        <div className="flex items-center gap-2 mb-2">
          <ListTodo className="w-4 h-4 text-purple-400" />
          <span className="text-sm font-medium text-zinc-100">Tasks</span>
          <span className="ml-auto text-xs text-zinc-500">
            {completedCount}/{totalCount}
          </span>
        </div>

        {/* Progress bar */}
        <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-purple-500 transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Todo List */}
      <div className="flex-1 overflow-y-auto p-2">
        <div className="space-y-1">
          {todos.map((todo, index) => (
            <TodoItemDisplay key={index} todo={todo} />
          ))}
        </div>
      </div>
    </div>
  );
};

// Individual todo item
const TodoItemDisplay: React.FC<{ todo: TodoItem }> = ({ todo }) => {
  const getStatusIcon = () => {
    switch (todo.status) {
      case 'completed':
        return <CheckCircle2 className="w-4 h-4 text-green-400" />;
      case 'in_progress':
        return <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />;
      default:
        return <Circle className="w-4 h-4 text-zinc-500" />;
    }
  };

  const getStatusStyles = () => {
    switch (todo.status) {
      case 'completed':
        return 'text-zinc-500 line-through';
      case 'in_progress':
        return 'text-zinc-100';
      default:
        return 'text-zinc-400';
    }
  };

  return (
    <div
      className={`flex items-start gap-2 p-2 rounded-lg ${
        todo.status === 'in_progress' ? 'bg-blue-500/10' : ''
      }`}
    >
      <div className="mt-0.5">{getStatusIcon()}</div>
      <span className={`text-sm ${getStatusStyles()}`}>
        {todo.status === 'in_progress' ? todo.activeForm : todo.content}
      </span>
    </div>
  );
};
