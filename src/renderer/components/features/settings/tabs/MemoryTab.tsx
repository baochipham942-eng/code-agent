// ============================================================================
// MemoryTab - Light Memory File Browser
// Displays memory files from ~/.code-agent/memory/ with session stats
// ============================================================================

import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Search,
  Loader2,
  Trash2,
  FileText,
  Activity,
  MessageSquare,
  AlertCircle,
  CheckCircle,
  Brain,
  Upload,
  FileCheck2,
  ShieldAlert,
} from 'lucide-react';
import { Input } from '../../../primitives';
import { SettingsDetails, SettingsPage, SettingsSection } from '../SettingsLayout';
import { IPC_CHANNELS } from '@shared/ipc';
import { IPC_DOMAINS } from '@shared/ipc/domains';
import type {
  MemoryEntrySourceOfTruth,
  MemoryExportV2Bundle,
  MemoryImportV2ApplyResult,
  MemoryImportV2DiffStatus,
  MemoryImportV2DryRunResult,
} from '@shared/contract/memory';
import { isWebMode } from '../../../../utils/platform';
import { WebModeBanner } from '../WebModeBanner';
import ipcService from '../../../../services/ipcService';
import { useAppStore, type SettingsMemoryFocus } from '../../../../stores/appStore';
import { MemoryEntriesManager } from './MemoryEntriesManager';
import { useI18n } from '../../../../hooks/useI18n';
import { localeForLanguage } from '../../../../utils/i18nTime';
import { zh } from '../../../../i18n/zh';

// ============================================================================
// Types
// ============================================================================

export interface LightMemoryFile {
  filename: string;
  name: string;
  description: string;
  type: string;
  content: string;
  updatedAt: string;
}

export interface LightMemoryStats {
  totalFiles: number;
  byType: Record<string, number>;
  sessionStats: {
    activeDays: string[];
    totalSessions: number;
    recentSessionDepths: number[];
    modelUsage: Record<string, number>;
  } | null;
  recentConversations: string[];
}

type LightMemoryRequest =
  | { action: 'lightList' }
  | { action: 'lightStats' }
  | { action: 'lightDelete'; filename: string }
  | { action: 'memoryImportV2DryRun'; bundle: MemoryExportV2Bundle }
  | { action: 'memoryImportV2Apply'; bundle: MemoryExportV2Bundle; allowConflicts?: boolean };

interface LightMemoryResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

type MemorySettingsText = typeof zh.settings.memory;
type MemoryTypeConfig = { icon: string; label: string; color: string };
type MemoryImportStatusConfig = {
  label: string;
  tone: string;
  badgeClass: string;
};

// Memory type config
const TYPE_CONFIG: Record<string, Omit<MemoryTypeConfig, 'label'>> = {
  user: { icon: '👤', color: 'text-blue-400' },
  feedback: { icon: '💬', color: 'text-amber-400' },
  project: { icon: '📁', color: 'text-green-400' },
  reference: { icon: '🔗', color: 'text-purple-400' },
  unknown: { icon: '📄', color: 'text-zinc-400' },
};

const IMPORT_STATUS_CONFIG: Record<MemoryImportV2DiffStatus, Omit<MemoryImportStatusConfig, 'label'>> = {
  add: {
    tone: 'text-emerald-300',
    badgeClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  },
  update: {
    tone: 'text-sky-300',
    badgeClass: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  },
  conflict: {
    tone: 'text-amber-300',
    badgeClass: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  },
  skip: {
    tone: 'text-zinc-400',
    badgeClass: 'border-zinc-700 bg-zinc-800 text-zinc-400',
  },
};

export interface MemoryManagementRow {
  filename: string;
  name: string;
  description: string;
  type: string;
  typeLabel: string;
  typeIcon: string;
  typeColor: string;
  updatedAtLabel: string;
  contentLength: number;
  selected: boolean;
}

export interface MemoryManagementSummary {
  totalFiles: number;
  matchedFiles: number;
  typeCount: number;
  totalSessions: number;
  averageDepth: string;
  activeDays7: number;
  recentConversationCount: number;
}

export interface MemoryImportSummaryTile {
  status: MemoryImportV2DiffStatus;
  label: string;
  value: number;
  className: string;
}

function basename(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.split(/[\\/]/).filter(Boolean).pop() || value;
}

function resolveFocusTarget(files: LightMemoryFile[], focus: SettingsMemoryFocus): {
  file: LightMemoryFile | null;
  searchText: string;
} {
  const focusFilename = basename(focus.filename?.trim());
  const queryFilename = basename(focus.query?.trim());
  const targetFilename = focusFilename || (queryFilename?.toLowerCase().endsWith('.md') ? queryFilename : undefined);
  const searchText = targetFilename || focus.query?.trim() || focus.filename?.trim() || '';
  const lowerTarget = targetFilename?.toLowerCase();
  const lowerSearch = searchText.toLowerCase();
  const file = files.find((item) => {
    const filename = item.filename.toLowerCase();
    if (lowerTarget && filename === lowerTarget) return true;
    if (!lowerSearch) return false;
    return filename === lowerSearch
      || item.name.toLowerCase() === lowerSearch
      || item.description.toLowerCase().includes(lowerSearch);
  }) ?? null;

  return { file, searchText };
}

export function formatMemoryUpdatedAt(
  iso: string,
  now = new Date(),
  labels: MemorySettingsText['relativeDate'] = zh.settings.memory.relativeDate,
  locale: string = localeForLanguage('zh'),
): string {
  const date = new Date(iso);
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return labels.today;
  if (diffDays === 1) return labels.yesterday;
  if (diffDays < 7) return `${diffDays}${labels.daysAgoSuffix}`;
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

export function getMemoryTypeConfig(
  type: string,
  labels: MemorySettingsText['typeLabels'] = zh.settings.memory.typeLabels,
): MemoryTypeConfig {
  const config = TYPE_CONFIG[type] || TYPE_CONFIG.unknown;
  return {
    ...config,
    label: labels[type as keyof typeof labels] || labels.unknown,
  };
}

export function getMemoryImportStatusConfig(
  status: MemoryImportV2DiffStatus,
  labels: MemorySettingsText['importStatusLabels'] = zh.settings.memory.importStatusLabels,
): MemoryImportStatusConfig {
  return {
    ...IMPORT_STATUS_CONFIG[status],
    label: labels[status],
  };
}

export function getMemorySourceOfTruthLabel(
  sourceOfTruth?: MemoryEntrySourceOfTruth,
  labels: MemorySettingsText['sourceLabels'] = zh.settings.memory.sourceLabels,
): string {
  if (!sourceOfTruth) return labels.unknown;
  return labels[sourceOfTruth] || sourceOfTruth;
}

export function isMemoryExportV2Bundle(value: unknown): value is MemoryExportV2Bundle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<MemoryExportV2Bundle>;
  return candidate.schemaVersion === 2
    && typeof candidate.exportedAt === 'number'
    && Array.isArray(candidate.entries)
    && Boolean(candidate.index && typeof candidate.index === 'object')
    && Array.isArray(candidate.evidenceManifest)
    && Boolean(candidate.sourceCounts && typeof candidate.sourceCounts === 'object');
}

export function buildMemoryImportSummary(
  result: MemoryImportV2DryRunResult | MemoryImportV2ApplyResult,
  labels: MemorySettingsText['importStatusLabels'] = zh.settings.memory.importStatusLabels,
): MemoryImportSummaryTile[] {
  return ([
    ['add', result.added],
    ['update', result.updated],
    ['conflict', result.conflicted],
    ['skip', result.skipped],
  ] as Array<[MemoryImportV2DiffStatus, number]>).map(([status, value]) => {
    const config = getMemoryImportStatusConfig(status, labels);
    return {
      status,
      label: config.label,
      value,
      className: config.tone,
    };
  });
}

export function getMemoryImportApplyCount(result: MemoryImportV2DryRunResult, allowConflicts: boolean): number {
  return result.added + result.updated + (allowConflicts ? result.conflicted : 0);
}

export function buildMemoryManagementRows({
  files,
  selectedFilename,
  now = new Date(),
  labels = zh.settings.memory,
  locale = localeForLanguage('zh'),
}: {
  files: LightMemoryFile[];
  selectedFilename: string | null;
  now?: Date;
  labels?: MemorySettingsText;
  locale?: string;
}): MemoryManagementRow[] {
  return files.map((file) => {
    const typeConfig = getMemoryTypeConfig(file.type || 'unknown', labels.typeLabels);
    return {
      filename: file.filename,
      name: file.name,
      description: file.description,
      type: file.type || 'unknown',
      typeLabel: typeConfig.label,
      typeIcon: typeConfig.icon,
      typeColor: typeConfig.color,
      updatedAtLabel: formatMemoryUpdatedAt(file.updatedAt, now, labels.relativeDate, locale),
      contentLength: file.content.length,
      selected: file.filename === selectedFilename,
    };
  });
}

export function buildMemoryManagementSummary({
  files,
  filteredFiles,
  stats,
  now = new Date(),
}: {
  files: LightMemoryFile[];
  filteredFiles: LightMemoryFile[];
  stats: LightMemoryStats | null;
  now?: Date;
}): MemoryManagementSummary {
  const depths = stats?.sessionStats?.recentSessionDepths || [];
  const averageDepth = depths.length > 0
    ? (depths.reduce((sum, depth) => sum + depth, 0) / depths.length).toFixed(0)
    : '0';
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekAgoStr = weekAgo.toISOString().split('T')[0];

  return {
    totalFiles: stats?.totalFiles ?? files.length,
    matchedFiles: filteredFiles.length,
    typeCount: new Set(files.map((file) => file.type || 'unknown')).size,
    totalSessions: stats?.sessionStats?.totalSessions ?? 0,
    averageDepth,
    activeDays7: stats?.sessionStats?.activeDays.filter((day) => day >= weekAgoStr).length ?? 0,
    recentConversationCount: stats?.recentConversations.length ?? 0,
  };
}

function isLightMemoryResponse<T>(value: unknown): value is LightMemoryResponse<T> {
  return Boolean(value && typeof value === 'object' && 'success' in value);
}

async function invokeLightMemory<T>(request: LightMemoryRequest): Promise<LightMemoryResponse<T>> {
  const commandResult = ipcService.isAvailable()
    ? await ipcService.invoke(IPC_CHANNELS.MEMORY, request) as unknown
    : undefined;
  if (commandResult !== undefined) {
    if (!isLightMemoryResponse<T>(commandResult)) {
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

// ============================================================================
// Component
// ============================================================================

export const MemoryTab: React.FC = () => {
  const { t, language } = useI18n();
  const memoryText = t.settings.memory;
  const settingsMemoryFocus = useAppStore((state) => state.settingsMemoryFocus);
  const clearSettingsMemoryFocus = useAppStore((state) => state.clearSettingsMemoryFocus);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const [files, setFiles] = useState<LightMemoryFile[]>([]);
  const [stats, setStats] = useState<LightMemoryStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFile, setSelectedFile] = useState<LightMemoryFile | null>(null);
  const [deletingFile, setDeletingFile] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [importBundle, setImportBundle] = useState<MemoryExportV2Bundle | null>(null);
  const [importFileName, setImportFileName] = useState<string | null>(null);
  const [importPreview, setImportPreview] = useState<MemoryImportV2DryRunResult | null>(null);
  const [importResult, setImportResult] = useState<MemoryImportV2ApplyResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState<'dryRun' | 'apply' | null>(null);
  const [allowImportConflicts, setAllowImportConflicts] = useState(false);

  // Load data
  const loadData = async () => {
    try {
      setIsLoading(true);
      const [filesResult, statsResult] = await Promise.all([
        invokeLightMemory<LightMemoryFile[]>({ action: 'lightList' }),
        invokeLightMemory<LightMemoryStats>({ action: 'lightStats' }),
      ]);
      if (filesResult?.success && filesResult.data) {
        setFiles(filesResult.data);
      }
      if (statsResult?.success && statsResult.data) {
        setStats(statsResult.data);
      }
    } catch {
      setMessage({ type: 'error', text: memoryText.files.loadFailed });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  useEffect(() => {
    if (!settingsMemoryFocus || isLoading) return;

    const { file, searchText } = resolveFocusTarget(files, settingsMemoryFocus);
    if (searchText) setSearchQuery(searchText);

    if (file) {
      setSelectedFile(file);
      setMessage({ type: 'success', text: `${memoryText.files.focusFoundPrefix}${file.filename}` });
    } else if (searchText) {
      setSelectedFile(null);
      setMessage({ type: 'error', text: `${memoryText.files.focusMissingPrefix}${searchText}` });
    }

    clearSettingsMemoryFocus();
  }, [settingsMemoryFocus, files, isLoading, clearSettingsMemoryFocus]);

  // Auto-clear message
  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  // Filter files by search
  const filteredFiles = useMemo(() => {
    if (!searchQuery.trim()) return files;
    const q = searchQuery.toLowerCase();
    return files.filter(f =>
      f.filename.toLowerCase().includes(q) ||
      f.name.toLowerCase().includes(q) ||
      f.description.toLowerCase().includes(q) ||
      f.content.toLowerCase().includes(q)
    );
  }, [files, searchQuery]);

  const memoryRows = useMemo(
    () => buildMemoryManagementRows({
      files: filteredFiles,
      selectedFilename: selectedFile?.filename || null,
      labels: memoryText,
      locale: localeForLanguage(language),
    }),
    [filteredFiles, memoryText, selectedFile?.filename, language],
  );
  const memorySummary = useMemo(
    () => buildMemoryManagementSummary({ files, filteredFiles, stats }),
    [files, filteredFiles, stats],
  );

  const modelUsageRows = useMemo(() => {
    const usage = stats?.sessionStats?.modelUsage;
    if (!usage) return [];
    const total = Object.values(usage).reduce((a, b) => a + b, 0);
    if (total <= 0) return [];
    return Object.entries(usage)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([model, count]) => ({
        model,
        pct: Math.round((count / total) * 100),
      }));
  }, [stats?.sessionStats?.modelUsage]);

  const importSummary = useMemo(
    () => importPreview ? buildMemoryImportSummary(importPreview, memoryText.importStatusLabels) : [],
    [importPreview, memoryText.importStatusLabels],
  );
  const importApplyCount = useMemo(
    () => importPreview ? getMemoryImportApplyCount(importPreview, allowImportConflicts) : 0,
    [allowImportConflicts, importPreview],
  );
  const importVisibleItems = useMemo(
    () => importPreview?.items.slice(0, 12) ?? [],
    [importPreview],
  );
  const hiddenImportItemCount = Math.max(0, (importPreview?.items.length ?? 0) - importVisibleItems.length);

  // Delete file
  const handleDelete = async (filename: string) => {
    try {
      const result = await invokeLightMemory<boolean>({
        action: 'lightDelete',
        filename,
      });
      if (result?.success) {
        setMessage({ type: 'success', text: `${memoryText.files.deleteSuccessPrefix}${filename}` });
        if (selectedFile?.filename === filename) setSelectedFile(null);
        await loadData();
      } else {
        setMessage({ type: 'error', text: memoryText.files.deleteFailed });
      }
    } catch {
      setMessage({ type: 'error', text: memoryText.files.deleteFailed });
    }
    setDeletingFile(null);
  };

  const resetImportState = () => {
    setImportBundle(null);
    setImportFileName(null);
    setImportPreview(null);
    setImportResult(null);
    setImportError(null);
    setAllowImportConflicts(false);
  };

  const handleImportFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setImportBusy('dryRun');
    setImportFileName(file.name);
    setImportBundle(null);
    setImportPreview(null);
    setImportResult(null);
    setImportError(null);
    setAllowImportConflicts(false);

    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      if (!isMemoryExportV2Bundle(parsed)) {
        throw new Error(memoryText.import.invalidBundle);
      }

      const result = await invokeLightMemory<MemoryImportV2DryRunResult>({
        action: 'memoryImportV2DryRun',
        bundle: parsed,
      });
      if (!result.success || !result.data) {
        throw new Error(result.error || memoryText.import.dryRunFailed);
      }

      setImportBundle(parsed);
      setImportPreview(result.data);
      setMessage({
        type: 'success',
        text: `${memoryText.import.dryRunSuccessPrefix}${result.data.added}${memoryText.import.dryRunSuccessAddedMiddle}${result.data.updated}${memoryText.import.dryRunSuccessUpdatedMiddle}${result.data.conflicted}${memoryText.import.dryRunSuccessConflictSuffix}`,
      });
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setImportBusy(null);
    }
  };

  const handleApplyImport = async () => {
    if (!importBundle || !importPreview) return;

    setImportBusy('apply');
    setImportError(null);
    setImportResult(null);

    try {
      const result = await invokeLightMemory<MemoryImportV2ApplyResult>({
        action: 'memoryImportV2Apply',
        bundle: importBundle,
        allowConflicts: allowImportConflicts,
      });
      if (!result.success || !result.data) {
        throw new Error(result.error || memoryText.import.applyFailed);
      }

      setImportPreview(result.data);
      setImportResult(result.data);
      setMessage({
        type: 'success',
        text: `${memoryText.import.applySuccessPrefix}${result.data.applied}${memoryText.import.applySuccessMiddle}${result.data.writtenFiles.length}${memoryText.import.applySuccessSuffix}`,
      });
      await loadData();
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setImportBusy(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-48">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  return (
    <SettingsPage
      title="Light Memory"
      description={memoryText.files.pageDescription}
    >
      <div data-testid="memory-settings-tab" className="space-y-6">
      <WebModeBanner />

      {message && (
        <div
          className={`flex items-center gap-2 rounded-lg p-3 text-xs ${
            message.type === 'success'
              ? 'bg-green-500/10 text-green-400'
              : 'bg-red-500/10 text-red-400'
          }`}
        >
          {message.type === 'success' ? (
            <CheckCircle className="h-4 w-4" />
          ) : (
            <AlertCircle className="h-4 w-4" />
          )}
          <span>{message.text}</span>
        </div>
      )}

      <MemoryEntriesManager onChanged={loadData} />

      <SettingsSection
        title={memoryText.import.title}
        description={memoryText.import.description}
      >
        <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60">
          <div className="flex flex-col gap-3 border-b border-zinc-800 px-3 py-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                <FileCheck2 className="h-4 w-4 text-emerald-300" />
                {importFileName || memoryText.import.noFileSelected}
              </div>
              <div className="mt-1 text-xs text-zinc-500">
                {importPreview
                  ? `${memoryText.import.previewCountPrefix}${importPreview.incomingCount}${memoryText.import.previewCountMiddle}${importPreview.existingCount}${memoryText.import.previewCountSuffix}`
                  : memoryText.import.help}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={importFileInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                data-testid="memory-import-file-input"
                onChange={handleImportFileChange}
              />
              <button
                type="button"
                onClick={() => importFileInputRef.current?.click()}
                disabled={importBusy !== null}
                className="inline-flex items-center gap-1.5 rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {importBusy === 'dryRun' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                {memoryText.import.chooseFile}
              </button>
              {importPreview && (
                <button
                  type="button"
                  onClick={resetImportState}
                  disabled={importBusy !== null}
                  className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {memoryText.import.clear}
                </button>
              )}
              <button
                type="button"
                onClick={handleApplyImport}
                disabled={!importPreview || !importBundle || importBusy !== null || importApplyCount === 0}
                className="inline-flex items-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {importBusy === 'apply' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FileCheck2 className="h-3.5 w-3.5" />
                )}
                {memoryText.import.apply}
              </button>
            </div>
          </div>

          {importError && (
            <div className="flex items-center gap-2 border-b border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              <AlertCircle className="h-4 w-4" />
              {importError}
            </div>
          )}

          {importPreview ? (
            <div className="space-y-3 px-3 py-3">
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                {importSummary.map((item) => (
                  <div key={item.status} className="rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                    <div className="text-[11px] text-zinc-500">{item.label}</div>
                    <div className={`mt-1 text-lg font-semibold ${item.className}`}>{item.value}</div>
                  </div>
                ))}
              </div>

              <div className="flex flex-col gap-2 rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-400 lg:flex-row lg:items-center lg:justify-between">
                <label className={`inline-flex items-center gap-2 ${importPreview.conflicted > 0 ? 'text-amber-300' : 'text-zinc-500'}`}>
                  <input
                    type="checkbox"
                    checked={allowImportConflicts}
                    disabled={importPreview.conflicted === 0 || importBusy !== null}
                    onChange={(event) => setAllowImportConflicts(event.target.checked)}
                    className="h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-900 text-amber-400"
                  />
                  {memoryText.import.includeConflicts}
                </label>
                <div className="flex items-center gap-1.5">
                  <ShieldAlert className="h-3.5 w-3.5 text-zinc-500" />
                  {memoryText.import.applyPlanPrefix}
                  {importApplyCount}
                  {memoryText.import.applyPlanMiddle}
                  {importPreview.skipped + (allowImportConflicts ? 0 : importPreview.conflicted)}
                  {memoryText.import.applyPlanSuffix}
                </div>
              </div>

              <div className="overflow-x-auto rounded border border-zinc-800">
                <table className="w-full min-w-[760px] text-left text-xs">
                  <thead className="border-b border-zinc-800 bg-zinc-950/60 text-[11px] uppercase tracking-[0.08em] text-zinc-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">{memoryText.import.table.status}</th>
                      <th className="px-3 py-2 font-medium">Entry</th>
                      <th className="px-3 py-2 font-medium">{memoryText.import.table.source}</th>
                      <th className="px-3 py-2 font-medium">{memoryText.import.table.reason}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800">
                {importVisibleItems.map((item) => {
                      const statusConfig = getMemoryImportStatusConfig(item.status, memoryText.importStatusLabels);
                      return (
                        <tr key={item.entryId} className="bg-zinc-900/30">
                          <td className="px-3 py-2 align-top">
                            <span className={`inline-flex rounded border px-2 py-0.5 ${statusConfig.badgeClass}`}>
                              {statusConfig.label}
                            </span>
                          </td>
                          <td className="px-3 py-2 align-top">
                            <div className="font-medium text-zinc-200">
                              {item.incomingTitle || item.existingTitle || item.entryId}
                            </div>
                            <div className="mt-0.5 font-mono text-[11px] text-zinc-500">{item.entryId}</div>
                          </td>
                          <td className="px-3 py-2 align-top text-zinc-400">
                            {getMemorySourceOfTruthLabel(item.sourceOfTruth, memoryText.sourceLabels)}
                          </td>
                          <td className="px-3 py-2 align-top text-zinc-400">
                            {item.reason}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {hiddenImportItemCount > 0 && (
                <div className="text-xs text-zinc-500">
                  {memoryText.import.hiddenPrefix}{hiddenImportItemCount}{memoryText.import.hiddenSuffix}
                </div>
              )}

              {importResult && (
                <div data-testid="memory-import-receipt" className="rounded border border-emerald-500/20 bg-emerald-500/10 px-3 py-3 text-xs text-emerald-100">
                  <div className="font-medium text-emerald-200">
                    {memoryText.import.receiptPrefix}{importResult.applied}{memoryText.import.receiptMiddle}{importResult.created}{memoryText.import.receiptCreatedMiddle}{importResult.updatedApplied}{memoryText.import.receiptUpdatedMiddle}{importResult.skippedApply}
                  </div>
                  <div className="mt-2 text-emerald-100/80">
                    {memoryText.import.writtenFilesPrefix}{importResult.writtenFiles.length > 0 ? importResult.writtenFiles.slice(0, 4).join('、') : memoryText.import.none}
                    {importResult.writtenFiles.length > 4 ? `${memoryText.import.extraFilesPrefix}${importResult.writtenFiles.length}${memoryText.import.extraFilesSuffix}` : ''}
                  </div>
                  {importResult.mirrorRebuild && (
                    <div className="mt-1 text-emerald-100/80">
                      {memoryText.import.mirrorPrefix}{importResult.mirrorRebuild.mirrored}/{importResult.mirrorRebuild.totalLightFiles}{memoryText.import.mirrorCreatedMiddle}{importResult.mirrorRebuild.created}{memoryText.import.mirrorUpdatedMiddle}{importResult.mirrorRebuild.updated}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="px-3 py-6 text-center text-xs text-zinc-500">
              {memoryText.import.emptyPreview}
            </div>
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        title={memoryText.files.managementTitle}
        description={memoryText.files.managementDescription}
      >
        <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60">
          <div className="grid grid-cols-2 gap-px border-b border-zinc-700/60 bg-zinc-800/80 lg:grid-cols-4">
            {[
              [memoryText.files.stats.memoryFiles, String(memorySummary.totalFiles), `${memorySummary.matchedFiles}${memoryText.files.stats.matchSuffix}`],
              [memoryText.files.stats.types, String(memorySummary.typeCount), `${memoryText.typeLabels.user} / ${memoryText.typeLabels.feedback} / ${memoryText.typeLabels.project} / ${memoryText.typeLabels.reference}`],
              [memoryText.files.stats.totalSessions, String(memorySummary.totalSessions), `${memoryText.files.stats.averageDepthPrefix}${memorySummary.averageDepth}`],
              [memoryText.files.stats.active7Days, String(memorySummary.activeDays7), `${memorySummary.recentConversationCount}${memoryText.files.stats.recentSessionsSuffix}`],
            ].map(([label, value, caption]) => (
              <div key={label} className="bg-zinc-900/80 px-3 py-3">
                <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-zinc-500">{label}</div>
                <div className="mt-1 truncate text-lg font-semibold text-zinc-100">{value}</div>
                <div className="mt-0.5 truncate text-[11px] text-zinc-500">{caption}</div>
              </div>
            ))}
          </div>

          <div className="border-b border-zinc-800 px-3 py-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={memoryText.files.searchPlaceholder}
                className="pl-9"
                data-testid="memory-search-input"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] text-left text-xs">
              <thead className="border-b border-zinc-700/60 bg-zinc-900/80 text-[11px] uppercase tracking-[0.08em] text-zinc-500">
                <tr>
                  <th className="px-3 py-2 font-medium">{memoryText.files.table.file}</th>
                  <th className="px-3 py-2 font-medium">{memoryText.files.table.type}</th>
                  <th className="px-3 py-2 font-medium">{memoryText.files.table.updatedAt}</th>
                  <th className="px-3 py-2 font-medium">{memoryText.files.table.content}</th>
                  <th className="px-3 py-2 text-right font-medium">{memoryText.files.table.actions}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80">
                {memoryRows.map((row) => {
                  const file = filteredFiles.find((item) => item.filename === row.filename);
                  if (!file) return null;
                  return (
                    <tr
                      key={row.filename}
                      data-testid="memory-file-row"
                      data-memory-filename={row.filename}
                      onClick={() => setSelectedFile(row.selected ? null : file)}
                      className={`cursor-pointer ${row.selected ? 'bg-indigo-500/10' : 'bg-zinc-900/40 hover:bg-zinc-800/60'}`}
                    >
                      <td className="px-3 py-3 align-top">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <FileText className="h-4 w-4 shrink-0 text-zinc-500" />
                            <span className="truncate text-sm font-medium text-zinc-200">{row.name}</span>
                          </div>
                          <div className="mt-1 max-w-[360px] truncate font-mono text-[11px] text-zinc-500" title={row.filename}>
                            {row.filename}
                          </div>
                          <div className="mt-1 max-w-[420px] truncate text-zinc-500">
                            {row.description || memoryText.files.noDescription}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 align-top">
                        <span className={`inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 ${row.typeColor}`}>
                          <span>{row.typeIcon}</span>
                          {row.typeLabel}
                        </span>
                      </td>
                      <td className="px-3 py-3 align-top text-zinc-400">
                        {row.updatedAtLabel}
                      </td>
                      <td className="px-3 py-3 align-top text-zinc-400">
                        {row.contentLength.toLocaleString()}{memoryText.files.charSuffix}
                      </td>
                      <td className="px-3 py-3 align-top">
                        <div className="flex justify-end gap-2">
                          {deletingFile === row.filename ? (
                            <>
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setDeletingFile(null);
                                }}
                                className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800"
                              >
                                {memoryText.files.cancel}
                              </button>
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  handleDelete(row.filename);
                                }}
                                className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-red-300 hover:bg-red-500/20 disabled:opacity-50"
                                disabled={isWebMode()}
                              >
                                {memoryText.files.confirm}
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setDeletingFile(row.filename);
                              }}
                              className="inline-flex items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-zinc-400 hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-300"
                              title={memoryText.files.delete}
                            >
                              <Trash2 className="h-3 w-3" />
                              {memoryText.files.delete}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {memoryRows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-10 text-center text-zinc-500">
                      {files.length === 0 ? memoryText.files.empty : memoryText.files.noMatches}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </SettingsSection>

      {selectedFile && (
        <SettingsSection
          title={memoryText.files.detailTitle}
          description={`${selectedFile.filename} · ${formatMemoryUpdatedAt(selectedFile.updatedAt, new Date(), memoryText.relativeDate, localeForLanguage(language))}`}
        >
          <div className="grid gap-4 rounded-lg border border-zinc-700/70 bg-zinc-900/60 p-4 lg:grid-cols-[minmax(0,1fr)_260px]">
            <pre
              data-testid="memory-file-detail"
              className="max-h-[360px] overflow-auto whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 text-xs leading-relaxed text-zinc-300"
            >
              {selectedFile.content || memoryText.files.emptyContent}
            </pre>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
              <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                <Brain className="h-4 w-4 text-indigo-300" />
                {memoryText.files.summaryTitle}
              </div>
              <dl className="mt-3 space-y-2 text-xs">
                <div className="flex justify-between gap-3">
                  <dt className="text-zinc-500">Name</dt>
                  <dd className="truncate text-zinc-300">{selectedFile.name}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-zinc-500">Type</dt>
                  <dd className={getMemoryTypeConfig(selectedFile.type, memoryText.typeLabels).color}>
                    {getMemoryTypeConfig(selectedFile.type, memoryText.typeLabels).label}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-zinc-500">Updated</dt>
                  <dd className="text-zinc-300">{formatMemoryUpdatedAt(selectedFile.updatedAt, new Date(), memoryText.relativeDate, localeForLanguage(language))}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-zinc-500">Chars</dt>
                  <dd className="text-zinc-300">{selectedFile.content.length.toLocaleString()}</dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Description</dt>
                  <dd className="mt-1 text-zinc-300">{selectedFile.description || memoryText.files.noDescription}</dd>
                </div>
              </dl>
            </div>
          </div>
        </SettingsSection>
      )}

      <SettingsDetails
        title={memoryText.files.diagnosticsTitle}
        description={memoryText.files.diagnosticsDescription}
      >
        <div className="space-y-4">
          {modelUsageRows.length > 0 && (
            <div>
              <div className="mb-2 flex items-center gap-1.5">
                <Activity className="h-3.5 w-3.5 text-zinc-400" />
                <span className="text-xs text-zinc-400">{memoryText.files.modelUsage}</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {modelUsageRows.map(({ model, pct }) => (
                  <span key={model} className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">
                    {model} <span className="text-zinc-500">{pct}%</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {stats?.recentConversations && stats.recentConversations.length > 0 && (
            <div>
              <div className="mb-2 flex items-center gap-1.5">
                <MessageSquare className="h-3.5 w-3.5 text-zinc-400" />
                <span className="text-xs text-zinc-400">{memoryText.files.recentConversations}</span>
              </div>
              <div className="max-h-40 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950/40 p-2">
                {stats.recentConversations.map((line, i) => (
                  <div key={i} className="py-0.5 text-xs text-zinc-400">
                    {line.replace(/^- /, '')}
                  </div>
                ))}
              </div>
            </div>
          )}

          {modelUsageRows.length === 0 && (!stats?.recentConversations || stats.recentConversations.length === 0) && (
            <div className="text-xs text-zinc-500">
              {memoryText.files.noStats}
            </div>
          )}
        </div>
      </SettingsDetails>
      </div>
    </SettingsPage>
  );
};
