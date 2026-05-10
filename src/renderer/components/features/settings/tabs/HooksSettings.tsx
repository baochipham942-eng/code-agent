// ============================================================================
// HooksSettings - 当前已注册的 Hook + 未启用的 Event + 配置文件入口
// ============================================================================

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Plug, FolderOpen, FileText, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import { createLogger } from '../../../../utils/logger';

const logger = createLogger('HooksSettings');

interface HookListItem {
  event: string;
  description: string;
  matcher: string | null;
  type: 'command' | 'prompt' | 'agent' | 'http';
  hint: string;
  sources: Array<'global' | 'project'>;
  hookType: 'decision' | 'observer';
  parallel: boolean;
}

interface HookSummary {
  enabled: HookListItem[];
  unused: Array<{ event: string; description: string }>;
  configPaths: { global: string; project: string | null };
}

async function invokeHook<T>(action: string, payload?: unknown): Promise<T> {
  const response = await window.domainAPI?.invoke<T>(IPC_DOMAINS.HOOK, action, payload);
  if (!response?.success) {
    throw new Error(response?.error?.message || `Hook action failed: ${action}`);
  }
  return response.data as T;
}

const HOOK_TYPE_BADGE: Record<HookListItem['type'], { label: string; color: string }> = {
  command: { label: '命令', color: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  prompt: { label: 'Prompt', color: 'bg-violet-500/15 text-violet-300 border-violet-500/30' },
  agent: { label: 'Agent', color: 'bg-blue-500/15 text-blue-300 border-blue-500/30' },
  http: { label: 'HTTP', color: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
};

export const HooksSettings: React.FC = () => {
  const [summary, setSummary] = useState<HookSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showUnused, setShowUnused] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await invokeHook<HookSummary>('list');
      setSummary(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      logger.error('Failed to load hooks', { err: e });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 启用的按 event 分组
  const enabledByEvent = useMemo(() => {
    if (!summary) return [];
    const map = new Map<string, HookListItem[]>();
    for (const item of summary.enabled) {
      const arr = map.get(item.event) ?? [];
      arr.push(item);
      map.set(item.event, arr);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [summary]);

  const handleOpenConfig = useCallback(async (filePath: string) => {
    try {
      await invokeHook<{ opened: string }>('openConfigFile', { filePath });
    } catch (e) {
      logger.error('Failed to open config', { err: e });
    }
  }, []);

  const handleReveal = useCallback(async (filePath: string) => {
    try {
      await invokeHook<{ revealed: string }>('revealConfigFolder', { filePath });
    } catch (e) {
      logger.error('Failed to reveal config', { err: e });
    }
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-zinc-200 flex items-center gap-2">
            <Plug className="w-4 h-4 text-amber-400" />
            Hook
          </h3>
          <p className="text-xs text-zinc-500 mt-1">
            Hook 在对话生命周期事件触发时执行命令、Prompt 或 Agent，可用来做权限拦截、日志、自动化。
            写在 <code className="text-zinc-400">~/.code-agent/hooks/hooks.json</code>，保存后下次会话生效。
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-zinc-300 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 transition-colors flex-shrink-0"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </button>
      </div>

      {/* 配置文件入口 */}
      {summary && (
        <div className="rounded-lg border border-zinc-800 divide-y divide-zinc-800">
          <ConfigPathRow
            label="全局配置"
            path={summary.configPaths.global}
            onOpen={() => handleOpenConfig(summary.configPaths.global)}
            onReveal={() => handleReveal(summary.configPaths.global)}
          />
          {summary.configPaths.project && (
            <ConfigPathRow
              label="项目配置"
              path={summary.configPaths.project}
              onOpen={() => handleOpenConfig(summary.configPaths.project!)}
              onReveal={() => handleReveal(summary.configPaths.project!)}
            />
          )}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          加载失败：{error}
        </div>
      )}

      {/* 已启用 Hook */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium text-zinc-300">
            已启用 <span className="text-zinc-500 font-normal">({summary?.enabled.length ?? 0})</span>
          </h4>
        </div>
        {!loading && summary?.enabled.length === 0 ? (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-6 text-center text-xs text-zinc-500">
            没有任何 Hook 注册。点击上方"打开"按钮新建配置。
          </div>
        ) : (
          <div className="space-y-3">
            {enabledByEvent.map(([event, items]) => (
              <div key={event} className="rounded-lg border border-zinc-800 overflow-hidden">
                <div className="px-3 py-2 bg-zinc-900/60 border-b border-zinc-800 flex items-center justify-between">
                  <span className="text-sm font-mono text-zinc-200">{event}</span>
                  <span className="text-[11px] text-zinc-500">{items[0]?.description}</span>
                </div>
                <div className="divide-y divide-zinc-800">
                  {items.map((item, idx) => (
                    <HookRow key={`${event}-${idx}`} item={item} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 未启用 Event */}
      {summary && summary.unused.length > 0 && (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setShowUnused((v) => !v)}
            className="flex items-center gap-1.5 text-sm font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            {showUnused ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            未启用 <span className="text-zinc-500 font-normal">({summary.unused.length})</span>
          </button>
          {showUnused && (
            <div className="rounded-lg border border-zinc-800 divide-y divide-zinc-800">
              {summary.unused.map((u) => (
                <div key={u.event} className="px-3 py-2 flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-mono text-zinc-300">{u.event}</div>
                    <div className="text-[11px] text-zinc-500 mt-0.5 truncate" title={u.description}>{u.description}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const ConfigPathRow: React.FC<{
  label: string;
  path: string;
  onOpen: () => void;
  onReveal: () => void;
}> = ({ label, path, onOpen, onReveal }) => (
  <div className="flex items-center gap-3 px-3 py-2.5">
    <span className="text-xs text-zinc-500 w-16 flex-shrink-0">{label}</span>
    <code className="flex-1 min-w-0 truncate text-xs text-zinc-300 font-mono" title={path}>
      {path}
    </code>
    <div className="flex items-center gap-1 flex-shrink-0">
      <button
        type="button"
        onClick={onOpen}
        className="flex items-center gap-1 px-2 py-1 rounded text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
        title="用默认编辑器打开（不存在则创建空模板）"
      >
        <FileText className="w-3.5 h-3.5" />
        打开
      </button>
      <button
        type="button"
        onClick={onReveal}
        className="flex items-center gap-1 px-2 py-1 rounded text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
        title="在 Finder 中显示"
      >
        <FolderOpen className="w-3.5 h-3.5" />
        定位
      </button>
    </div>
  </div>
);

const HookRow: React.FC<{ item: HookListItem }> = ({ item }) => {
  const badge = HOOK_TYPE_BADGE[item.type];
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center gap-2 mb-1">
        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${badge.color}`}>
          {badge.label}
        </span>
        {item.matcher && (
          <code className="text-[11px] text-zinc-400 font-mono px-1.5 py-0.5 bg-zinc-800/60 rounded">
            {item.matcher}
          </code>
        )}
        <span className="text-[10px] text-zinc-500">
          {item.hookType === 'observer' ? 'observer' : 'decision'}
          {item.parallel && ' · parallel'}
        </span>
        <span className="text-[10px] text-zinc-500 ml-auto">
          {item.sources.join(' + ')}
        </span>
      </div>
      <div className="text-xs text-zinc-300 font-mono break-all">{item.hint}</div>
    </div>
  );
};
