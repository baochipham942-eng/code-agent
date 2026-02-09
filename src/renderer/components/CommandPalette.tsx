// ============================================================================
// CommandPalette - 命令面板组件
// Cmd/Ctrl+Shift+P 打开，支持搜索和执行命令
// ============================================================================

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Search, X, Settings, FileText, Trash2, FolderOpen, RotateCcw, Plus, Archive, Moon, Sun, Keyboard, HelpCircle, BarChart2 } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';

// ============================================================================
// Types
// ============================================================================

export interface Command {
  id: string;
  label: string;
  description?: string;
  icon?: React.ReactNode;
  shortcut?: string;
  category: 'session' | 'view' | 'settings' | 'help';
  action: () => void | Promise<void>;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

// ============================================================================
// Component
// ============================================================================

export const CommandPalette: React.FC<CommandPaletteProps> = ({ isOpen, onClose }) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Store hooks
  const {
    setShowSettings,
    setShowDAGPanel,
    showDAGPanel,
    setShowWorkspace,
    showWorkspace,
    setSidebarCollapsed,
    sidebarCollapsed,
    setShowEvalCenter,
  } = useAppStore();

  const {
    createSession,
    clearCurrentSession,
    archiveSession,
    currentSessionId,
  } = useSessionStore();

  // 定义所有可用命令
  const allCommands: Command[] = useMemo(() => [
    // Session commands
    {
      id: 'new-session',
      label: '新建会话',
      description: '创建一个新的对话会话',
      icon: <Plus className="w-4 h-4" />,
      shortcut: '⌘N',
      category: 'session',
      action: () => createSession(),
    },
    {
      id: 'clear-chat',
      label: '清空当前对话',
      description: '清除当前会话的所有消息',
      icon: <Trash2 className="w-4 h-4" />,
      shortcut: '⌘K',
      category: 'session',
      action: () => clearCurrentSession(),
    },
    {
      id: 'archive-session',
      label: '归档当前会话',
      description: '将当前会话移至归档',
      icon: <Archive className="w-4 h-4" />,
      category: 'session',
      action: async () => {
        if (currentSessionId) {
          await archiveSession(currentSessionId);
        }
      },
    },

    // View commands
    {
      id: 'toggle-sidebar',
      label: sidebarCollapsed ? '显示侧边栏' : '隐藏侧边栏',
      description: '切换侧边栏显示状态',
      icon: <FileText className="w-4 h-4" />,
      shortcut: '⌘/',
      category: 'view',
      action: () => setSidebarCollapsed(!sidebarCollapsed),
    },
    {
      id: 'toggle-dag',
      label: showDAGPanel ? '隐藏 DAG 面板' : '显示 DAG 面板',
      description: '切换任务 DAG 可视化面板',
      icon: <BarChart2 className="w-4 h-4" />,
      shortcut: '⌘D',
      category: 'view',
      action: () => setShowDAGPanel(!showDAGPanel),
    },
    {
      id: 'toggle-workspace',
      label: showWorkspace ? '隐藏工作区' : '显示工作区',
      description: '切换工作区面板',
      icon: <FolderOpen className="w-4 h-4" />,
      shortcut: '⌘E',
      category: 'view',
      action: () => setShowWorkspace(!showWorkspace),
    },
    {
      id: 'show-eval-center',
      label: '打开评测中心',
      description: '评测和遥测分析',
      icon: <BarChart2 className="w-4 h-4" />,
      category: 'view',
      action: () => setShowEvalCenter(true),
    },

    // Settings commands
    {
      id: 'open-settings',
      label: '打开设置',
      description: '打开应用设置面板',
      icon: <Settings className="w-4 h-4" />,
      shortcut: '⌘,',
      category: 'settings',
      action: () => setShowSettings(true),
    },
    {
      id: 'keyboard-shortcuts',
      label: '键盘快捷键',
      description: '查看和自定义快捷键',
      icon: <Keyboard className="w-4 h-4" />,
      category: 'settings',
      action: () => {
        setShowSettings(true);
        // TODO: 跳转到快捷键设置 tab
      },
    },

    // Help commands
    {
      id: 'show-help',
      label: '帮助',
      description: '查看帮助文档',
      icon: <HelpCircle className="w-4 h-4" />,
      category: 'help',
      action: () => {
        window.open('https://github.com/anthropics/claude-code/issues', '_blank');
      },
    },
  ], [
    createSession,
    clearCurrentSession,
    archiveSession,
    currentSessionId,
    setShowSettings,
    setShowDAGPanel,
    showDAGPanel,
    setShowWorkspace,
    showWorkspace,
    setSidebarCollapsed,
    sidebarCollapsed,
    setShowEvalCenter,
  ]);

  // 过滤命令
  const filteredCommands = useMemo(() => {
    if (!query.trim()) return allCommands;

    const lowerQuery = query.toLowerCase();
    return allCommands.filter(cmd =>
      cmd.label.toLowerCase().includes(lowerQuery) ||
      cmd.description?.toLowerCase().includes(lowerQuery)
    );
  }, [query, allCommands]);

  // 按分类分组
  const groupedCommands = useMemo(() => {
    const groups: Record<string, Command[]> = {
      session: [],
      view: [],
      settings: [],
      help: [],
    };

    filteredCommands.forEach(cmd => {
      groups[cmd.category].push(cmd);
    });

    return groups;
  }, [filteredCommands]);

  // 执行命令
  const executeCommand = useCallback((command: Command) => {
    command.action();
    onClose();
    setQuery('');
  }, [onClose]);

  // 键盘导航
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(prev =>
          prev < filteredCommands.length - 1 ? prev + 1 : 0
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(prev =>
          prev > 0 ? prev - 1 : filteredCommands.length - 1
        );
        break;
      case 'Enter':
        e.preventDefault();
        if (filteredCommands[selectedIndex]) {
          executeCommand(filteredCommands[selectedIndex]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
    }
  }, [filteredCommands, selectedIndex, executeCommand, onClose]);

  // 重置选中索引
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // 打开时聚焦输入框
  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
      setQuery('');
      setSelectedIndex(0);
    }
  }, [isOpen]);

  // 滚动到选中项
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;

    const selected = list.querySelector('[data-selected="true"]');
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  if (!isOpen) return null;

  const categoryLabels: Record<string, string> = {
    session: '会话',
    view: '视图',
    settings: '设置',
    help: '帮助',
  };

  let flatIndex = 0;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-lg bg-zinc-900 rounded-xl border border-zinc-800 shadow-2xl overflow-hidden animate-fadeIn">
        {/* Search input */}
        <div className="flex items-center px-4 py-3 border-b border-zinc-800">
          <Search className="w-5 h-5 text-zinc-500 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索命令..."
            className="flex-1 ml-3 bg-transparent text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none"
          />
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-zinc-800 transition-colors"
          >
            <X className="w-4 h-4 text-zinc-500" />
          </button>
        </div>

        {/* Command list */}
        <div
          ref={listRef}
          className="max-h-[50vh] overflow-y-auto py-2"
        >
          {filteredCommands.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-zinc-500">
              没有找到匹配的命令
            </div>
          ) : (
            Object.entries(groupedCommands).map(([category, commands]) => {
              if (commands.length === 0) return null;

              return (
                <div key={category}>
                  <div className="px-4 py-1.5 text-xs font-medium text-zinc-500 uppercase tracking-wider">
                    {categoryLabels[category]}
                  </div>
                  {commands.map(cmd => {
                    const isSelected = flatIndex === selectedIndex;
                    flatIndex++;

                    return (
                      <button
                        key={cmd.id}
                        data-selected={isSelected}
                        onClick={() => executeCommand(cmd)}
                        className={`w-full flex items-center gap-3 px-4 py-2 text-left transition-colors ${
                          isSelected
                            ? 'bg-zinc-800 text-zinc-100'
                            : 'text-zinc-300 hover:bg-zinc-800/50'
                        }`}
                      >
                        <span className={isSelected ? 'text-primary-400' : 'text-zinc-500'}>
                          {cmd.icon}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm">{cmd.label}</div>
                          {cmd.description && (
                            <div className="text-xs text-zinc-500 truncate">
                              {cmd.description}
                            </div>
                          )}
                        </div>
                        {cmd.shortcut && (
                          <kbd className="px-1.5 py-0.5 text-xs bg-zinc-800 rounded text-zinc-400 border border-zinc-700">
                            {cmd.shortcut}
                          </kbd>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 border-t border-zinc-800 text-xs text-zinc-500 flex items-center gap-4">
          <span>
            <kbd className="px-1 py-0.5 bg-zinc-800 rounded">↑↓</kbd> 导航
          </span>
          <span>
            <kbd className="px-1 py-0.5 bg-zinc-800 rounded">Enter</kbd> 执行
          </span>
          <span>
            <kbd className="px-1 py-0.5 bg-zinc-800 rounded">Esc</kbd> 关闭
          </span>
        </div>
      </div>
    </div>
  );
};

export default CommandPalette;
