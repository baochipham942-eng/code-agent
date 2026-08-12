// ============================================================================
// SearchSettings - 搜索源配置（多源启停 + 优先级）— ADR-026
// 复用 SETTINGS 域现有 IPC：get（读 AppSettings.search）/ getAllServiceKeys（判 key 状态）
// / set（保存）。源元数据取自 shared SEARCH_SOURCE_CATALOG，与 main SEARCH_SOURCES 同 id。
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import { ChevronUp, ChevronDown, KeyRound, Search } from 'lucide-react';
import type { AppSettings } from '@shared/contract';
import type { ServiceApiKey } from '@shared/contract/configService';
import { SEARCH_SOURCE_CATALOG, type SearchSourceCatalogEntry } from '@shared/constants';
import { SettingsPage, SettingsSection } from '../SettingsLayout';
import { ConfirmDialog } from '../../../composites/ConfirmDialog';
import { Button } from '../../../primitives';
import { invokeDomain } from '../../../../services/ipcService';
import { IPC_DOMAINS } from '@shared/ipc';
import { toast } from '../../../../hooks/useToast';
import { useI18n } from '../../../../hooks/useI18n';

type ServiceKeyMap = Partial<Record<string, string>>;

/** key 编辑器只依赖 id + serviceKey，catalog 条目与外部搜索源条目都满足这个形状。 */
type KeyEditableEntry = { id: string; serviceKey: ServiceApiKey | null };

/**
 * 外部搜索源（ExternalSearch 工具）的独立搜索凭据条目。
 * 故意不进 SEARCH_SOURCE_CATALOG —— 那张表与 WebSearch 策略路由共用 id，
 * 而智谱/MiniMax 搜索走独立的 ExternalSearchService，不参与 WebSearch 排序/启停。
 */
const EXTERNAL_SEARCH_KEY_ENTRIES: readonly KeyEditableEntry[] = [
  { id: 'zhipu-search', serviceKey: 'zhipu-search' },
  { id: 'minimax-search', serviceKey: 'minimax-search' },
];

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
  const [externalSource, setExternalSource] = useState<'auto' | 'zhipu' | 'minimax'>('auto');
  const [serviceKeys, setServiceKeys] = useState<ServiceKeyMap>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Key 编辑区状态：draft 按源 id 存；editorOpen 只记「已配 Key 但用户点了更换」的卡，
  // 未配 Key 的卡编辑器恒展开，不占用这个集合。
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [editorOpen, setEditorOpen] = useState<Set<string>>(new Set());
  const [keySavingId, setKeySavingId] = useState<string | null>(null);
  const [pendingClear, setPendingClear] = useState<KeyEditableEntry | null>(null);

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
        setExternalSource(prefs?.externalSource ?? 'auto');
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
        externalSource,
      };
      await invokeDomain(IPC_DOMAINS.SETTINGS, 'set', { settings: { search } });
      toast.success(searchText.saveSuccess);
    } catch (error) {
      toast.error(`${searchText.saveFailedPrefix}${error instanceof Error ? error.message : t.settings.general.permissions.unknownError}`);
    } finally {
      setSaving(false);
    }
  };

  /** 与 settings.ipc.ts handleGetAllServiceKeys 同一套打码规则：前 8 位 + `...`。 */
  const maskApiKey = (key: string) => (key.length > 8 ? `${key.substring(0, 8)}...` : key);

  /**
   * 保存/清除某个付费源的 API Key。这条写路径独立于页面底部的「保存」
   * （那个只管启停与排序），成功后就地翻转 key 状态，不整页 reload。
   * 空串 = 清除，需先过 ConfirmDialog。
   */
  const handleSaveKey = async (entry: KeyEditableEntry) => {
    if (!entry.serviceKey) return;
    const service = entry.serviceKey;
    const draft = (keyDrafts[entry.id] ?? '').trim();
    if (!draft) {
      if (serviceKeys[service]) setPendingClear(entry);
      return;
    }
    setKeySavingId(entry.id);
    try {
      await invokeDomain(IPC_DOMAINS.SETTINGS, 'setServiceApiKey', { service, apiKey: draft });
      setServiceKeys((prev) => ({ ...prev, [service]: maskApiKey(draft) }));
      setKeyDrafts((prev) => ({ ...prev, [entry.id]: '' }));
      setEditorOpen((prev) => {
        const next = new Set(prev);
        next.delete(entry.id);
        return next;
      });
      toast.success(searchText.keySaved);
    } catch (error) {
      toast.error(`${searchText.keySaveFailedPrefix}${error instanceof Error ? error.message : t.settings.general.permissions.unknownError}`);
    } finally {
      setKeySavingId(null);
    }
  };

  const handleConfirmClearKey = async () => {
    const entry = pendingClear;
    setPendingClear(null);
    if (!entry?.serviceKey) return;
    const service = entry.serviceKey;
    try {
      await invokeDomain(IPC_DOMAINS.SETTINGS, 'setServiceApiKey', { service, apiKey: '' });
      setServiceKeys((prev) => {
        const next = { ...prev };
        delete next[service];
        return next;
      });
      setKeyDrafts((prev) => ({ ...prev, [entry.id]: '' }));
      toast.success(searchText.keyCleared);
    } catch (error) {
      toast.error(`${searchText.keySaveFailedPrefix}${error instanceof Error ? error.message : t.settings.general.permissions.unknownError}`);
    }
  };

  if (loading) {
    return <div className="text-xs text-zinc-500">{searchText.loading}</div>;
  }

  const keyStatus = (entry: SearchSourceCatalogEntry): { label: string; tone: string } => {
    if (!entry.requiresKey) return { label: searchText.keyStatus.builtinFree, tone: 'text-badge-success' };
    const hasKey = entry.serviceKey ? Boolean(serviceKeys[entry.serviceKey]) : false;
    return hasKey
      ? { label: searchText.keyStatus.configured, tone: 'text-badge-success' }
      : { label: searchText.keyStatus.required, tone: 'text-badge-warning' };
  };
  const sourceTexts = searchText.sources as Record<string, { label: string; description: string } | undefined>;
  const externalSourceTexts = searchText.externalSources as Record<string, { label: string; placeholder: string } | undefined>;

  return (
    <SettingsPage
      title={searchText.title}
      description={searchText.description}
    >
      <SettingsSection
        title={searchText.sourcesSectionTitle}
        description={searchText.sourcesSectionDescription}
      >
        <label className="mb-3 flex items-center gap-3 text-sm text-zinc-200">
          <span className="shrink-0">{searchText.externalSourceLabel}</span>
          <select
            value={externalSource}
            onChange={(event) => setExternalSource(event.target.value as 'auto' | 'zhipu' | 'minimax')}
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
          >
            <option value="auto">{searchText.externalSourceAuto}</option>
            <option value="zhipu">{searchText.externalSourceZhipu}</option>
            <option value="minimax">{searchText.externalSourceMiniMax}</option>
          </select>
        </label>
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
                  {entry.requiresKey && entry.serviceKey && (() => {
                    const service = entry.serviceKey;
                    if (!service) return null;
                    const maskedKey = serviceKeys[service];
                    // 展开规则：未配 Key 恒展开；已配 Key 默认收起成打码值，点「更换」才展开。
                    const showEditor = !maskedKey || editorOpen.has(id);
                    const draft = keyDrafts[id] ?? '';
                    const isSavingKey = keySavingId === id;
                    if (!showEditor) {
                      return (
                        <div className="mt-1.5 flex items-center gap-2 text-xs text-zinc-400">
                          <KeyRound className="h-3.5 w-3.5 text-zinc-500" />
                          <span className="font-mono" data-testid={`search-key-masked-${id}`}>{maskedKey}</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            data-testid={`search-key-change-${id}`}
                            onClick={() => setEditorOpen((prev) => new Set(prev).add(id))}
                          >
                            {searchText.changeKey}
                          </Button>
                        </div>
                      );
                    }
                    return (
                      <div className="mt-1.5 flex items-center gap-2">
                        <input
                          type="password"
                          data-testid={`search-key-input-${id}`}
                          value={draft}
                          onChange={(event) => setKeyDrafts((prev) => ({ ...prev, [id]: event.target.value }))}
                          placeholder={searchText.keyPlaceholder}
                          className="h-7 w-56 rounded border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-badge-info/60"
                        />
                        <Button
                          variant="primary"
                          size="sm"
                          data-testid={`search-key-save-${id}`}
                          onClick={() => handleSaveKey(entry)}
                          disabled={isSavingKey || (!draft.trim() && !maskedKey)}
                        >
                          {isSavingKey ? searchText.saving : searchText.saveKey}
                        </Button>
                      </div>
                    );
                  })()}
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

      <SettingsSection
        title={searchText.externalKeysSectionTitle}
        description={searchText.externalKeysSectionDescription}
      >
        <div className="flex flex-col gap-2">
          {EXTERNAL_SEARCH_KEY_ENTRIES.map((entry) => {
            const service = entry.serviceKey as ServiceApiKey;
            const sourceText = externalSourceTexts[entry.id];
            const maskedKey = serviceKeys[service];
            const hasKey = Boolean(maskedKey);
            // 展开规则与上方搜索源一致：未配 Key 恒展开；已配 Key 收起成打码值，点「更换」才展开。
            const showEditor = !maskedKey || editorOpen.has(entry.id);
            const draft = keyDrafts[entry.id] ?? '';
            const isSavingKey = keySavingId === entry.id;
            return (
              <div
                key={entry.id}
                className="flex items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-900/60 px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-100">{sourceText?.label ?? entry.id}</span>
                    <span className={`text-[11px] ${hasKey ? 'text-badge-success' : 'text-badge-warning'}`}>
                      {hasKey ? searchText.keyStatus.configured : searchText.keyStatus.required}
                    </span>
                  </div>
                  {!showEditor && (
                    <div className="mt-1.5 flex items-center gap-2 text-xs text-zinc-400">
                      <KeyRound className="h-3.5 w-3.5 text-zinc-500" />
                      <span className="font-mono" data-testid={`external-search-key-masked-${entry.id}`}>{maskedKey}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        data-testid={`external-search-key-change-${entry.id}`}
                        onClick={() => setEditorOpen((prev) => new Set(prev).add(entry.id))}
                      >
                        {searchText.changeKey}
                      </Button>
                    </div>
                  )}
                  {showEditor && (
                    <div className="mt-1.5 flex items-center gap-2">
                      <input
                        type="password"
                        data-testid={`external-search-key-input-${entry.id}`}
                        value={draft}
                        onChange={(event) => setKeyDrafts((prev) => ({ ...prev, [entry.id]: event.target.value }))}
                        placeholder={sourceText?.placeholder ?? searchText.keyPlaceholder}
                        className="h-7 w-56 rounded border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-badge-info/60"
                      />
                      <Button
                        variant="primary"
                        size="sm"
                        data-testid={`external-search-key-save-${entry.id}`}
                        onClick={() => handleSaveKey(entry)}
                        disabled={isSavingKey || (!draft.trim() && !maskedKey)}
                      >
                        {isSavingKey ? searchText.saving : searchText.saveKey}
                      </Button>
                    </div>
                  )}
                </div>
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
          className="inline-flex items-center gap-1.5 rounded-md border border-badge-info/30 bg-sky-500/10 px-3 py-1.5 text-xs text-badge-info transition-colors hover:bg-sky-500/20 disabled:opacity-50"
        >
          <Search className="h-3.5 w-3.5" />
          {saving ? searchText.saving : t.common.save}
        </button>
        <span className="text-xs text-zinc-500">{searchText.applyHint}</span>
      </div>

      <ConfirmDialog
        isOpen={pendingClear !== null}
        title={searchText.clearKeyTitle}
        message={searchText.clearKeyMessage}
        variant="danger"
        confirmText={searchText.clearKeyConfirm}
        cancelText={t.common.cancel}
        onConfirm={handleConfirmClearKey}
        onCancel={() => setPendingClear(null)}
      />
    </SettingsPage>
  );
}
