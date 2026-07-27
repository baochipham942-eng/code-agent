import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  ClipboardCopy,
  Download,
  GitBranch,
  History,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Upload,
} from 'lucide-react';

import type {
  ConversationEvaluationAttribution,
  ConversationLineageAudit,
  ConversationProvenanceTrace,
  ConversationReplay,
} from '@shared/contract/conversationBranch';
import {
  SESSION_EXPORT_ENVELOPE_SCHEMA,
  SESSION_EXPORT_ENVELOPE_VERSION,
  type ForkSearchDocument,
  type ForkTreeNodeProjection,
  type ImportSessionForkResponse,
  type SessionExportEnvelopeV2,
  type SessionExportModeV2,
} from '@shared/contract/sessionForkPortability';
import { IPC_DOMAINS } from '@shared/ipc';
import { useI18n } from '../../../hooks/useI18n';
import { toast } from '../../../hooks/useToast';
import ipcService from '../../../services/ipcService';
import { copyPathToClipboard } from '../../../utils/platform';

interface BranchHistoryPanelProps {
  sessionId: string;
  /** Exact Project boundary from the currently loaded Session. Null disables import. */
  projectId: string | null;
  onOpenSession: (sessionId: string) => void | Promise<void>;
}

function createExportId(sessionId: string): string {
  const suffix = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `fork-export-${sessionId}-${suffix}`;
}

function parsePortableEnvelope(raw: string): SessionExportEnvelopeV2 | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SessionExportEnvelopeV2>;
    if (
      parsed.schema !== SESSION_EXPORT_ENVELOPE_SCHEMA
      || parsed.version !== SESSION_EXPORT_ENVELOPE_VERSION
      || typeof parsed.exportId !== 'string'
      || typeof parsed.projectId !== 'string'
      || typeof parsed.rootSessionId !== 'string'
      || !Array.isArray(parsed.sessions)
      || !Array.isArray(parsed.messages)
      || !parsed.lineage
      || typeof parsed.payloadDigest !== 'string'
    ) {
      return null;
    }
    return parsed as SessionExportEnvelopeV2;
  } catch {
    return null;
  }
}

function downloadJson(envelope: SessionExportEnvelopeV2): void {
  const json = JSON.stringify(envelope, null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${envelope.exportId}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

const TreeSummary: React.FC<{ node: ForkTreeNodeProjection }> = ({ node }) => (
  <li className="space-y-1">
    <span className="inline-flex items-center gap-1 text-zinc-300">
      <GitBranch className="h-3 w-3 text-violet-400" />
      <code>{node.sessionId}</code>
      <span className="text-zinc-600">d{node.depth}</span>
    </span>
    {node.children.length > 0 && (
      <ul className="ml-3 border-l border-violet-500/20 pl-3">
        {node.children.map((child) => <TreeSummary key={child.sessionId} node={child} />)}
      </ul>
    )}
  </li>
);

export const BranchHistoryPanel: React.FC<BranchHistoryPanelProps> = ({
  sessionId,
  projectId,
  onOpenSession,
}) => {
  const { t } = useI18n();
  const text = t.forkLineage.history;
  const requestVersion = useRef(0);
  const [replay, setReplay] = useState<ConversationReplay | null>(null);
  const [audit, setAudit] = useState<ConversationLineageAudit | null>(null);
  const [evaluations, setEvaluations] = useState<ConversationEvaluationAttribution[]>([]);
  const [ledgerLoading, setLedgerLoading] = useState(true);
  const [ledgerError, setLedgerError] = useState(false);
  const [auditError, setAuditError] = useState(false);
  const [selectedMessageId, setSelectedMessageId] = useState('');
  const [provenance, setProvenance] = useState<ConversationProvenanceTrace | null>(null);
  const [provenanceLoading, setProvenanceLoading] = useState(false);
  const [provenanceError, setProvenanceError] = useState(false);
  const [exportMode, setExportMode] = useState<SessionExportModeV2>('subtree');
  const [exportEnvelope, setExportEnvelope] = useState<SessionExportEnvelopeV2 | null>(null);
  const [exportTree, setExportTree] = useState<ForkTreeNodeProjection | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ForkSearchDocument[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [importJson, setImportJson] = useState('');
  const [importNamespace, setImportNamespace] = useState('');
  const [importPreview, setImportPreview] = useState<SessionExportEnvelopeV2 | null>(null);
  const [importParseError, setImportParseError] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportSessionForkResponse | null>(null);
  const [importError, setImportError] = useState(false);

  const refreshLedger = useCallback(async () => {
    const version = ++requestVersion.current;
    setLedgerLoading(true);
    setLedgerError(false);
    setAuditError(false);
    setProvenance(null);
    setProvenanceError(false);
    const [replayResult, auditResult, evaluationResult] = await Promise.allSettled([
      ipcService.invokeDomain<ConversationReplay>(
        IPC_DOMAINS.SESSION,
        'replayConversationBranch',
        { sessionId, options: { includeRewound: true } },
      ),
      ipcService.invokeDomain<ConversationLineageAudit>(
        IPC_DOMAINS.SESSION,
        'auditConversationLineage',
        { sessionId },
      ),
      ipcService.invokeDomain<ConversationEvaluationAttribution[]>(
        IPC_DOMAINS.SESSION,
        'listConversationEvaluationAttributions',
        { sessionId },
      ),
    ]);
    if (requestVersion.current !== version) return;

    if (replayResult.status === 'fulfilled') {
      setReplay(replayResult.value);
      setSelectedMessageId((current) => {
        if (replayResult.value.messages.some((item) => item.projectedMessageId === current)) {
          return current;
        }
        return replayResult.value.messages.at(-1)?.projectedMessageId ?? '';
      });
    } else {
      setReplay(null);
      setLedgerError(true);
    }
    if (auditResult.status === 'fulfilled') {
      setAudit(auditResult.value);
    } else {
      setAudit(null);
      setAuditError(true);
    }
    setEvaluations(evaluationResult.status === 'fulfilled' ? evaluationResult.value : []);
    setLedgerLoading(false);
  }, [sessionId]);

  useEffect(() => {
    setExportEnvelope(null);
    setExportTree(null);
    setSearchResults(null);
    setImportPreview(null);
    setImportResult(null);
    void refreshLedger();
    return () => {
      requestVersion.current += 1;
    };
  }, [refreshLedger]);

  const handleTraceProvenance = useCallback(async () => {
    if (!selectedMessageId || provenanceLoading) return;
    setProvenanceLoading(true);
    setProvenanceError(false);
    try {
      setProvenance(await ipcService.invokeDomain<ConversationProvenanceTrace>(
        IPC_DOMAINS.SESSION,
        'traceConversationProvenance',
        { sessionId, messageId: selectedMessageId },
      ));
    } catch {
      setProvenance(null);
      setProvenanceError(true);
    } finally {
      setProvenanceLoading(false);
    }
  }, [provenanceLoading, selectedMessageId, sessionId]);

  const handleExport = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    setExportError(false);
    setSearchResults(null);
    try {
      const envelope = await ipcService.invokeDomain<SessionExportEnvelopeV2>(
        IPC_DOMAINS.SESSION,
        'exportSessionFork',
        { sessionId, exportId: createExportId(sessionId), mode: exportMode },
      );
      setExportEnvelope(envelope);
      try {
        setExportTree(await ipcService.invokeDomain<ForkTreeNodeProjection>(
          IPC_DOMAINS.SESSION,
          'readSessionForkTree',
          { exportId: envelope.exportId, projectId: envelope.projectId },
        ));
      } catch {
        setExportTree(null);
      }
    } catch (error) {
      setExportEnvelope(null);
      setExportTree(null);
      setExportError(true);
      toast.error(error instanceof Error ? error.message : text.exportFailed);
    } finally {
      setExporting(false);
    }
  }, [exportMode, exporting, sessionId, text.exportFailed]);

  const handleCopyExport = useCallback(async () => {
    if (!exportEnvelope) return;
    const copied = await copyPathToClipboard(JSON.stringify(exportEnvelope, null, 2));
    if (copied) toast.success(text.exportCopied);
  }, [exportEnvelope, text.exportCopied]);

  const handleSearchExport = useCallback(async () => {
    if (!exportEnvelope || searching || !searchQuery.trim()) return;
    setSearching(true);
    try {
      setSearchResults(await ipcService.invokeDomain<ForkSearchDocument[]>(
        IPC_DOMAINS.SESSION,
        'searchSessionForkExports',
        {
          exportId: exportEnvelope.exportId,
          projectId: exportEnvelope.projectId,
          query: searchQuery.trim(),
        },
      ));
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }, [exportEnvelope, searchQuery, searching]);

  const importBoundaryError = useMemo(() => {
    if (!importPreview) return null;
    if (!projectId) return text.importBoundaryMissing;
    if (importPreview.projectId !== projectId) {
      return text.importBoundaryMismatch
        .replace('{source}', importPreview.projectId)
        .replace('{target}', projectId);
    }
    return null;
  }, [importPreview, projectId, text.importBoundaryMismatch, text.importBoundaryMissing]);

  const handlePreviewImport = useCallback(() => {
    const next = parsePortableEnvelope(importJson);
    setImportPreview(next);
    setImportParseError(!next);
    setImportError(false);
    setImportResult(null);
  }, [importJson]);

  const handleImport = useCallback(async () => {
    if (
      importing
      || !importPreview
      || !projectId
      || importPreview.projectId !== projectId
      || !importNamespace.trim()
    ) {
      return;
    }
    setImporting(true);
    setImportError(false);
    try {
      setImportResult(await ipcService.invokeDomain<ImportSessionForkResponse>(
        IPC_DOMAINS.SESSION,
        'importSessionFork',
        {
          envelope: importPreview,
          targetProjectId: projectId,
          namespace: importNamespace.trim(),
          allowProjectRemap: false,
        },
      ));
    } catch (error) {
      setImportResult(null);
      setImportError(true);
      toast.error(error instanceof Error ? error.message : text.importFailed);
    } finally {
      setImporting(false);
    }
  }, [importNamespace, importPreview, importing, projectId, text.importFailed]);

  const auditLabel = audit?.status === 'healthy'
    ? text.auditHealthy
    : audit?.status === 'quarantined'
      ? text.auditQuarantined
      : audit?.status === 'override_active'
        ? text.auditOverride
        : text.auditFailed;
  const auditHealthy = audit?.status === 'healthy';

  return (
    <section
      aria-label={text.title}
      data-testid="branch-history-panel"
      className="mx-4 mt-1 space-y-3 rounded-lg border border-violet-500/20 bg-zinc-950/80 p-3 text-xs text-zinc-300"
    >
      <header className="flex items-center gap-2">
        <History className="h-4 w-4 text-violet-400" />
        <h3 className="font-medium text-violet-200">{text.title}</h3>
        <button
          type="button"
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 hover:border-violet-500/50"
          onClick={() => void refreshLedger()}
          disabled={ledgerLoading}
        >
          {ledgerLoading
            ? <Loader2 className="h-3 w-3 animate-spin" />
            : <RefreshCw className="h-3 w-3" />}
          {text.refresh}
        </button>
      </header>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-2 rounded-md border border-zinc-800 p-2.5">
          <div className="flex items-center gap-2">
            <strong className="text-zinc-200">{text.replayTitle}</strong>
            <span
              data-testid="branch-audit-status"
              className={`inline-flex items-center gap-1 ${auditHealthy ? 'text-emerald-300' : 'text-amber-300'}`}
            >
              {auditHealthy
                ? <ShieldCheck className="h-3 w-3" />
                : <ShieldAlert className="h-3 w-3" />}
              {auditError ? text.auditFailed : auditLabel}
            </span>
          </div>
          {replay && (
            <p data-testid="branch-replay-summary" className="text-zinc-400">
              {text.replaySummary
                .replace('{messages}', String(replay.messages.length))
                .replace('{rewinds}', String(replay.openRewindIds.length))
                .replace('{events}', String(replay.ledgerEventCount))}
            </p>
          )}
          {ledgerError && <p className="text-red-300">{text.replayFailed}</p>}
          {audit && audit.issues.length > 0 && (
            <p className="text-amber-300">{audit.issues[0]?.code} · {audit.issues.length}</p>
          )}
          <p className="text-zinc-500">{text.evaluations.replace('{count}', String(evaluations.length))}</p>

          {replay && replay.messages.length > 0 && (
            <div className="space-y-1.5 border-t border-zinc-800 pt-2">
              <strong className="text-zinc-300">{text.provenanceTitle}</strong>
              <label className="block text-zinc-500">
                <span className="sr-only">{text.provenanceMessage}</span>
                <select
                  aria-label={text.provenanceMessage}
                  value={selectedMessageId}
                  onChange={(event) => {
                    setSelectedMessageId(event.target.value);
                    setProvenance(null);
                    setProvenanceError(false);
                  }}
                  className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-300"
                >
                  {replay.messages.map((item) => (
                    <option key={item.projectedMessageId} value={item.projectedMessageId}>
                      #{item.ordinal + 1} {item.message.role} · {item.projectedMessageId}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 hover:border-violet-500/50"
                disabled={!selectedMessageId || provenanceLoading}
                onClick={() => void handleTraceProvenance()}
              >
                {provenanceLoading && <Loader2 className="h-3 w-3 animate-spin" />}
                {provenanceLoading ? text.provenanceLoading : text.provenanceAction}
              </button>
              {provenance && (
                <div data-testid="branch-provenance" className="rounded bg-zinc-900 p-2 text-zinc-400">
                  <p>{text.provenanceSource
                    .replace('{session}', provenance.canonicalSource.sessionId)
                    .replace('{message}', provenance.canonicalSource.messageId)}</p>
                  <p>{text.provenancePath.replace('{count}', String(provenance.branchPath.length))}</p>
                </div>
              )}
              {provenanceError && <p className="text-red-300">{text.provenanceFailed}</p>}
            </div>
          )}
        </div>

        <div className="space-y-2 rounded-md border border-zinc-800 p-2.5">
          <strong className="text-zinc-200">{text.portabilityTitle}</strong>
          <label className="flex items-center gap-2 text-zinc-500">
            {text.exportMode}
            <select
              value={exportMode}
              onChange={(event) => setExportMode(event.target.value as SessionExportModeV2)}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-300"
            >
              <option value="subtree">{text.exportSubtree}</option>
              <option value="detached_child">{text.exportDetached}</option>
            </select>
          </label>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-violet-500/30 px-2 py-1 text-violet-200 hover:border-violet-400 disabled:opacity-50"
            disabled={exporting}
            onClick={() => void handleExport()}
          >
            {exporting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
            {exporting ? text.exporting : text.exportAction}
          </button>
          {exportError && <p className="text-red-300">{text.exportFailed}</p>}

          {exportEnvelope && (
            <div className="space-y-2 rounded-md bg-zinc-900 p-2">
              <p data-testid="branch-export-summary" className="break-all text-zinc-400">
                {text.exportSummary
                  .replace('{exportId}', exportEnvelope.exportId)
                  .replace('{projectId}', exportEnvelope.projectId)}
              </p>
              <div className="flex flex-wrap gap-1.5">
                <button type="button" className="inline-flex items-center gap-1 rounded border border-zinc-700 px-2 py-1" onClick={() => void handleCopyExport()}>
                  <ClipboardCopy className="h-3 w-3" />{text.exportCopy}
                </button>
                <button type="button" className="inline-flex items-center gap-1 rounded border border-zinc-700 px-2 py-1" onClick={() => downloadJson(exportEnvelope)}>
                  <Download className="h-3 w-3" />{text.exportDownload}
                </button>
              </div>
              {exportTree && (
                <div data-testid="branch-export-tree">
                  <p className="mb-1 text-zinc-500">{text.exportTreeTitle}</p>
                  <ul><TreeSummary node={exportTree} /></ul>
                </div>
              )}
              <div className="flex gap-1.5">
                <input
                  aria-label={text.exportSearchLabel}
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={text.exportSearchPlaceholder}
                  className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1"
                />
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded border border-zinc-700 px-2 py-1 disabled:opacity-50"
                  disabled={searching || !searchQuery.trim()}
                  onClick={() => void handleSearchExport()}
                >
                  {searching ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
                  {searching ? text.exportSearching : text.exportSearchAction}
                </button>
              </div>
              {searchResults && (
                <ul data-testid="branch-export-search-results" className="space-y-1">
                  {searchResults.length === 0 && <li className="text-zinc-500">{text.exportSearchEmpty}</li>}
                  {searchResults.map((result) => (
                    <li key={result.id} className="flex items-center justify-between gap-2 rounded bg-zinc-950 px-2 py-1">
                      <span className="min-w-0 truncate">{result.title} · d{result.depth}</span>
                      <button type="button" className="text-violet-300 hover:text-violet-100" onClick={() => void onOpenSession(result.sessionId)}>
                        {result.sessionId}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="space-y-2 border-t border-zinc-800 pt-2">
            <label className="block">
              <span className="sr-only">{text.importJsonLabel}</span>
              <textarea
                aria-label={text.importJsonLabel}
                value={importJson}
                onChange={(event) => {
                  setImportJson(event.target.value);
                  setImportPreview(null);
                  setImportParseError(false);
                  setImportResult(null);
                }}
                rows={3}
                placeholder={text.importJsonLabel}
                className="w-full resize-y rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-[11px]"
              />
            </label>
            <label className="block">
              <span className="sr-only">{text.importNamespaceLabel}</span>
              <input
                aria-label={text.importNamespaceLabel}
                value={importNamespace}
                onChange={(event) => setImportNamespace(event.target.value)}
                placeholder={text.importNamespacePlaceholder}
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5"
              />
            </label>
            <button type="button" className="rounded border border-zinc-700 px-2 py-1" onClick={handlePreviewImport}>
              {text.importPreviewAction}
            </button>
            {importParseError && <p className="text-red-300">{text.importPreviewInvalid}</p>}
            {importPreview && (
              <div data-testid="branch-import-preview" className="space-y-1 rounded bg-zinc-900 p-2">
                <p>{text.exportSummary
                  .replace('{exportId}', importPreview.exportId)
                  .replace('{projectId}', importPreview.projectId)}</p>
                <p className="text-zinc-500">
                  {importPreview.sessions.length} sessions · {importPreview.messages.length} messages
                </p>
              </div>
            )}
            {importBoundaryError && (
              <p data-testid="branch-import-boundary-error" className="text-amber-300">
                {importBoundaryError}
              </p>
            )}
            {importPreview && !importBoundaryError && importNamespace.trim() && !importResult && (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded border border-amber-600/60 px-2 py-1 text-amber-200 disabled:opacity-50"
                disabled={importing}
                onClick={() => void handleImport()}
              >
                {importing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
                {importing ? text.importing : text.importConfirmAction}
              </button>
            )}
            {importError && <p className="text-red-300">{text.importFailed}</p>}
            {importResult && (
              <div className="flex items-center gap-2 text-emerald-300">
                <CheckCircle2 className="h-3.5 w-3.5" />
                <span>{text.importDone}</span>
                <button type="button" className="rounded border border-emerald-700/60 px-2 py-1" onClick={() => void onOpenSession(importResult.rootSessionId)}>
                  {text.importOpen}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
};
