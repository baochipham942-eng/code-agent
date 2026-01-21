// ============================================================================
// ConversationTabs - 多会话 Tab 栏组件
// ============================================================================

import React, { useState, useRef, useCallback } from 'react';
import { X, Plus, Pin, PinOff, MoreHorizontal, Loader2 } from 'lucide-react';
import { useConversationTabs, type ConversationTab } from '../../../contexts/ConversationTabsContext';
import { useSessionStore } from '../../../stores/sessionStore';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

interface TabItemProps {
  tab: ConversationTab;
  isActive: boolean;
  isUnread: boolean;
  onActivate: () => void;
  onClose: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  draggedTabId: string | null;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  tabId: string | null;
}

// ----------------------------------------------------------------------------
// Tab Item Component
// ----------------------------------------------------------------------------

const TabItem: React.FC<TabItemProps> = ({
  tab,
  isActive,
  isUnread,
  onActivate,
  onClose,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDrop,
  draggedTabId,
}) => {
  const isDragging = draggedTabId === tab.id;
  const isDragTarget = draggedTabId !== null && draggedTabId !== tab.id;

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onContextMenu={onContextMenu}
      onClick={onActivate}
      className={`
        group relative flex items-center gap-1.5 px-3 py-1.5 min-w-[120px] max-w-[180px]
        border-r border-zinc-800/50
        cursor-pointer select-none
        transition-all duration-150
        ${isActive
          ? 'bg-zinc-800/80 text-zinc-100'
          : 'bg-zinc-900/50 text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
        }
        ${isDragging ? 'opacity-50' : ''}
        ${isDragTarget ? 'border-l-2 border-l-primary-500' : ''}
      `}
    >
      {/* Pin indicator */}
      {tab.isPinned && (
        <Pin className="w-3 h-3 text-primary-400 shrink-0" />
      )}

      {/* Unread dot */}
      {isUnread && !isActive && (
        <span className="absolute left-1.5 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-primary-500" />
      )}

      {/* Title */}
      <span className="flex-1 truncate text-xs font-medium">
        {tab.title || '新对话'}
      </span>

      {/* Close button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className={`
          p-0.5 rounded
          opacity-0 group-hover:opacity-100
          hover:bg-zinc-700/50 hover:text-zinc-100
          transition-opacity duration-150
          ${tab.isPinned ? 'text-zinc-500' : 'text-zinc-500'}
        `}
        title={tab.isPinned ? '取消固定后关闭' : '关闭'}
      >
        <X className="w-3 h-3" />
      </button>

      {/* Active indicator */}
      {isActive && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary-500" />
      )}
    </div>
  );
};

// ----------------------------------------------------------------------------
// Context Menu Component
// ----------------------------------------------------------------------------

interface TabContextMenuProps {
  state: ContextMenuState;
  tab: ConversationTab | null;
  onClose: () => void;
  onPin: () => void;
  onCloseTab: () => void;
  onCloseOthers: () => void;
  onCloseToLeft: () => void;
  onCloseToRight: () => void;
  onCloseAll: () => void;
}

const TabContextMenu: React.FC<TabContextMenuProps> = ({
  state,
  tab,
  onClose,
  onPin,
  onCloseTab,
  onCloseOthers,
  onCloseToLeft,
  onCloseToRight,
  onCloseAll,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  React.useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    if (state.visible) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [state.visible, onClose]);

  if (!state.visible || !tab) return null;

  const menuItems = [
    {
      label: tab.isPinned ? '取消固定' : '固定',
      icon: tab.isPinned ? PinOff : Pin,
      onClick: onPin,
    },
    { type: 'divider' as const },
    {
      label: '关闭',
      icon: X,
      onClick: onCloseTab,
    },
    {
      label: '关闭其他',
      onClick: onCloseOthers,
    },
    {
      label: '关闭左侧',
      onClick: onCloseToLeft,
    },
    {
      label: '关闭右侧',
      onClick: onCloseToRight,
    },
    { type: 'divider' as const },
    {
      label: '关闭全部',
      onClick: onCloseAll,
      danger: true,
    },
  ];

  return (
    <div
      ref={menuRef}
      className="fixed z-50 py-1 min-w-[160px] bg-zinc-900 border border-zinc-700/50 rounded-lg shadow-xl"
      style={{ left: state.x, top: state.y }}
    >
      {menuItems.map((item, index) => {
        if (item.type === 'divider') {
          return <div key={index} className="my-1 border-t border-zinc-800" />;
        }

        const Icon = item.icon;
        return (
          <button
            key={item.label}
            onClick={() => {
              item.onClick();
              onClose();
            }}
            className={`
              w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left
              ${item.danger ? 'text-red-400 hover:bg-red-500/10' : 'text-zinc-300 hover:bg-zinc-800'}
              transition-colors
            `}
          >
            {Icon && <Icon className="w-3.5 h-3.5" />}
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
};

// ----------------------------------------------------------------------------
// Main Component
// ----------------------------------------------------------------------------

export const ConversationTabs: React.FC = () => {
  const {
    tabs,
    activeTabId,
    addTab,
    closeTab,
    setActiveTab,
    moveTab,
    togglePinTab,
    closeOtherTabs,
    closeTabsToLeft,
    closeTabsToRight,
    closeAllTabs,
  } = useConversationTabs();

  const { createSession, isSessionUnread, isLoading } = useSessionStore();
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    tabId: null,
  });

  // 创建新会话
  const handleNewTab = useCallback(async () => {
    const session = await createSession('新对话');
    if (session) {
      addTab(session.id, session.title);
    }
  }, [createSession, addTab]);

  // 拖拽处理
  const handleDragStart = useCallback((tabId: string) => (e: React.DragEvent) => {
    setDraggedTabId(tabId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tabId);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback((toTabId: string) => (e: React.DragEvent) => {
    e.preventDefault();
    if (!draggedTabId || draggedTabId === toTabId) {
      setDraggedTabId(null);
      return;
    }

    const fromIndex = tabs.findIndex(t => t.id === draggedTabId);
    const toIndex = tabs.findIndex(t => t.id === toTabId);

    if (fromIndex !== -1 && toIndex !== -1) {
      moveTab(fromIndex, toIndex);
    }

    setDraggedTabId(null);
  }, [draggedTabId, tabs, moveTab]);

  const handleDragEnd = useCallback(() => {
    setDraggedTabId(null);
  }, []);

  // 右键菜单
  const handleContextMenu = useCallback((tabId: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      tabId,
    });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(prev => ({ ...prev, visible: false }));
  }, []);

  const contextMenuTab = tabs.find(t => t.id === contextMenu.tabId) || null;

  // 如果没有 tabs，不显示 tab 栏
  if (tabs.length === 0) {
    return null;
  }

  return (
    <>
      <div className="flex items-center bg-zinc-900/80 border-b border-zinc-800/50">
        {/* Tab List */}
        <div
          className="flex-1 flex items-center overflow-x-auto scrollbar-thin scrollbar-thumb-zinc-700"
          onDragEnd={handleDragEnd}
        >
          {tabs.map((tab) => (
            <TabItem
              key={tab.id}
              tab={tab}
              isActive={tab.id === activeTabId}
              isUnread={isSessionUnread(tab.id)}
              onActivate={() => setActiveTab(tab.id)}
              onClose={() => closeTab(tab.id)}
              onContextMenu={handleContextMenu(tab.id)}
              onDragStart={handleDragStart(tab.id)}
              onDragOver={handleDragOver}
              onDrop={handleDrop(tab.id)}
              draggedTabId={draggedTabId}
            />
          ))}
        </div>

        {/* New Tab Button */}
        <button
          onClick={handleNewTab}
          disabled={isLoading}
          className="
            flex items-center justify-center
            w-8 h-8 mx-1
            text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/50
            rounded transition-colors
            disabled:opacity-50 disabled:cursor-not-allowed
          "
          title="新建对话"
        >
          {isLoading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Plus className="w-4 h-4" />
          )}
        </button>

        {/* More Options */}
        <button
          onClick={(e) => {
            // 显示更多选项菜单
            if (tabs.length > 0) {
              setContextMenu({
                visible: true,
                x: e.clientX,
                y: e.clientY,
                tabId: activeTabId,
              });
            }
          }}
          className="
            flex items-center justify-center
            w-8 h-8 mr-1
            text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/50
            rounded transition-colors
          "
          title="更多选项"
        >
          <MoreHorizontal className="w-4 h-4" />
        </button>
      </div>

      {/* Context Menu */}
      <TabContextMenu
        state={contextMenu}
        tab={contextMenuTab}
        onClose={closeContextMenu}
        onPin={() => contextMenu.tabId && togglePinTab(contextMenu.tabId)}
        onCloseTab={() => contextMenu.tabId && closeTab(contextMenu.tabId)}
        onCloseOthers={() => contextMenu.tabId && closeOtherTabs(contextMenu.tabId)}
        onCloseToLeft={() => contextMenu.tabId && closeTabsToLeft(contextMenu.tabId)}
        onCloseToRight={() => contextMenu.tabId && closeTabsToRight(contextMenu.tabId)}
        onCloseAll={closeAllTabs}
      />
    </>
  );
};

export default ConversationTabs;
