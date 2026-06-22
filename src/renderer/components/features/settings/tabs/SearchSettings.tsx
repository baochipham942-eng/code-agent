// ============================================================================
// SearchSettings - 搜索源配置（多源启停 + 优先级）— ADR-026
// 复用 SETTINGS 域现有 IPC：get（读 AppSettings.search）/ getAllServiceKeys（判 key 状态）
// / set（保存）。源元数据取自 shared SEARCH_SOURCE_CATALOG，与 main SEARCH_SOURCES 同 id。
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import { ChevronUp, ChevronDown, Search } from 'lucide-react';
import type { AppSettings } from '@shared/contract';
import { SEARCH_SOURCE_CATALOG, type SearchSourceCatalogEntry } from '@shared/constants';
import { SettingsPage, SettingsSection } from '../SettingsLayout';
import { invokeDomain } from '../../../../services/ipcService';
import { IPC_DOMAINS } from '@shared/ipc';
import { toast } from '../../../../hooks/useToast';

type ServiceKeyMap = Partial<Record<string, string>>;

/** 按 sourceOrder（若有）排序 catalog，未列出的随后按 defaultPriority。 */
function orderCatalog(order?: string[]): SearchSourceCatalogEntry[] {
  const base = [...SEARCH_SOURCE_CATALOG].sort((a, b) => a.defaultPriority - b.defaultPriority);
  if (!order || order.length === 0) return base;
  const rank = new Map(order.map((id, index) => [id, index]));
  return base.sort((a, b) => {
    const ra = rank.has(a.id) ? (rank.get(a.id) as number) : Number.POSITIVE_INFINITY;
    const rb = rank.has(b.id) ? (rank.get(b.id) as number) : Number.POSITIVE_INFINITY;
    if (ra !== rb) return ra - rb;
    return a.defaultPriority - b.defaultPriority;
  });
}

export function SearchSettings() {
  const [orderedIds, setOrderedIds] = useState<string[]>(() => orderCatalog().map((s) => s.id));
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  const [serviceKeys, setServiceKeys] = useState<ServiceKeyMap>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get'),
      invokeDomain<ServiceKeyMap>(IPC_DOMAINS.SETTINGS, 'getAllServiceKeys'),
    ])
      .then(([settings, keys]) => {
        if (cancelled) return;
        const prefs = settings?.search;
        setOrderedIds(orderCatalog(prefs?.sourceOrder).map((s) => s.id));
        setDisabled(new Set(prefs?.disabledSources ?? []));
        setServiceKeys(keys ?? {});
      })
      .catch(() => {
        if (!cancelled) toast.error('加载搜索源配置失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const catalogById = useMemo(() => {
    const map = new Map<string, SearchSourceCatalogEntry>();
    for (const entry of SEARCH_SOURCE_CATALOG) map.set(entry.id, entry);
    return map;
  }, []);

  const move = (index: number, delta: number) => {
    setOrderedIds((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const toggle = (id: string) => {
    setDisabled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const search: NonNullable<AppSettings['search']> = {
        disabledSources: Array.from(disabled),
        sourceOrder: orderedIds,
      };
      await invokeDomain(IPC_DOMAINS.SETTINGS, 'set', { settings: { search } });
      toast.success('搜索源配置已保存');
    } catch (error) {
      toast.error(`保存失败: ${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="text-xs text-zinc-500">加载中…</div>;
  }

  const keyStatus = (entry: SearchSourceCatalogEntry): { label: string; tone: string } => {
    if (!entry.requiresKey) return { label: '内置免费', tone: 'text-emerald-300' };
    const hasKey = entry.serviceKey ? Boolean(serviceKeys[entry.serviceKey]) : false;
    return hasKey
      ? { label: '已配 Key', tone: 'text-emerald-300' }
      : { label: '需配 Key', tone: 'text-amber-300' };
  };

  return (
    <SettingsPage
      title="搜索"
      description="管理联网搜索使用哪些源、以及它们的优先级。禁用的源不会被调用；越靠上越优先。未做任何更改时按内置智能路由工作。"
    >
      <SettingsSection
        title="搜索源"
        description="付费源需在「权限与安全 / Service API Keys」配置对应 API Key 后才会真正生效（标注「需配 Key」的当前无 key，启用也会被自动跳过）。"
      >
        <div className="flex flex-col gap-2">
          {orderedIds.map((id, index) => {
            const entry = catalogById.get(id);
            if (!entry) return null;
            const status = keyStatus(entry);
            const isEnabled = !disabled.has(id);
            return (
              <div
                key={id}
                className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
                  isEnabled ? 'border-zinc-700 bg-zinc-900/60' : 'border-zinc-800 bg-zinc-950/40 opacity-60'
                }`}
              >
                <div className="flex flex-col">
                  <button
                    type="button"
                    aria-label="上移"
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    className="text-zinc-500 transition-colors hover:text-zinc-200 disabled:opacity-30"
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="下移"
                    onClick={() => move(index, 1)}
                    disabled={index === orderedIds.length - 1}
                    className="text-zinc-500 transition-colors hover:text-zinc-200 disabled:opacity-30"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                </div>

                <span className="w-5 text-center text-xs font-medium text-zinc-500">{index + 1}</span>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-100">{entry.label}</span>
                    {entry.kind === 'premium' && (
                      <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400">付费</span>
                    )}
                    <span className={`text-[11px] ${status.tone}`}>{status.label}</span>
                  </div>
                  <div className="mt-0.5 truncate text-xs text-zinc-500" title={entry.description}>
                    {entry.description}
                  </div>
                </div>

                <label className="flex shrink-0 items-center gap-2 text-xs text-zinc-300">
                  <input type="checkbox" checked={isEnabled} onChange={() => toggle(id)} />
                  启用
                </label>
              </div>
            );
          })}
        </div>
      </SettingsSection>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-md border border-sky-500/30 bg-sky-500/10 px-3 py-1.5 text-xs text-sky-100 transition-colors hover:bg-sky-500/20 disabled:opacity-50"
        >
          <Search className="h-3.5 w-3.5" />
          {saving ? '保存中…' : '保存'}
        </button>
        <span className="text-xs text-zinc-500">保存后立即对后续联网搜索生效。</span>
      </div>
    </SettingsPage>
  );
}
