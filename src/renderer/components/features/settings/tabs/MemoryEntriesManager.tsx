import React, { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  Database,
  FileText,
  Loader2,
  RotateCcw,
  Save,
  Search,
  Trash2,
} from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import { IPC_DOMAINS } from '@shared/ipc/domains';
import type {
  MemoryEntry,
  MemoryEntryDeleteResult,
  MemoryEntryKind,
  MemoryEntryListResult,
  MemoryEntrySourceOfTruth,
  MemoryEntryStatus,
  MemoryEntryUpdateRequest,
  MemoryEntryUpdateResult,
} from '@shared/contract/memory';
import { Input } from '../../../primitives';
import { SettingsSection } from '../SettingsLayout';
import { isWebMode } from '../../../../utils/platform';
import ipcService from '../../../../services/ipcService';
import { useI18n } from '../../../../hooks/useI18n';
import { zh } from '../../../../i18n/zh';

type EntryStatusFilter = MemoryEntryStatus | 'all';
type EntryKindFilter = MemoryEntryKind | 'all';
type EntrySourceFilter = MemoryEntrySourceOfTruth | 'all';
type MemorySettingsText = typeof zh.settings.memory;

type MemoryEntryCommand =
  | { action: 'memoryEntries' }
  | ({ action: 'memoryEntryUpdate' } & MemoryEntryUpdateRequest)
  | { action: 'memoryEntryDelete'; entryId: string };

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
}

export interface MemoryEntryManagerRow {
  id: string;
  title: string;
  summary: string;
  statusLabel: string;
  kindLabel: string;
  sourceLabel: string;
  updatedAtLabel: string;
  selected: boolean;
}

const STATUS_OPTIONS: MemoryEntryStatus[] = ['candidate', 'active', 'rejected', 'stale', 'archived'];
const KIND_OPTIONS: MemoryEntryKind[] = ['user', 'feedback', 'project', 'reference', 'session', 'pattern'];

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
): string {
  const diffDays = Math.floor((now - timestamp) / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return labels.today;
  if (diffDays === 1) return labels.yesterday;
  if (diffDays < 7) return `${diffDays}${labels.daysAgoSuffix}`;
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

export function buildMemoryEntryRows({
  entries,
  selectedEntryId,
  searchQuery,
  statusFilter,
  kindFilter,
  sourceFilter,
  now = Date.now(),
  labels = zh.settings.memory,
}: {
  entries: MemoryEntry[];
  selectedEntryId: string | null;
  searchQuery: string;
  statusFilter: EntryStatusFilter;
  kindFilter: EntryKindFilter;
  sourceFilter: EntrySourceFilter;
  now?: number;
  labels?: MemorySettingsText;
}): MemoryEntryManagerRow[] {
  const query = searchQuery.trim().toLowerCase();
  return entries
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
      kindLabel: getMemoryEntryKindLabel(entry.kind, labels.entries.kindLabels),
      sourceLabel: getMemoryEntrySourceLabel(entry.source.sourceOfTruth, labels.sourceLabels),
      updatedAtLabel: formatMemoryEntryUpdatedAt(entry.updatedAt, now, labels.relativeDate),
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
  };
}

export const MemoryEntriesManager: React.FC<{ onChanged?: () => void | Promise<void> }> = ({ onChanged }) => {
  const { t } = useI18n();
  const memoryText = t.settings.memory;
  const [result, setResult] = useState<MemoryEntryListResult | null>(null);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [draft, setDraft] = useState<MemoryEntryDraft | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<EntryStatusFilter>('all');
  const [kindFilter, setKindFilter] = useState<EntryKindFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<EntrySourceFilter>('all');
  const [busy, setBusy] = useState<'load' | 'save' | 'delete' | null>('load');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const entries = result?.entries ?? [];
  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.id === selectedEntryId) ?? entries[0] ?? null,
    [entries, selectedEntryId],
  );
  const rows = useMemo(
    () => buildMemoryEntryRows({
      entries,
      selectedEntryId: selectedEntry?.id ?? null,
      searchQuery,
      statusFilter,
      kindFilter,
      sourceFilter,
      labels: memoryText,
    }),
    [entries, kindFilter, memoryText, searchQuery, selectedEntry?.id, sourceFilter, statusFilter],
  );

  const loadEntries = async () => {
    setBusy((current) => current || 'load');
    const response = await invokeMemoryEntryCommand<MemoryEntryListResult>({ action: 'memoryEntries' });
    if (response.success && response.data) {
      setResult(response.data);
      setSelectedEntryId((current) => {
        if (current && response.data?.entries.some((entry) => entry.id === current)) return current;
        return response.data?.entries[0]?.id ?? null;
      });
    } else {
      setMessage({ type: 'error', text: response.error || memoryText.entries.loadFailed });
    }
    setBusy((current) => (current === 'load' ? null : current));
  };

  useEffect(() => { loadEntries(); }, []);

  useEffect(() => {
    setDraft(selectedEntry ? createDraft(selectedEntry) : null);
  }, [selectedEntry?.id]);

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
    });
    if (response.success && response.data) {
      setMessage({ type: 'success', text: memoryText.entries.updateSuccess });
      await loadEntries();
      await onChanged?.();
    } else {
      setMessage({ type: 'error', text: response.error || memoryText.entries.updateFailed });
    }
    setBusy(null);
  };

  const deleteSelected = async () => {
    if (!selectedEntry) return;
    setBusy('delete');
    const response = await invokeMemoryEntryCommand<MemoryEntryDeleteResult>({
      action: 'memoryEntryDelete',
      entryId: selectedEntry.id,
    });
    if (response.success && response.data?.deleted) {
      setMessage({ type: 'success', text: memoryText.entries.deleteSuccess });
      setDeleteConfirmId(null);
      setSelectedEntryId(null);
      await loadEntries();
      await onChanged?.();
    } else {
      setMessage({ type: 'error', text: response.error || memoryText.entries.deleteFailed });
    }
    setBusy(null);
  };

  return (
    <SettingsSection
      title="All Memory"
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
              ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300'
              : 'border-red-500/20 bg-red-500/10 text-red-300'
          }`}
          >
            {message.text}
          </div>
        )}

        <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="min-w-0 border-b border-zinc-800 lg:border-b-0 lg:border-r">
            <div className="grid gap-2 border-b border-zinc-800 px-3 py-3 lg:grid-cols-[minmax(0,1fr)_120px_120px_120px]">
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
                onChange={(event) => setStatusFilter(event.target.value as EntryStatusFilter)}
                className="rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-zinc-300"
              >
                <option value="all">{memoryText.entries.filters.allStatus}</option>
                {STATUS_OPTIONS.map((status) => (
                  <option key={status} value={status}>{getMemoryEntryStatusLabel(status, memoryText.entries.statusLabels)}</option>
                ))}
              </select>
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
                <option value="db_memory">DB memory</option>
              </select>
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
                      <th className="px-3 py-2 font-medium">Entry</th>
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
                          <div className="max-w-[340px] truncate text-sm font-medium text-zinc-200">{row.title}</div>
                          <div className="mt-1 max-w-[380px] truncate text-zinc-500">{row.summary || row.id}</div>
                        </td>
                        <td className="px-3 py-3 align-top text-zinc-300">{row.statusLabel}</td>
                        <td className="px-3 py-3 align-top text-zinc-300">{row.kindLabel}</td>
                        <td className="px-3 py-3 align-top text-zinc-400">{row.sourceLabel}</td>
                        <td className="px-3 py-3 align-top text-zinc-400">{row.updatedAtLabel}</td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-3 py-10 text-center text-zinc-500">
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
                        <FileText className="h-4 w-4 text-emerald-300" />
                      ) : (
                        <Database className="h-4 w-4 text-sky-300" />
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
                    className="mt-1 h-48 w-full resize-y rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs leading-relaxed text-zinc-300 outline-hidden focus:border-indigo-500/60"
                  />
                </label>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => saveDraft()}
                    disabled={busy !== null}
                    className="inline-flex items-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busy === 'save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                    {memoryText.entries.save}
                  </button>
                  <button
                    type="button"
                    onClick={() => saveDraft({ status: draft.status === 'archived' ? 'active' : 'archived' })}
                    disabled={busy !== null}
                    className="inline-flex items-center gap-1.5 rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Archive className="h-3.5 w-3.5" />
                    {draft.status === 'archived' ? memoryText.entries.activate : memoryText.entries.archive}
                  </button>
                  {deleteConfirmId === selectedEntry.id ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setDeleteConfirmId(null)}
                        className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800"
                      >
                        {memoryText.entries.cancel}
                      </button>
                      <button
                        type="button"
                        onClick={deleteSelected}
                        disabled={busy !== null || isWebMode()}
                        className="inline-flex items-center gap-1.5 rounded border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {busy === 'delete' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                        {memoryText.entries.confirmDelete}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setDeleteConfirmId(selectedEntry.id)}
                      className="inline-flex items-center gap-1.5 rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-300"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {memoryText.entries.delete}
                    </button>
                  )}
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
              </div>
            ) : (
              <div className="flex h-40 items-center justify-center text-xs text-zinc-500">
                {memoryText.entries.selectToEdit}
              </div>
            )}
          </div>
        </div>
      </div>
    </SettingsSection>
  );
};
