import React, { useEffect, useState } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import { useI18n } from '../../../../hooks/useI18n';
import ipcService from '../../../../services/ipcService';
import { useExternalImportHistoryStore } from '../../../../stores/externalImportHistoryStore';
import { Button, Toggle } from '../../../primitives';

interface PendingInstructionRule {
  instructionId: string;
  content: string;
  contentHash: string;
}

interface InstructionsSyncState {
  mode: 'off' | 'on' | 'paused';
  available: boolean;
  pending: PendingInstructionRule[];
  lastRun?: { at: number; pending: number; keptNeo: number };
}

interface InstructionsSyncConfirmResult {
  confirmation: {
    confirmed: boolean;
    imported: boolean;
    notConfirmedReason?: 'declined' | 'timeout' | 'headless-no-ui';
  };
  state: InstructionsSyncState;
}

type RowState = 'pending' | 'imported' | 'declined' | 'headless' | 'failed';

const EMPTY_STATE: InstructionsSyncState = {
  mode: 'off',
  available: false,
  pending: [],
};

export const ExternalInstructionsSyncSection: React.FC = () => {
  const { t } = useI18n();
  const copy = t.settings.externalImport.instructionsSync;
  const [sync, setSync] = useState<InstructionsSyncState>(EMPTY_STATE);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});

  useEffect(() => {
    let alive = true;
    ipcService
      .invokeDomain<InstructionsSyncState>(IPC_DOMAINS.AGENT_ENGINE, 'getInstructionsSync')
      .then((state) => { if (alive && state) setSync(state); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const changeSync = async (mode: InstructionsSyncState['mode']): Promise<void> => {
    setBusy('mode');
    setFailed(false);
    try {
      const next = await ipcService.invokeDomain<InstructionsSyncState>(
        IPC_DOMAINS.AGENT_ENGINE,
        'setInstructionsSync',
        { mode },
      );
      if (next) setSync(next);
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  const confirmItem = async (item: PendingInstructionRule): Promise<void> => {
    setBusy(item.instructionId);
    setFailed(false);
    try {
      const result = await ipcService.invokeDomain<InstructionsSyncConfirmResult>(
        IPC_DOMAINS.AGENT_ENGINE,
        'confirmInstructionsSyncItem',
        { instructionId: item.instructionId },
      );
      if (!result) return;
      const rowState: RowState = result.confirmation.imported
        ? 'imported'
        : result.confirmation.notConfirmedReason === 'headless-no-ui'
          ? 'headless'
          : result.confirmation.confirmed
            ? 'imported'
            : 'declined';
      setRowStates((current) => ({ ...current, [item.instructionId]: rowState }));
      if (result.confirmation.imported) {
        void useExternalImportHistoryStore.getState().load();
      }
    } catch {
      setRowStates((current) => ({ ...current, [item.instructionId]: 'failed' }));
    } finally {
      setBusy(null);
    }
  };

  const status = !sync.available
    ? copy.statusUnavailable
    : sync.mode === 'paused'
      ? copy.statusPaused
      : sync.mode === 'on'
        ? (sync.pending.length > 0
          ? copy.statusNew.replace('{count}', String(sync.pending.length))
          : copy.statusOnEmpty)
        : copy.statusOff;
  const keptNeo = sync.mode === 'on' ? (sync.lastRun?.keptNeo ?? 0) : 0;

  return (
    <div
      data-testid="external-instructions-sync"
      className="rounded-lg border border-zinc-700/70 bg-zinc-900/60 p-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-zinc-200">{copy.title}</div>
          <div className="mt-1 text-xs text-zinc-500">{copy.description}</div>
          <div className="mt-1 text-xs text-zinc-400" data-testid="external-instructions-sync-status">
            {status}
          </div>
          {keptNeo > 0 && (
            <div className="mt-1 text-xs text-zinc-500" data-testid="external-instructions-sync-kept-neo">
              {copy.keptNeoLine.replace('{count}', String(keptNeo))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {sync.available && sync.mode !== 'off' && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy !== null}
              onClick={() => void changeSync(sync.mode === 'paused' ? 'on' : 'paused')}
            >
              {sync.mode === 'paused' ? copy.resume : copy.pause}
            </Button>
          )}
          <Toggle
            checked={sync.mode === 'on'}
            disabled={!sync.available || busy !== null}
            aria-label={copy.toggleLabel}
            onChange={(checked) => void changeSync(checked ? 'on' : 'off')}
          />
        </div>
      </div>

      {sync.mode === 'on' && sync.pending.length > 0 && (
        <div className="mt-3 space-y-2" data-testid="external-instructions-sync-list">
          {sync.pending.map((item) => {
            const rowState = rowStates[item.instructionId] ?? 'pending';
            return (
              <div
                key={item.instructionId}
                className="flex items-start justify-between gap-3 rounded border border-zinc-800 bg-zinc-950/40 px-2 py-2"
              >
                <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs text-zinc-200">
                  {item.content}
                </div>
                {busy === item.instructionId ? (
                  <span className="shrink-0 text-[11px] text-zinc-500">{copy.confirming}</span>
                ) : rowState === 'imported' ? (
                  <span className="shrink-0 text-[11px] text-badge-success">{copy.imported}</span>
                ) : rowState === 'declined' ? (
                  <span className="shrink-0 text-[11px] text-zinc-500">{copy.declined}</span>
                ) : rowState === 'headless' ? (
                  <span className="shrink-0 text-[11px] text-zinc-500">{copy.headless}</span>
                ) : rowState === 'failed' ? (
                  <span className="shrink-0 text-[11px] text-badge-danger">{copy.confirmFailed}</span>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void confirmItem(item)}
                  >
                    {copy.importThis}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {failed && (
        <div className="mt-2 text-xs text-badge-danger" data-testid="external-instructions-sync-error">
          {copy.failed}
        </div>
      )}
    </div>
  );
};
