// ============================================================================
// CommandPalette - 命令面板组件
// Cmd/Ctrl+K 打开，支持搜索和执行命令
// ============================================================================

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Search, X, Settings, FileText, Trash2, FolderOpen, Plus, Archive, Keyboard, HelpCircle, BarChart2 } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import {
  formatShortcutForDisplay,
  getKeybindingAccelerator,
  type KeybindingActionId,
} from '@shared/keybindings';
import { useKeybindingsSettings } from '../hooks/useKeybindingsSettings';
import { ConfirmDialog } from './composites/ConfirmDialog';
import { useI18n } from '../hooks/useI18n';
import { AGENT_NEO_HELP_URL } from '@shared/constants/network';

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
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isClearConfirmationOpen, setIsClearConfirmationOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { keybindings, platform } = useKeybindingsSettings();
  const getShortcutLabel = useCallback((actionId: KeybindingActionId): string | undefined => {
    const accelerator = getKeybindingAccelerator(keybindings, actionId, platform);
    return accelerator ? formatShortcutForDisplay(accelerator, platform) : undefined;
  }, [keybindings, platform]);

  // Store hooks
  const {
    setShowSettings,
    openSettingsTab,
    setShowDAGPanel,
    showDAGPanel,
    setShowWorkspace,
    showWorkspace,
    setSidebarCollapsed,
    sidebarCollapsed,
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
      label: t.slashCommands.new.label,
      description: t.slashCommands.new.description,
      icon: <Plus className="w-4 h-4" />,
      shortcut: getShortcutLabel('session.new'),
      category: 'session',
      action: () => createSession(),
    },
    {
      id: 'clear-chat',
      label: t.slashCommands.clear.label,
      description: t.slashCommands.clear.description,
      icon: <Trash2 className="w-4 h-4" />,
      shortcut: getShortcutLabel('session.clear'),
      category: 'session',
      action: () => clearCurrentSession(),
    },
    {
      id: 'archive-session',
      label: t.slashCommands.archive.label,
      description: t.slashCommands.archive.description,
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
      label: sidebarCollapsed ? t.slashCommands.sidebar.labelShow : t.slashCommands.sidebar.labelHide,
      description: t.slashCommands.sidebar.description,
      icon: <FileText className="w-4 h-4" />,
      shortcut: getShortcutLabel('sidebar.toggle'),
      category: 'view',
      action: () => setSidebarCollapsed(!sidebarCollapsed),
    },
    {
      id: 'toggle-dag',
      label: showDAGPanel ? t.slashCommands.dag.labelHide : t.slashCommands.dag.labelShow,
      description: t.slashCommands.dag.description,
      icon: <BarChart2 className="w-4 h-4" />,
      shortcut: getShortcutLabel('dag.toggle'),
      category: 'view',
      action: () => setShowDAGPanel(!showDAGPanel),
    },
    {
      id: 'toggle-workspace',
      label: showWorkspace ? t.slashCommands.workspace.labelHide : t.slashCommands.workspace.labelShow,
      description: t.slashCommands.workspace.description,
      icon: <FolderOpen className="w-4 h-4" />,
      shortcut: getShortcutLabel('workspace.toggle'),
      category: 'view',
      action: () => setShowWorkspace(!showWorkspace),
    },
    // Settings commands
    {
      id: 'open-settings',
      label: t.slashCommands.settings.label,
      description: t.slashCommands.settings.description,
      icon: <Settings className="w-4 h-4" />,
      shortcut: getShortcutLabel('settings.open'),
      category: 'settings',
      action: () => setShowSettings(true),
    },
    {
      id: 'keyboard-shortcuts',
      label: t.slashCommands.shortcuts.label,
      description: t.slashCommands.shortcuts.description,
      icon: <Keyboard className="w-4 h-4" />,
      category: 'settings',
      action: () => openSettingsTab('keybindings'),
    },

    // Help commands
    {
      id: 'show-help',
      label: t.slashCommands.help.label,
      description: t.slashCommands.help.description,
      icon: <HelpCircle className="w-4 h-4" />,
      category: 'help',
      action: () => {
        window.open(AGENT_NEO_HELP_URL, '_blank');
      },
    },
  ], [
    createSession,
    clearCurrentSession,
    archiveSession,
    currentSessionId,
    getShortcutLabel,
    setShowSettings,
    openSettingsTab,
    setShowDAGPanel,
    showDAGPanel,
    setShowWorkspace,
    showWorkspace,
    setSidebarCollapsed,
    sidebarCollapsed,
    t,
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
    if (command.id === 'clear-chat') {
      setIsClearConfirmationOpen(true);
      return;
    }

    command.action();
    onClose();
    setQuery('');
  }, [onClose]);

  const confirmClearChat = useCallback(() => {
    setIsClearConfirmationOpen(false);
    clearCurrentSession();
    onClose();
    setQuery('');
  }, [clearCurrentSession, onClose]);

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
      setIsClearConfirmationOpen(false);
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
    session: t.commandPalette.categorySession,
    view: t.commandPalette.categoryView,
    settings: t.commandPalette.categorySettings,
    help: t.commandPalette.categoryHelp,
  };

  let flatIndex = 0;

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div role="dialog" aria-modal="true" aria-label={t.commandPalette.ariaLabel} className="relative w-full max-w-lg bg-zinc-900 rounded-xl border border-zinc-700 shadow-2xl overflow-hidden animate-fadeIn">
        {/* Search input */}
        <div className="flex items-center px-4 py-3 border-b border-zinc-700">
          <Search className="w-5 h-5 text-zinc-500 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t.commandPalette.searchPlaceholder}
            className="flex-1 ml-3 bg-transparent text-sm text-zinc-200 placeholder-zinc-500 focus:outline-hidden"
          />
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-zinc-700 transition-colors"
            aria-label={t.commandPalette.closeAriaLabel}
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
              {t.commandPalette.noMatches}
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
                            ? 'bg-zinc-700 text-zinc-200'
                            : 'text-zinc-400 hover:bg-zinc-800'
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
                          <kbd className="px-1.5 py-0.5 text-xs bg-zinc-700 rounded text-zinc-400 border border-zinc-700">
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
        <div className="px-4 py-2 border-t border-zinc-700 text-xs text-zinc-500 flex items-center gap-4">
          <span>
            <kbd className="px-1 py-0.5 bg-zinc-700 rounded">↑↓</kbd> {t.commandPalette.footerNavigate}
          </span>
          <span>
            <kbd className="px-1 py-0.5 bg-zinc-700 rounded">Enter</kbd> {t.commandPalette.footerExecute}
          </span>
          <span>
            <kbd className="px-1 py-0.5 bg-zinc-700 rounded">Esc</kbd> {t.commandPalette.footerClose}
          </span>
        </div>
      </div>
      </div>

      <ConfirmDialog
        isOpen={isClearConfirmationOpen}
        title={t.commandPalette.clearConfirmTitle}
        message={t.commandPalette.clearConfirmMessage}
        variant="danger"
        confirmText={t.commandPalette.clearConfirmAction}
        onConfirm={confirmClearChat}
        onCancel={() => setIsClearConfirmationOpen(false)}
      />
    </>
  );
};

export default CommandPalette;
