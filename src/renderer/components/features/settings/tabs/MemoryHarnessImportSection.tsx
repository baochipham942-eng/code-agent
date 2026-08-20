import React, { useMemo, useState } from 'react';
import { CheckCircle2, Download, Loader2, ShieldAlert } from 'lucide-react';
import type {
  MemoryImportApplyResult,
  MemoryImportDirectiveConfirmResult,
  MemoryImportDryRunResult,
} from '@shared/contract/memory';
import { IPC_CHANNELS } from '@shared/ipc';
import { IPC_DOMAINS } from '@shared/ipc/domains';
import ipcService from '../../../../services/ipcService';
import { isWebMode } from '../../../../utils/platform';
import { useI18n } from '../../../../hooks/useI18n';
import { SettingsSection } from '../SettingsLayout';

interface CommandResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

type HarnessImportCommand =
  | { action: 'memoryHarnessImportDryRun' }
  | { action: 'memoryHarnessImportApply'; candidateIds: string[] }
  | { action: 'memoryHarnessImportConfirmDirective'; instructionId: string };

function isResponse<T>(value: unknown): value is CommandResponse<T> {
  return Boolean(value && typeof value === 'object' && 'success' in value);
}

async function invoke<T>(request: HarnessImportCommand): Promise<CommandResponse<T>> {
  const direct = ipcService.isAvailable()
    ? await ipcService.invoke(IPC_CHANNELS.MEMORY, request) as unknown
    : undefined;
  if (direct !== undefined) {
    if (!isResponse<T>(direct)) return { success: true, data: direct as T };
    if (direct.success || !isWebMode()) return direct;
  }
  try {
    const data = await ipcService.invokeDomain<T>(IPC_DOMAINS.MEMORY, String(request.action), request);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export const MemoryHarnessImportSection: React.FC<{ onChanged?: () => void | Promise<void> }> = ({ onChanged }) => {
  const { t } = useI18n();
  const copy = t.settings.memory.harnessImport;
  const [preview, setPreview] = useState<MemoryImportDryRunResult | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'preview' | 'apply' | `directive:${string}` | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const ready = useMemo(
    () => preview?.candidates.filter((candidate) => candidate.disposition === 'add') ?? [],
    [preview],
  );

  const runPreview = async () => {
    setBusy('preview');
    setMessage(null);
    const response = await invoke<MemoryImportDryRunResult>({ action: 'memoryHarnessImportDryRun' });
    if (response.success && response.data) {
      setPreview(response.data);
      setSelectedIds(new Set(
        response.data.candidates
          .filter((candidate) => candidate.disposition === 'add')
          .map((candidate) => candidate.id),
      ));
    } else {
      setMessage({ type: 'error', text: response.error || copy.previewFailed });
    }
    setBusy(null);
  };

  const apply = async () => {
    if (selectedIds.size === 0) return;
    setBusy('apply');
    setMessage(null);
    const response = await invoke<MemoryImportApplyResult>({
      action: 'memoryHarnessImportApply',
      candidateIds: Array.from(selectedIds),
    });
    if (response.success && response.data) {
      setMessage({
        type: 'success',
        text: copy.applyResult
          .replace('{imported}', String(response.data.imported))
          .replace('{skipped}', String(response.data.skipped)),
      });
      await runPreview();
      await onChanged?.();
    } else {
      setMessage({ type: 'error', text: response.error || copy.applyFailed });
      setBusy(null);
    }
  };

  const confirmDirective = async (instructionId: string) => {
    setBusy(`directive:${instructionId}`);
    setMessage(null);
    const response = await invoke<MemoryImportDirectiveConfirmResult>({
      action: 'memoryHarnessImportConfirmDirective',
      instructionId,
    });
    if (response.success && response.data) {
      setMessage({
        type: response.data.imported ? 'success' : 'error',
        text: response.data.imported ? copy.directiveImported : copy.directiveNotImported,
      });
      await runPreview();
      await onChanged?.();
    } else {
      setMessage({ type: 'error', text: response.error || copy.directiveFailed });
      setBusy(null);
    }
  };

  return (
    <SettingsSection title={copy.title} description={copy.description}>
      <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-3 py-3">
          <div className="text-xs text-zinc-400">{copy.p0Sources}</div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={runPreview}
              className="inline-flex items-center gap-1.5 rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            >
              {busy === 'preview' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              {copy.preview}
            </button>
            <button
              type="button"
              disabled={busy !== null || selectedIds.size === 0}
              onClick={apply}
              className="inline-flex items-center gap-1.5 rounded border border-badge-success/40 bg-emerald-500/10 px-3 py-1.5 text-xs text-badge-success disabled:opacity-50"
            >
              {busy === 'apply' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              {copy.confirmImport.replace('{count}', String(selectedIds.size))}
            </button>
          </div>
        </div>

        {message && (
          <div className={`border-b px-3 py-2 text-xs ${message.type === 'success' ? 'text-badge-success' : 'text-badge-danger'}`}>
            {message.text}
          </div>
        )}

        {preview && (
          <div className="space-y-3 p-3">
            <div className="grid grid-cols-2 gap-2 text-xs lg:grid-cols-5">
              {[
                [copy.stats.discovered, preview.summary.discoveredMemory],
                [copy.stats.ready, preview.summary.readyToImport],
                [copy.stats.duplicates, preview.summary.duplicates],
                [copy.stats.archived, preview.summary.archived],
                [copy.stats.instructions, preview.summary.instructionOnly],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded border border-zinc-800 bg-zinc-950/40 p-2">
                  <div className="text-zinc-500">{label}</div>
                  <div className="mt-1 text-base font-semibold text-zinc-200">{value}</div>
                </div>
              ))}
            </div>

            <div className="max-h-64 overflow-auto rounded border border-zinc-800">
              {ready.map((candidate) => (
                <label key={candidate.id} className="flex gap-3 border-b border-zinc-800 px-3 py-2 last:border-b-0">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(candidate.id)}
                    onChange={(event) => {
                      setSelectedIds((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(candidate.id);
                        else next.delete(candidate.id);
                        return next;
                      });
                    }}
                  />
                  <div className="min-w-0">
                    <div className="truncate text-xs text-zinc-200">{candidate.entry.title}</div>
                    <div className="truncate font-mono text-[11px] text-zinc-500">
                      {candidate.entry.source.importProvenance?.sourceHarness} · {candidate.entry.status} · {candidate.entry.source.importProvenance?.sourcePath}
                    </div>
                  </div>
                </label>
              ))}
              {ready.length === 0 && <div className="px-3 py-8 text-center text-xs text-zinc-500">{copy.noCandidates}</div>}
            </div>

            {preview.instructions.length > 0 && (
              <div className="rounded border border-amber-500/20 bg-amber-500/5 p-3">
                <div className="flex items-center gap-2 text-xs font-medium text-badge-warning">
                  <ShieldAlert className="h-4 w-4" />
                  {copy.instructionsTitle.replace('{count}', String(preview.instructions.length))}
                </div>
                <div className="mt-2 space-y-1 text-[11px] text-zinc-500">
                  {preview.instructions.slice(0, 8).map((item) => (
                    <div key={item.id} className="flex items-center justify-between gap-2">
                      <div className="min-w-0 truncate font-mono">{item.sourcePath} · {item.reason}</div>
                      {item.reason === 'directive-confirmation-required' && (
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => confirmDirective(item.id)}
                          className="shrink-0 rounded border border-amber-500/30 px-2 py-1 text-badge-warning disabled:opacity-50"
                        >
                          {busy === `directive:${item.id}` ? copy.confirmingDirective : copy.confirmDirective}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </SettingsSection>
  );
};
