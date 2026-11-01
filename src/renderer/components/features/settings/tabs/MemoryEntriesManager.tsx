import React, { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  CheckCircle2,
  Database,
  FileText,
  History,
  Loader2,
  MessageSquareText,
  RotateCcw,
  Save,
  Search,
  XCircle,
} from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import { IPC_DOMAINS } from '@shared/ipc/domains';
import type {
  MemoryChangeJournalResult,
  MemoryChangeJournalRow,
  MemoryEntry,
  MemoryEntryBatchReviewResult,
  MemoryEntryKind,
  MemoryEntryListResult,
  MemoryEntrySourceOfTruth,
  MemoryEntryStatus,
  MemoryEntryUpdateRequest,
  MemoryEntryUpdateResult,
} from '@shared/contract/memory';
import { findSourceSessionRef, formatBatchReviewSkippedDetail, visibleCandidateEntryIds } from './MemoryEntriesManager.helpers';
import { Input } from '../../../primitives';
import { ConfirmDialog } from '../../../composites/ConfirmDialog';
import { SettingsSection } from '../SettingsLayout';
import { isWebMode } from '../../../../utils/platform';
import ipcService from '../../../../services/ipcService';
import { useSessionStore } from '../../../../stores/sessionStore';
import { useSessionUIStore } from '../../../../stores/sessionUIStore';
import { useAppStore } from '../../../../stores/appStore';
import { useI18n } from '../../../../hooks/useI18n';
import { localeForLanguage } from '../../../../utils/i18nTime';
import { zh } from '../../../../i18n/zh';

type EntryStatusFilter = MemoryEntryStatus | 'all';
type EntryKindFilter = MemoryEntryKind | 'all';
type EntrySourceFilter = MemoryEntrySourceOfTruth | 'all';
type MemorySettingsText = typeof zh.settings.memory;

type MemoryEntryCommand =
  | { action: 'memoryEntries' }
  | ({ action: 'memoryEntryUpdate' } & MemoryEntryUpdateRequest)
  | { action: 'memoryEntryBatchReview'; entryIds: string[]; decision: 'approve' | 'reject' }
  | { action: 'memoryEntryJournal'; entryId: string; limit?: number }
  | { action: 'memoryEntryResumeInjection'; entryId: string };

interface MemoryEntryCommandResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

interface MemoryEntryDraft {
  title: string;
  summary: string;
  content: string;
  status: MemoryEntryStatus;
  kind: MemoryEntryKind;
  projectPath: string;
}

export interface MemoryEntryManagerRow {
  id: string;
  title: string;
  summary: string;
  statusLabel: string;
  /** 已暂停自动带进对话时的徽标文案（N-MEM-EVICT-NEVER-READ） */
  pausedLabel?: string;
  /** 最近一次变更是后台写入时的徽标文案（N-MEM-JOURNAL-SOURCEJUMP） */
  backgroundWriteLabel?: string;
  kindLabel: string;
  sourceLabel: string;
  updatedAtLabel: string;
  selected: boolean;
}

/** 后台改动的 actor（面板手动编辑以外的一切写入路径；unknown 一并标出，宁可见不可漏） */
function isBackgroundMemoryActor(actor: string): boolean {
  return actor !== 'user_manual';
}

const STATUS_OPTIONS: MemoryEntryStatus[] = ['candidate', 'active', 'rejected', 'stale', 'archived'];
const KIND_OPTIONS: MemoryEntryKind[] = ['directive', 'user', 'feedback', 'project', 'reference', 'session', 'pattern'];

export function getMemoryEntryStatusLabel(
  status: MemoryEntryStatus,
  labels: MemorySettingsText['entries']['statusLabels'] = zh.settings.memory.entries.statusLabels,
): string {
  return labels[status] || status;
}

export function getMemoryEntryKindLabel(
  kind: MemoryEntryKind,
  labels: MemorySettingsText['entries']['kindLabels'] = zh.settings.memory.entries.kindLabels,
): string {
  return labels[kind] || kind;
}

export function getMemoryEntrySourceLabel(
  source: MemoryEntrySourceOfTruth,
  labels: MemorySettingsText['sourceLabels'] = zh.settings.memory.sourceLabels,
): string {
  return labels[source] || source;
}

export function formatMemoryEntryUpdatedAt(
  timestamp: number,
  now = Date.now(),
  labels: MemorySettingsText['relativeDate'] = zh.settings.memory.relativeDate,
  locale: string = localeForLanguage('zh'),
): string {
  const diffDays = Math.floor((now - timestamp) / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return labels.today;
  if (diffDays === 1) return labels.yesterday;
  if (diffDays < 7) return `${diffDays}${labels.daysAgoSuffix}`;
  return new Date(timestamp).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

export function buildMemoryEntryRows({
  entries,
  selectedEntryId,
  searchQuery,
  statusFilter,
  showArchived = false,
  kindFilter,
  sourceFilter,
  now = Date.now(),
  labels = zh.settings.memory,
  locale = localeForLanguage('zh'),
}: {
  entries: MemoryEntry[];
  selectedEntryId: string | null;
  searchQuery: string;
  statusFilter: EntryStatusFilter;
  showArchived?: boolean;
  kindFilter: EntryKindFilter;
  sourceFilter: EntrySourceFilter;
  now?: number;
  labels?: MemorySettingsText;
  locale?: string;
}): MemoryEntryManagerRow[] {
  const query = searchQuery.trim().toLowerCase();
  return entries
    .filter((entry) => showArchived || entry.status !== 'archived')
    .filter((entry) => statusFilter === 'all' || entry.status === statusFilter)
    .filter((entry) => kindFilter === 'all' || entry.kind === kindFilter)
    .filter((entry) => sourceFilter === 'all' || entry.source.sourceOfTruth === sourceFilter)
    .filter((entry) => {
      if (!query) return true;
      return entry.id.toLowerCase().includes(query)
        || entry.title.toLowerCase().includes(query)
        || entry.summary.toLowerCase().includes(query)
        || entry.content.toLowerCase().includes(query);
    })
    .map((entry) => ({
      id: entry.id,
      title: entry.title,
      summary: entry.summary,
      statusLabel: getMemoryEntryStatusLabel(entry.status, labels.entries.statusLabels),
      ...(entry.injectionPaused ? { pausedLabel: labels.entries.injectionPaused.badge } : {}),
      ...(entry.lastChange && isBackgroundMemoryActor(entry.lastChange.actor)
        ? { backgroundWriteLabel: labels.entries.backgroundWriteBadge }
        : {}),
      kindLabel: getMemoryEntryKindLabel(entry.kind, labels.entries.kindLabels),
      sourceLabel: getMemoryEntrySourceLabel(entry.source.sourceOfTruth, labels.sourceLabels),
      updatedAtLabel: formatMemoryEntryUpdatedAt(entry.updatedAt, now, labels.relativeDate, locale),
      selected: entry.id === selectedEntryId,
    }));
}

function isCommandResponse<T>(value: unknown): value is MemoryEntryCommandResponse<T> {
  return Boolean(value && typeof value === 'object' && 'success' in value);
}

async function invokeMemoryEntryCommand<T>(request: MemoryEntryCommand): Promise<MemoryEntryCommandResponse<T>> {
  const commandResult = ipcService.isAvailable()
    ? await ipcService.invoke(IPC_CHANNELS.MEMORY, request) as unknown
    : undefined;
  if (commandResult !== undefined) {
    if (!isCommandResponse<T>(commandResult)) {
      return { success: true, data: commandResult as T };
    }
    if (commandResult.success || !isWebMode()) return commandResult;
  }

  try {
    const data = await ipcService.invokeDomain<T>(IPC_DOMAINS.MEMORY, request.action, request);
    return { success: true, data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function createDraft(entry: MemoryEntry): MemoryEntryDraft {
  return {
    title: entry.title,
    summary: entry.summary,
    content: entry.content,
    status: entry.status,
    kind: entry.kind,
    projectPath: entry.projectPath || '',
  };
}

export const MemoryEntriesManager: React.FC<{ onChanged?: () => void | Promise<void> }> = ({ onChanged }) => {
  const { t, language } = useI18n();
  const memoryText = t.settings.memory;
  const [result, setResult] = useState<MemoryEntryListResult | null>(null);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [draft, setDraft] = useState<MemoryEntryDraft | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<EntryStatusFilter>('all');
  const [showArchived, setShowArchived] = useState(false);
  const [kindFilter, setKindFilter] = useState<EntryKindFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<EntrySourceFilter>('all');
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<Set<string>>(new Set());
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [busy, setBusy] = useState<'load' | 'save' | 'batch' | null>('load');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // N-MEM-JOURNAL-SOURCEJUMP：变更历史 + 来源会话跳转
  const [journalRows, setJournalRows] = useState<MemoryChangeJournalRow[] | null>(null);
  const [journalFailed, setJournalFailed] = useState(false);
  const [sourceSessionProbe, setSourceSessionProbe] = useState<'exists' | 'missing' | 'probe-failed' | 'checking' | null>(null);
  const [openingSourceSession, setOpeningSourceSession] = useState(false);

  const entries = result?.entries ?? [];
  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.id === selectedEntryId) ?? null,
    [entries, selectedEntryId],
  );
  const rows = useMemo(
    () => buildMemoryEntryRows({
      entries,
      selectedEntryId: selectedEntry?.id ?? null,
      searchQuery,
      statusFilter,
      showArchived,
      kindFilter,
      sourceFilter,
      labels: memoryText,
      locale: localeForLanguage(language),
    }),
    [entries, kindFilter, language, memoryText, searchQuery, selectedEntry?.id, showArchived, sourceFilter, statusFilter],
  );
  const visibleCandidateIds = useMemo(() => {
    return visibleCandidateEntryIds(entries, rows);
  }, [entries, rows]);

  const loadEntries = async () => {
    setBusy((current) => current || 'load');
    const response = await invokeMemoryEntryCommand<MemoryEntryListResult>({ action: 'memoryEntries' });
    if (response.success && response.data) {
      setResult(response.data);
      setSelectedCandidateIds((current) => new Set(
        Array.from(current).filter((id) => response.data?.entries.some((entry) => entry.id === id && entry.status === 'candidate')),
      ));
      setSelectedEntryId((current) => {
        if (current && response.data?.entries.some((entry) => entry.id === current)) return current;
        return response.data?.entries.find((entry) => entry.status !== 'archived')?.id ?? null;
      });
    } else {
      setMessage({ type: 'error', text: response.error || memoryText.entries.loadFailed });
    }
    setBusy((current) => (current === 'load' ? null : current));
  };

  const reviewCandidates = async (decision: 'approve' | 'reject') => {
    const entryIds = Array.from(selectedCandidateIds);
    if (entryIds.length === 0) return;
    setBusy('batch');
    const response = await invokeMemoryEntryCommand<MemoryEntryBatchReviewResult>({
      action: 'memoryEntryBatchReview',
      entryIds,
      decision,
    });
    if (response.success && response.data) {
      const skippedItems = response.data.skipped;
      let text = memoryText.entries.batchReview.result
        .replace('{updated}', String(response.data.updated.length))
        .replace('{skipped}', String(skippedItems.length));
      if (skippedItems.length > 0) {
        text += memoryText.entries.batchReview.skippedDetailPrefix
          + formatBatchReviewSkippedDetail(skippedItems, entries, memoryText.entries.batchReview);
      }
      setMessage({
        type: skippedItems.length ? 'error' : 'success',
        text,
      });
      setSelectedCandidateIds(new Set());
      await loadEntries();
      await onChanged?.();
    } else {
      setMessage({ type: 'error', text: response.error || memoryText.entries.batchReview.failed });
    }
    setBusy(null);
  };

  useEffect(() => { loadEntries(); }, []);

  useEffect(() => {
    setDraft(selectedEntry ? createDraft(selectedEntry) : null);
  }, [selectedEntry?.id]);

  // 来源会话/落点消息解析收口到 helper：evidence[].sessionId 落库时被敏感 guard redact，
  // 匹配不能依赖它（r3），口径见 findSourceSessionRef。
  const { sessionId: sourceSessionId, messageId: sourceMessageId } = findSourceSessionRef(selectedEntry);

  // 变更历史随选中条目加载（N-MEM-JOURNAL-SOURCEJUMP ③）
  useEffect(() => {
    let cancelled = false;
    setJournalRows(null);
    setJournalFailed(false);
    if (!selectedEntry) return;
    invokeMemoryEntryCommand<MemoryChangeJournalResult>({ action: 'memoryEntryJournal', entryId: selectedEntry.id })
      .then((response) => {
        if (cancelled) return;
        if (response.success && response.data) setJournalRows(response.data.rows);
        else setJournalFailed(true);
      })
      .catch(() => { if (!cancelled) setJournalFailed(true); });
    return () => { cancelled = true; };
  }, [selectedEntry?.id]);

  // 来源会话存在性探测：在就给跳转按钮，不在就禁用并给原因（②）。
  // 走只读 sessionExists——session.load 会 restoreSession（切宿主 currentSessionId/
  // toolCache、清会话缓存、写审计），选中条目只是探测，不能付这些副作用（r4）。
  useEffect(() => {
    let cancelled = false;
    setSourceSessionProbe(sourceSessionId ? 'checking' : null);
    if (!sourceSessionId) return;
    ipcService.invokeDomain<boolean>(IPC_DOMAINS.SESSION, 'sessionExists', { sessionId: sourceSessionId })
      .then((exists) => { if (!cancelled) setSourceSessionProbe(exists === true ? 'exists' : 'missing'); })
      .catch(() => { if (!cancelled) setSourceSessionProbe('probe-failed'); });
    return () => { cancelled = true; };
  }, [sourceSessionId]);

  const openSourceSession = async () => {
    if (!sourceSessionId || sourceSessionProbe !== 'exists' || openingSourceSession) return;
    setOpeningSourceSession(true);
    try {
      // 设置是 overlay：secondaryPages 的排除清单明确不含 showSettings，switchSession
      // 的 closeSecondaryPages 关不掉它——不先关设置，跳转后用户仍被设置页盖住看不见
      // 落点。走 setShowSettings(false)（inviteExpert / startCreateRoleChat 等设置内
      // 跳聊天同款；不用 closeSettings，它带 cronCenter 返回落点时会改开自动化页）。
      useAppStore.getState().setShowSettings(false);
      // 有 messageId 就落点消息（沿用聊天搜索的 pendingSearchJump 机制），否则会话顶部
      useSessionUIStore.getState().setPendingSearchJump({
        sessionId: sourceSessionId,
        ...(sourceMessageId ? { messageId: sourceMessageId } : {}),
        query: '',
        createdAt: Date.now(),
      });
      await useSessionStore.getState().switchSession(sourceSessionId);
    } finally {
      setOpeningSourceSession(false);
    }
  };

  const resumeInjection = async () => {
    if (!selectedEntry) return;
    setBusy('save');
    const response = await invokeMemoryEntryCommand<{ resumed: boolean }>({
      action: 'memoryEntryResumeInjection',
      entryId: selectedEntry.id,
    });
    if (response.success && response.data?.resumed) {
      setMessage({ type: 'success', text: memoryText.entries.injectionPaused.resumeSuccess });
      await loadEntries();
      await onChanged?.();
    } else {
      setMessage({ type: 'error', text: response.error || memoryText.entries.injectionPaused.resumeFailed });
    }
    setBusy(null);
  };

  const saveDraft = async (patch: Partial<MemoryEntryDraft> = {}) => {
    if (!selectedEntry || !draft) return;
    setBusy('save');
    const next = { ...draft, ...patch };
    const response = await invokeMemoryEntryCommand<MemoryEntryUpdateResult>({
      action: 'memoryEntryUpdate',
      entryId: selectedEntry.id,
      title: next.title,
      summary: next.summary,
      content: next.content,
      status: next.status,
      kind: next.kind,
      projectPath: next.projectPath || null,
    });
    if (response.success && response.data) {
      setMessage({ type: 'success', text: memoryText.entries.updateSuccess });
      if (next.status === 'archived') setShowArchived(true);
      await loadEntries();
      await onChanged?.();
    } else {
      setMessage({ type: 'error', text: response.error || memoryText.entries.updateFailed });
    }
    setBusy(null);
  };

  return (
    <SettingsSection
      title={memoryText.entries.sectionTitle}
      description={memoryText.entries.description}
    >
      <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60">
        <div className="grid grid-cols-2 gap-px border-b border-zinc-700/60 bg-zinc-800/80 lg:grid-cols-4">
          {[
            [memoryText.entries.stats.total, String(entries.length), `${result?.sourceCounts.light_file ?? 0} Light / ${result?.sourceCounts.db_memory ?? 0} DB`],
            [memoryText.entries.stats.currentMatched, String(rows.length), memoryText.entries.stats.filteredCaption],
            [memoryText.entries.stats.active, String(entries.filter((entry) => entry.status === 'active').length), memoryText.entries.stats.activeCaption],
            [memoryText.entries.stats.governance, String(entries.filter((entry) => entry.status === 'candidate' || entry.status === 'stale').length), memoryText.entries.stats.governanceCaption],
          ].map(([label, value, caption]) => (
            <div key={label} className="bg-zinc-900/80 px-3 py-3">
              <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-zinc-500">{label}</div>
              <div className="mt-1 truncate text-lg font-semibold text-zinc-100">{value}</div>
              <div className="mt-0.5 truncate text-[11px] text-zinc-500">{caption}</div>
            </div>
          ))}
        </div>

        {message && (
          <div className={`border-b px-3 py-2 text-xs ${
            message.type === 'success'
              ? 'border-badge-success/20 bg-emerald-500/10 text-badge-success'
              : 'border-red-500/20 bg-red-500/10 text-badge-danger'
          }`}
          >
            {message.text}
          </div>
        )}

        <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="min-w-0 border-b border-zinc-800 lg:border-b-0 lg:border-r">
            <div className="grid gap-2 border-b border-zinc-800 px-3 py-3 lg:grid-cols-[minmax(0,1fr)_120px_120px_120px_auto]">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                <Input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={memoryText.entries.searchPlaceholder}
                  className="pl-9"
                  data-testid="memory-entry-search-input"
                />
              </div>
              <select
                value={statusFilter}
                onChange={(event) => {
                  const nextStatus = event.target.value as EntryStatusFilter;
                  setStatusFilter(nextStatus);
                  if (nextStatus === 'archived') setShowArchived(true);
                }}
                className="rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-zinc-300"
              >
                <option value="all">{memoryText.entries.filters.allStatus}</option>
                {STATUS_OPTIONS.map((status) => (
                  <option key={status} value={status}>{getMemoryEntryStatusLabel(status, memoryText.entries.statusLabels)}</option>
                ))}
              </select>
              <label className="inline-flex items-center gap-2 whitespace-nowrap rounded border border-zinc-700 px-2 py-2 text-xs text-zinc-300">
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setShowArchived(checked);
                    if (!checked && selectedEntry?.status === 'archived') {
                      setSelectedEntryId(entries.find((entry) => entry.status !== 'archived')?.id ?? null);
                    }
                  }}
                  data-testid="memory-entry-show-archived"
                />
                {memoryText.entries.filters.showArchived}
              </label>
              <select
                value={kindFilter}
                onChange={(event) => setKindFilter(event.target.value as EntryKindFilter)}
                className="rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-zinc-300"
              >
                <option value="all">{memoryText.entries.filters.allKind}</option>
                {KIND_OPTIONS.map((kind) => (
                  <option key={kind} value={kind}>{getMemoryEntryKindLabel(kind, memoryText.entries.kindLabels)}</option>
                ))}
              </select>
              <select
                value={sourceFilter}
                onChange={(event) => setSourceFilter(event.target.value as EntrySourceFilter)}
                className="rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-zinc-300"
              >
                <option value="all">{memoryText.entries.filters.allSource}</option>
                <option value="light_file">{getMemoryEntrySourceLabel('light_file', memoryText.sourceLabels)}</option>
                <option value="db_memory">{getMemoryEntrySourceLabel('db_memory', memoryText.sourceLabels)}</option>
              </select>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2 text-xs">
              <label className="inline-flex items-center gap-2 text-zinc-400">
                <input
                  type="checkbox"
                  checked={visibleCandidateIds.length > 0 && visibleCandidateIds.every((id) => selectedCandidateIds.has(id))}
                  onChange={(event) => {
                    setSelectedCandidateIds((current) => {
                      const next = new Set(current);
                      for (const id of visibleCandidateIds) {
                        if (event.target.checked) next.add(id);
                        else next.delete(id);
                      }
                      return next;
                    });
                  }}
                  data-testid="memory-entry-select-visible-candidates"
                />
                {memoryText.entries.batchReview.selectVisible.replace('{count}', String(visibleCandidateIds.length))}
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy !== null || selectedCandidateIds.size === 0}
                  onClick={() => reviewCandidates('approve')}
                  className="inline-flex items-center gap-1 rounded border border-badge-success/40 bg-emerald-500/10 px-2 py-1 text-badge-success disabled:opacity-50"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {memoryText.entries.batchReview.approve.replace('{count}', String(selectedCandidateIds.size))}
                </button>
                <button
                  type="button"
                  disabled={busy !== null || selectedCandidateIds.size === 0}
                  onClick={() => reviewCandidates('reject')}
                  className="inline-flex items-center gap-1 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-badge-danger disabled:opacity-50"
                >
                  <XCircle className="h-3.5 w-3.5" />
                  {memoryText.entries.batchReview.reject.replace('{count}', String(selectedCandidateIds.size))}
                </button>
              </div>
            </div>

            <div className="max-h-[520px] overflow-auto">
              {busy === 'load' ? (
                <div className="flex h-40 items-center justify-center">
                  <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />
                </div>
              ) : (
                <table className="w-full min-w-[720px] text-left text-xs">
                  <thead className="sticky top-0 border-b border-zinc-800 bg-zinc-950 text-[11px] uppercase tracking-[0.08em] text-zinc-500">
                    <tr>
                      <th className="w-10 px-3 py-2 font-medium" aria-label={memoryText.entries.batchReview.selection} />
                      <th className="px-3 py-2 font-medium">{memoryText.entries.table.entry}</th>
                      <th className="px-3 py-2 font-medium">{memoryText.entries.table.status}</th>
                      <th className="px-3 py-2 font-medium">{memoryText.entries.table.kind}</th>
                      <th className="px-3 py-2 font-medium">{memoryText.entries.table.source}</th>
                      <th className="px-3 py-2 font-medium">{memoryText.entries.table.updated}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800">
                    {rows.map((row) => (
                      <tr
                        key={row.id}
                        data-testid="memory-entry-row"
                        onClick={() => setSelectedEntryId(row.id)}
                        className={`cursor-pointer ${row.selected ? 'bg-indigo-500/10' : 'bg-zinc-900/30 hover:bg-zinc-800/60'}`}
                      >
                        <td className="px-3 py-3 align-top">
                          {(() => {
                            const entry = entries.find((item) => item.id === row.id);
                            if (entry?.status !== 'candidate') return null;
                            if (entry.kind === 'directive') {
                              return (
                                <span
                                  className="inline-flex items-center gap-1 text-[11px] text-zinc-500"
                                  title={memoryText.entries.batchReview.directiveNeedsConfirmation}
                                >
                                  <input
                                    type="checkbox"
                                    disabled
                                    aria-label={memoryText.entries.batchReview.directiveNeedsConfirmation}
                                  />
                                  {memoryText.entries.batchReview.directiveNeedsConfirmation}
                                </span>
                              );
                            }
                            return (
                              <input
                                type="checkbox"
                                checked={selectedCandidateIds.has(row.id)}
                                onClick={(event) => event.stopPropagation()}
                                onChange={(event) => {
                                  setSelectedCandidateIds((current) => {
                                    const next = new Set(current);
                                    if (event.target.checked) next.add(row.id);
                                    else next.delete(row.id);
                                    return next;
                                  });
                                }}
                                aria-label={memoryText.entries.batchReview.selectEntry.replace('{title}', row.title)}
                              />
                            );
                          })()}
                        </td>
                        <td className="px-3 py-3 align-top">
                          <div className="max-w-[340px] truncate text-sm font-medium text-zinc-200">{row.title}</div>
                          <div className="mt-1 max-w-[380px] truncate text-zinc-500">{row.summary || row.id}</div>
                        </td>
                        <td className="px-3 py-3 align-top text-zinc-300">
                          {row.statusLabel}
                          {row.pausedLabel && (
                            <div className="mt-1 text-[11px] text-badge-warning" data-testid="memory-entry-paused-badge">{row.pausedLabel}</div>
                          )}
                          {row.backgroundWriteLabel && (
                            <div className="mt-1 text-[11px] text-badge-info" data-testid="memory-entry-background-badge" title={row.backgroundWriteLabel}>{row.backgroundWriteLabel}</div>
                          )}
                        </td>
                        <td className="px-3 py-3 align-top text-zinc-300">{row.kindLabel}</td>
                        <td className="px-3 py-3 align-top text-zinc-400">{row.sourceLabel}</td>
                        <td className="px-3 py-3 align-top text-zinc-400">{row.updatedAtLabel}</td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-3 py-10 text-center text-zinc-500">
                          {memoryText.entries.noMatches}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <div className="min-w-0 p-3">
            {selectedEntry && draft ? (
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                      {selectedEntry.source.sourceOfTruth === 'light_file' ? (
                        <FileText className="h-4 w-4 text-badge-success" />
                      ) : (
                        <Database className="h-4 w-4 text-badge-info" />
                      )}
                      <span className="truncate">{getMemoryEntrySourceLabel(selectedEntry.source.sourceOfTruth)}</span>
                    </div>
                    <div className="mt-1 truncate font-mono text-[11px] text-zinc-500">{selectedEntry.id}</div>
                  </div>
                  <button
                    type="button"
                    onClick={loadEntries}
                    className="inline-flex items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    {memoryText.entries.refresh}
                  </button>
                </div>

                {selectedEntry.injectionPaused && (
                  <div className="rounded border border-zinc-700 bg-zinc-800/60 px-3 py-2 text-xs text-zinc-300" data-testid="memory-entry-paused-notice">
                    <div>
                      {(selectedEntry.injectionPaused.reason === 'never_used'
                        ? memoryText.entries.injectionPaused.neverUsed
                        : memoryText.entries.injectionPaused.staleUsed
                      ).replace('{date}', new Date(selectedEntry.injectionPaused.since).toLocaleDateString(localeForLanguage(language)))}
                    </div>
                    <button
                      type="button"
                      onClick={resumeInjection}
                      disabled={busy !== null}
                      className="mt-2 inline-flex items-center gap-1 rounded border border-zinc-600 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      {memoryText.entries.injectionPaused.resume}
                    </button>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs text-zinc-500">
                    {memoryText.entries.fields.status}
                    <select
                      value={draft.status}
                      onChange={(event) => setDraft({ ...draft, status: event.target.value as MemoryEntryStatus })}
                      className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-zinc-300"
                    >
                      {STATUS_OPTIONS.map((status) => (
                        <option key={status} value={status}>{getMemoryEntryStatusLabel(status, memoryText.entries.statusLabels)}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-zinc-500">
                    {memoryText.entries.fields.kind}
                    <select
                      value={draft.kind}
                      onChange={(event) => setDraft({ ...draft, kind: event.target.value as MemoryEntryKind })}
                      className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-zinc-300"
                    >
                      {KIND_OPTIONS.map((kind) => (
                        <option key={kind} value={kind}>{getMemoryEntryKindLabel(kind, memoryText.entries.kindLabels)}</option>
                      ))}
                    </select>
                  </label>
                </div>

                <label className="block text-xs text-zinc-500">
                  {memoryText.entries.fields.title}
                  <Input
                    value={draft.title}
                    onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                    className="mt-1"
                  />
                </label>
                {selectedEntry.scope === 'project' && (
                  <label className="block text-xs text-zinc-500">
                    {memoryText.entries.fields.projectPath}
                    <Input
                      value={draft.projectPath}
                      onChange={(event) => setDraft({ ...draft, projectPath: event.target.value })}
                      placeholder={memoryText.entries.fields.projectPathPlaceholder}
                      className="mt-1"
                    />
                  </label>
                )}
                <label className="block text-xs text-zinc-500">
                  {memoryText.entries.fields.summary}
                  <Input
                    value={draft.summary}
                    onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
                    className="mt-1"
                  />
                </label>
                <label className="block text-xs text-zinc-500">
                  {memoryText.entries.fields.content}
                  <textarea
                    value={draft.content}
                    onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                    className="mt-1 h-48 w-full resize-y rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs leading-relaxed text-zinc-300 outline-hidden focus:border-badge-accent/60"
                  />
                </label>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => saveDraft()}
                    disabled={busy !== null}
                    className="inline-flex items-center gap-1.5 rounded border border-badge-success/40 bg-emerald-500/10 px-3 py-1.5 text-xs text-badge-success hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busy === 'save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                    {memoryText.entries.save}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (draft.status === 'archived') {
                        saveDraft({ status: 'active' });
                      } else {
                        setArchiveConfirmOpen(true);
                      }
                    }}
                    disabled={busy !== null}
                    className="inline-flex items-center gap-1.5 rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Archive className="h-3.5 w-3.5" />
                    {draft.status === 'archived' ? memoryText.entries.activate : memoryText.entries.archive}
                  </button>
                </div>

                <div className="rounded border border-zinc-800 bg-zinc-950/40 p-3 text-xs text-zinc-500">
                  <div className="mb-2 font-medium text-zinc-400">{memoryText.entries.evidence}</div>
                  {selectedEntry.evidence.length > 0 ? (
                    <div className="space-y-1">
                      {selectedEntry.evidence.slice(0, 4).map((item, index) => (
                        <div key={`${selectedEntry.id}-evidence-${index}`} className="truncate font-mono text-[11px]">
                          {item.filePath || item.memoryId || item.sessionId || item.candidateId || item.source || 'unknown'}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div>{memoryText.entries.noEvidence}</div>
                  )}
                </div>

                {sourceSessionId && (
                  <div className="rounded border border-zinc-800 bg-zinc-950/40 p-3 text-xs text-zinc-500" data-testid="memory-entry-source-session">
                    <button
                      type="button"
                      onClick={openSourceSession}
                      disabled={sourceSessionProbe !== 'exists' || openingSourceSession}
                      className="inline-flex items-center gap-1.5 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                      data-testid="memory-entry-source-session-open"
                    >
                      <MessageSquareText className="h-3.5 w-3.5" />
                      {openingSourceSession
                        ? memoryText.entries.sourceSession.opening
                        : memoryText.entries.sourceSession.open}
                      {sourceMessageId ? ` · ${sourceMessageId.slice(0, 8)}` : ''}
                    </button>
                    {sourceSessionProbe !== 'exists' && (
                      <div className="mt-1.5 text-[11px] text-zinc-500" data-testid="memory-entry-source-session-reason">
                        {sourceSessionProbe === 'missing'
                          ? memoryText.entries.sourceSession.missing
                          : memoryText.entries.sourceSession.probeFailed}
                        <span className="ml-1 font-mono">{sourceSessionId.slice(0, 12)}</span>
                      </div>
                    )}
                  </div>
                )}

                <div className="rounded border border-zinc-800 bg-zinc-950/40 p-3 text-xs text-zinc-500" data-testid="memory-entry-history">
                  <div className="mb-2 flex items-center gap-1.5 font-medium text-zinc-400">
                    <History className="h-3.5 w-3.5" />
                    {memoryText.entries.history.title}
                  </div>
                  {journalFailed ? (
                    <div className="text-badge-warning">{memoryText.entries.history.failed}</div>
                  ) : journalRows === null ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : journalRows.length === 0 ? (
                    <div>{memoryText.entries.history.empty}</div>
                  ) : (
                    <ol className="space-y-1.5">
                      {journalRows.map((row) => (
                        <li key={row.id} className="flex items-baseline gap-2" data-testid="memory-entry-history-row">
                          <span className="text-zinc-600">{new Date(row.timestamp).toLocaleString(localeForLanguage(language))}</span>
                          <span className="text-zinc-400">{memoryText.entries.history.operationLabels[row.operation] ?? row.operation}</span>
                          <span className={row.actor === 'user_manual' ? 'text-zinc-500' : 'text-badge-info'}>
                            {memoryText.entries.history.actorLabels[row.actor] ?? row.actor}
                          </span>
                          {row.sessionId && (
                            <span className="truncate font-mono text-[10px] text-zinc-600">{row.sessionId.slice(0, 12)}</span>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex h-40 items-center justify-center text-xs text-zinc-500">
                {memoryText.entries.selectToEdit}
              </div>
            )}
          </div>
        </div>
      </div>
      <ConfirmDialog
        isOpen={archiveConfirmOpen}
        title={memoryText.entries.archiveConfirmTitle}
        message={memoryText.entries.archiveConfirmMessage}
        variant="warning"
        confirmText={memoryText.entries.archive}
        cancelText={memoryText.entries.cancel}
        onConfirm={() => {
          setArchiveConfirmOpen(false);
          saveDraft({ status: 'archived' });
        }}
        onCancel={() => setArchiveConfirmOpen(false)}
      />
    </SettingsSection>
  );
};
