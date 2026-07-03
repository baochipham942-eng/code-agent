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
import { useI18n } from '../../../../hooks/useI18n';

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
  const { t } = useI18n();
  const searchText = t.settings.search;
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
        if (!cancelled) toast.error(searchText.loadFailed);
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
      toast.success(searchText.saveSuccess);
    } catch (error) {
      toast.error(`${searchText.saveFailedPrefix}${error instanceof Error ? error.message : t.settings.general.permissions.unknownError}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="text-xs text-zinc-500">{searchText.loading}</div>;
  }

  const keyStatus = (entry: SearchSourceCatalogEntry): { label: string; tone: string } => {
    if (!entry.requiresKey) return { label: searchText.keyStatus.builtinFree, tone: 'text-emerald-300' };
    const hasKey = entry.serviceKey ? Boolean(serviceKeys[entry.serviceKey]) : false;
    return hasKey
      ? { label: searchText.keyStatus.configured, tone: 'text-emerald-300' }
      : { label: searchText.keyStatus.required, tone: 'text-amber-300' };
  };
  const sourceTexts = searchText.sources as Record<string, { label: string; description: string } | undefined>;

  return (
    <SettingsPage
      title={searchText.title}
      description={searchText.description}
    >
      <SettingsSection
        title={searchText.sourcesSectionTitle}
        description={searchText.sourcesSectionDescription}
      >
        <div className="flex flex-col gap-2">
          {orderedIds.map((id, index) => {
            const entry = catalogById.get(id);
            if (!entry) return null;
            const status = keyStatus(entry);
            const isEnabled = !disabled.has(id);
            const sourceText = sourceTexts[id];
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
                    aria-label={searchText.moveUp}
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    className="text-zinc-500 transition-colors hover:text-zinc-200 disabled:opacity-30"
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={searchText.moveDown}
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
                    <span className="text-sm font-medium text-zinc-100">{sourceText?.label ?? entry.label}</span>
                    {entry.kind === 'premium' && (
                      <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400">{searchText.premiumBadge}</span>
                    )}
                    <span className={`text-[11px] ${status.tone}`}>{status.label}</span>
                  </div>
                  <div className="mt-0.5 truncate text-xs text-zinc-500" title={sourceText?.description ?? entry.description}>
                    {sourceText?.description ?? entry.description}
                  </div>
                </div>

                <label className="flex shrink-0 items-center gap-2 text-xs text-zinc-300">
                  <input type="checkbox" checked={isEnabled} onChange={() => toggle(id)} />
                  {searchText.enabledLabel}
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
          {saving ? searchText.saving : t.common.save}
        </button>
        <span className="text-xs text-zinc-500">{searchText.applyHint}</span>
      </div>
    </SettingsPage>
  );
}
