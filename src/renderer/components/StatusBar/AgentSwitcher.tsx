// ============================================================================
// AgentSwitcher - 运行时 Agent 切换下拉框
// ============================================================================
// 嵌入 StatusBar，按 source 分组显示 builtin / user / project。
// 抄 ModelSwitcher 的 Portal + Popover + 外部点击关闭范式。
// 当前选中状态持久化到 appStore.activeAgentId（localStorage）。
//
// 数据来源：useAgentRegistryStore.entries（IPC agents:list + agents:changed 推送）

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Hammer, User, FolderTree } from 'lucide-react';
import { useAgentRegistryStore } from '../../stores/agentRegistryStore';
import { useAppStore } from '../../stores/appStore';
import { isPanelVisibleAgent, type AgentListEntry, type AgentSource } from '@shared/contract/agentRegistry';
import { useI18n } from '../../hooks/useI18n';

const SOURCE_META: Record<AgentSource, { label: string; icon: React.ReactNode; badge: string }> = {
  builtin: {
    label: 'Builtin',
    icon: <Hammer className="w-3 h-3 text-zinc-400" />,
    badge: 'bg-zinc-700/50 text-zinc-300',
  },
  user: {
    label: 'Custom · user',
    icon: <User className="w-3 h-3 text-emerald-400" />,
    badge: 'bg-emerald-500/15 text-emerald-300',
  },
  project: {
    label: 'Custom · project',
    icon: <FolderTree className="w-3 h-3 text-sky-400" />,
    badge: 'bg-sky-500/15 text-sky-300',
  },
};

interface GroupedAgents {
  builtin: AgentListEntry[];
  user: AgentListEntry[];
  project: AgentListEntry[];
}

function groupBySource(entries: AgentListEntry[]): GroupedAgents {
  const out: GroupedAgents = { builtin: [], user: [], project: [] };
  // 面板收敛：系统型内置不进选择面板；roles 单独分组（见 roles 渲染段）
  for (const entry of entries) {
    if (!isPanelVisibleAgent(entry) || entry.isRole) continue;
    out[entry.source].push(entry);
  }
  return out;
}

export function AgentSwitcher() {
  const { t } = useI18n();
  const entries = useAgentRegistryStore((s) => s.entries);
  const isLoaded = useAgentRegistryStore((s) => s.isLoaded);
  const refresh = useAgentRegistryStore((s) => s.refresh);
  const activeAgentId = useAppStore((s) => s.activeAgentId);
  const setActiveAgentId = useAppStore((s) => s.setActiveAgentId);

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number } | null>(null);

  // 首次挂载若 store 未加载，主动 refresh（典型场景：StatusBar 比 App init 更先渲染）
  useEffect(() => {
    if (!isLoaded) {
      refresh().catch(() => { /* store 已记录错误 */ });
    }
  }, [isLoaded, refresh]);

  // 打开时自动聚焦搜索框
  useEffect(() => {
    if (open) {
      setSearch('');
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [open]);

  // 计算 portal 菜单位置（fixed）
  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    const updatePos = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setMenuPos({
        left: rect.left,
        bottom: window.innerHeight - rect.top + 4,
      });
    };
    updatePos();
    window.addEventListener('resize', updatePos);
    window.addEventListener('scroll', updatePos, true);
    return () => {
      window.removeEventListener('resize', updatePos);
      window.removeEventListener('scroll', updatePos, true);
    };
  }, [open]);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // 过滤
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) =>
        e.id.toLowerCase().includes(q) ||
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q),
    );
  }, [entries, search]);

  const grouped = useMemo(() => groupBySource(filtered), [filtered]);
  const roleEntries = useMemo(
    () => filtered.filter((e) => e.isRole && isPanelVisibleAgent(e)),
    [filtered],
  );

  // 显示标签：activeAgentId 命中的 entry 名字；否则显示 'Agent' 占位
  const activeEntry = useMemo(
    () => entries.find((e) => e.id === activeAgentId) ?? null,
    [entries, activeAgentId],
  );
  const displayLabel = activeEntry?.name ?? activeEntry?.id ?? 'Agent';
  const isOverridden = !!activeAgentId;

  const handleSelect = (entry: AgentListEntry) => {
    setActiveAgentId(entry.id);
    setOpen(false);
  };
  const handleClear = () => {
    setActiveAgentId(null);
    setOpen(false);
  };

  const renderGroup = (source: AgentSource, items: AgentListEntry[]) => {
    if (items.length === 0) return null;
    const meta = SOURCE_META[source];
    return (
      <div key={source} className="border-b border-zinc-700/40 last:border-b-0">
        <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] uppercase text-zinc-500">
          {meta.icon}
          <span>{meta.label}</span>
          <span className="text-zinc-600">({items.length})</span>
        </div>
        {items.map((entry) => {
          const isActive = entry.id === activeAgentId;
          return (
            <button
              key={`${source}/${entry.id}`}
              onClick={() => handleSelect(entry)}
              className={`
                w-full text-left px-3 py-1.5 text-xs
                hover:bg-zinc-700 transition-colors
                ${isActive ? 'text-amber-300 bg-zinc-700/50' : 'text-gray-300'}
              `}
              title={entry.description}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium truncate">{entry.name || entry.id}</span>
                <span className={`text-[9px] px-1 py-0.5 rounded ${meta.badge}`}>
                  {source === 'builtin' ? 'BI' : source === 'user' ? 'U' : 'P'}
                </span>
              </div>
              {entry.description && (
                <div className="text-[10px] text-zinc-500 truncate">{entry.description}</div>
              )}
            </button>
          );
        })}
      </div>
    );
  };

  const menu =
    open && menuPos ? (
      <div
        ref={menuRef}
        className="
          w-72 py-1
          bg-zinc-800 border border-zinc-700 rounded-lg
          shadow-xl
        "
        style={{
          position: 'fixed',
          left: menuPos.left,
          bottom: menuPos.bottom,
          zIndex: 9999,
        }}
      >
        <div className="px-2 py-1.5 border-b border-zinc-700/50">
          <input
            ref={searchInputRef}
            type="text"
            value={search}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
            placeholder="搜索 agent..."
            className="
              w-full px-2 py-1 text-xs
              bg-zinc-900 border border-zinc-700 rounded
              text-gray-200 placeholder-gray-500
              outline-hidden focus:border-amber-500
            "
          />
        </div>
        <div className="max-h-72 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-xs text-zinc-500 text-center">无匹配 agent</div>
          ) : (
            <>
              {renderGroup('builtin', grouped.builtin)}
              {renderGroup('user', grouped.user)}
              {renderGroup('project', grouped.project)}
              {roleEntries.length > 0 && (
                <div className="border-b border-zinc-700/40 last:border-b-0">
                  <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] uppercase text-zinc-500">
                    <Bot className="w-3 h-3 text-violet-400" />
                    <span>{t.agentCommand.roleGroupLabel}</span>
                    <span className="text-zinc-600">({roleEntries.length})</span>
                  </div>
                  {roleEntries.map((entry) => {
                    const isActive = entry.id === activeAgentId;
                    return (
                      <button
                        key={`role/${entry.id}`}
                        onClick={() => handleSelect(entry)}
                        className={`
                          w-full text-left px-3 py-1.5 text-xs
                          hover:bg-zinc-700 transition-colors
                          ${isActive ? 'text-amber-300 bg-zinc-700/50' : 'text-gray-300'}
                        `}
                        title={entry.description}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium truncate">{entry.name || entry.id}</span>
                          <span className="text-[9px] px-1 py-0.5 rounded bg-violet-500/15 text-violet-300">R</span>
                        </div>
                        {entry.description && (
                          <div className="text-[10px] text-zinc-500 truncate">{entry.description}</div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
        {isOverridden && (
          <>
            <div className="border-t border-zinc-700 my-1" />
            <button
              onClick={handleClear}
              className="w-full text-left px-3 py-1.5 text-xs text-gray-500 hover:text-gray-300 hover:bg-zinc-700"
            >
              恢复默认 agent
            </button>
          </>
        )}
      </div>
    ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen((v: boolean) => !v)}
        aria-label="切换 agent"
        aria-expanded={open}
        className={`
          inline-flex items-center gap-1
          font-medium cursor-pointer truncate max-w-[180px]
          hover:text-white transition-colors
          ${isOverridden ? 'text-amber-400' : 'text-zinc-100'}
        `}
        title={
          activeEntry
            ? `已选 agent: ${activeEntry.id} (source=${activeEntry.source})`
            : '当前未指定 agent（spawn 时使用默认）'
        }
      >
        <Bot className="w-3 h-3" />
        <span className="truncate">{displayLabel}</span>
        {isOverridden && <span className="text-[9px] ml-0.5">*</span>}
      </button>
      {menu && createPortal(menu, document.body)}
    </>
  );
}
