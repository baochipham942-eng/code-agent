// ============================================================================
// SlashCommandPopover - Inline command suggestions when typing "/"
// Replaces full-screen CommandPalette for "/" trigger in ChatInput
// ============================================================================

import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Plus, Trash2, Archive, FileText, FolderOpen,
  BarChart2, Settings, Keyboard, HelpCircle,
  Terminal, Cpu, Plug, Zap, ClipboardList,
  MessageCircleQuestion, ZapOff, Flame, Rocket,
  Lock, LockOpen,
} from 'lucide-react';
import { useAppStore } from '../../../../stores/appStore';
import { useSessionStore } from '../../../../stores/sessionStore';
import { useModeStore } from '../../../../stores/modeStore';
import { usePermissionStore } from '../../../../stores/permissionStore';
import { initializeCommands, getCommandRegistry } from '@shared/commands';
import type { CommandDefinition } from '@shared/commands';

interface SlashCommand {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  shortcut?: string;
  action: () => void;
}

interface SlashCommandPopoverProps {
  isOpen: boolean;
  filter: string;
  onClose: () => void;
  onSelect: (command: SlashCommand) => void;
}

export const SlashCommandPopover: React.FC<SlashCommandPopoverProps> = ({
  isOpen,
  filter,
  onClose,
  onSelect,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

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

  const setInteractionMode = useModeStore((s) => s.setInteractionMode);
  const setEffortLevel = useModeStore((s) => s.setEffortLevel);
  const setGlobalMode = usePermissionStore((s) => s.setGlobalMode);

  // Icon mapping for registry commands
  const registryIconMap: Record<string, React.ReactNode> = useMemo(() => ({
    clear: <Trash2 className="w-4 h-4" />,
    help: <HelpCircle className="w-4 h-4" />,
    config: <Settings className="w-4 h-4" />,
    model: <Cpu className="w-4 h-4" />,
    cost: <BarChart2 className="w-4 h-4" />,
    compact: <Zap className="w-4 h-4" />,
    agents: <Terminal className="w-4 h-4" />,
    status: <BarChart2 className="w-4 h-4" />,
    plugins: <Plug className="w-4 h-4" />,
  }), []);

  // GUI-only commands (operate on store/UI directly, not in registry)
  const guiOnlyCommands: SlashCommand[] = useMemo(() => [
    {
      id: 'new',
      label: '新建会话',
      description: '创建新对话',
      icon: <Plus className="w-4 h-4" />,
      shortcut: '⌘N',
      action: () => createSession(),
    },
    {
      id: 'clear',
      label: '清空对话',
      description: '清除当前会话消息',
      icon: <Trash2 className="w-4 h-4" />,
      shortcut: '⌘K',
      action: () => clearCurrentSession(),
    },
    {
      id: 'help',
      label: '帮助',
      description: '查看帮助文档',
      icon: <HelpCircle className="w-4 h-4" />,
      action: () => window.open('https://github.com/anthropics/claude-code/issues', '_blank'),
    },
    {
      id: 'archive',
      label: '归档会话',
      description: '将当前会话移至归档',
      icon: <Archive className="w-4 h-4" />,
      action: async () => {
        if (currentSessionId) await archiveSession(currentSessionId);
      },
    },
    {
      id: 'sidebar',
      label: sidebarCollapsed ? '显示侧边栏' : '隐藏侧边栏',
      description: '切换侧边栏',
      icon: <FileText className="w-4 h-4" />,
      shortcut: '⌘/',
      action: () => setSidebarCollapsed(!sidebarCollapsed),
    },
    {
      id: 'dag',
      label: showDAGPanel ? '隐藏 DAG' : '显示 DAG',
      description: '任务 DAG 可视化',
      icon: <BarChart2 className="w-4 h-4" />,
      action: () => setShowDAGPanel(!showDAGPanel),
    },
    {
      id: 'workspace',
      label: showWorkspace ? '隐藏工作区' : '显示工作区',
      description: '切换工作区面板',
      icon: <FolderOpen className="w-4 h-4" />,
      action: () => setShowWorkspace(!showWorkspace),
    },
    {
      id: 'eval',
      label: '评测中心',
      description: '评测和遥测分析',
      icon: <BarChart2 className="w-4 h-4" />,
      action: () => setShowEvalCenter(true),
    },
    {
      id: 'settings',
      label: '设置',
      description: '打开应用设置',
      icon: <Settings className="w-4 h-4" />,
      shortcut: '⌘,',
      action: () => setShowSettings(true),
    },
    {
      id: 'shortcuts',
      label: '快捷键',
      description: '查看键盘快捷键',
      icon: <Keyboard className="w-4 h-4" />,
      action: () => setShowSettings(true),
    },
    // --- 模式 / 强度 / 权限命令 ---
    {
      id: 'code',
      label: 'Code 模式',
      description: '切换到 Code 模式',
      icon: <Terminal className="w-4 h-4" />,
      action: () => setInteractionMode('code'),
    },
    {
      id: 'plan',
      label: 'Plan 模式',
      description: '切换到 Plan 模式（只出方案不动代码）',
      icon: <ClipboardList className="w-4 h-4" />,
      action: () => setInteractionMode('plan'),
    },
    {
      id: 'ask',
      label: 'Ask 模式',
      description: '切换到 Ask 模式（只回答问题）',
      icon: <MessageCircleQuestion className="w-4 h-4" />,
      action: () => setInteractionMode('ask'),
    },
    {
      id: 'low',
      label: '低推理强度',
      description: '设置低推理强度',
      icon: <ZapOff className="w-4 h-4" />,
      action: () => setEffortLevel('low'),
    },
    {
      id: 'med',
      label: '中推理强度',
      description: '设置中推理强度',
      icon: <Zap className="w-4 h-4" />,
      action: () => setEffortLevel('medium'),
    },
    {
      id: 'high',
      label: '高推理强度',
      description: '设置高推理强度',
      icon: <Flame className="w-4 h-4" />,
      action: () => setEffortLevel('high'),
    },
    {
      id: 'max',
      label: '最大推理强度',
      description: '设置最大推理强度',
      icon: <Rocket className="w-4 h-4" />,
      action: () => setEffortLevel('max'),
    },
    {
      id: 'default',
      label: '默认权限',
      description: '默认权限模式',
      icon: <Lock className="w-4 h-4" />,
      action: () => setGlobalMode('default'),
    },
    {
      id: 'fullaccess',
      label: '完全访问',
      description: '完全访问模式（跳过确认）',
      icon: <LockOpen className="w-4 h-4" />,
      action: () => setGlobalMode('full_access'),
    },
  ], [
    createSession, clearCurrentSession, archiveSession, currentSessionId,
    setShowSettings, setShowDAGPanel, showDAGPanel,
    setShowWorkspace, showWorkspace, setSidebarCollapsed, sidebarCollapsed,
    setShowEvalCenter, setInteractionMode, setEffortLevel, setGlobalMode,
  ]);

  // Merge registry commands (gui surface) with GUI-only commands
  const allCommands: SlashCommand[] = useMemo(() => {
    initializeCommands();
    const registry = getCommandRegistry();
    const registryDefs = registry.list('gui');
    const guiOnlyIds = new Set(guiOnlyCommands.map(c => c.id));

    // Convert registry commands to SlashCommand format (skip those already in GUI-only)
    const fromRegistry: SlashCommand[] = registryDefs
      .filter((def: CommandDefinition) => !guiOnlyIds.has(def.id))
      .map((def: CommandDefinition) => ({
        id: def.id,
        label: def.name,
        description: def.description,
        icon: registryIconMap[def.id] || <Terminal className="w-4 h-4" />,
        action: () => {
          // Registry command execution in GUI: log to console for now
          // Full IPC execution will be added in a future phase
          console.log(`[Command] /${def.id} — ${def.description}`);
        },
      }));

    // GUI-only first, then registry commands
    return [...guiOnlyCommands, ...fromRegistry];
  }, [guiOnlyCommands, registryIconMap]);

  const filtered = useMemo(() => {
    if (!filter) return allCommands;
    const lower = filter.toLowerCase();
    return allCommands.filter(c =>
      c.id.includes(lower) || c.label.toLowerCase().includes(lower)
    );
  }, [filter, allCommands]);

  // Reset selection on filter change
  useEffect(() => {
    setSelectedIndex(0);
  }, [filter]);

  // Keyboard navigation via global handler
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => (prev < filtered.length - 1 ? prev + 1 : 0));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => (prev > 0 ? prev - 1 : filtered.length - 1));
      } else if (e.key === 'Enter' && filtered[selectedIndex]) {
        e.preventDefault();
        onSelect(filtered[selectedIndex]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, filtered, selectedIndex, onSelect, onClose]);

  // Scroll selected into view
  useEffect(() => {
    const el = listRef.current?.querySelector('[data-selected="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (!isOpen || filtered.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 mb-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl z-20 max-h-[280px] overflow-y-auto animate-fade-in"
    >
      <div className="py-1">
        {filtered.map((cmd, i) => (
          <button
            key={cmd.id}
            data-selected={i === selectedIndex}
            onClick={() => onSelect(cmd)}
            className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
              i === selectedIndex
                ? 'bg-zinc-800 text-zinc-200'
                : 'text-zinc-400 hover:bg-zinc-800/50'
            }`}
          >
            <span className={i === selectedIndex ? 'text-primary-400' : 'text-zinc-500'}>
              {cmd.icon}
            </span>
            <div className="flex-1 min-w-0">
              <span className="text-sm">/{cmd.id}</span>
              <span className="text-xs text-zinc-500 ml-2">{cmd.description}</span>
            </div>
            {cmd.shortcut && (
              <kbd className="px-1.5 py-0.5 text-[10px] bg-zinc-800 rounded text-zinc-500 border border-zinc-700">
                {cmd.shortcut}
              </kbd>
            )}
          </button>
        ))}
      </div>
    </div>
  );
};
