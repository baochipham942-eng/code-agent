import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, History } from 'lucide-react';
import {
  isUndoableImportItem,
  type ImportHistoryEntry,
  type ImportHistoryOutcome,
  type ImportHistorySource,
} from '@shared/contract/importHistory';
import { useI18n } from '../../../../hooks/useI18n';
import { useAppStore } from '../../../../stores/appStore';
import { useSessionStore } from '../../../../stores/sessionStore';
import { useExternalImportHistoryStore } from '../../../../stores/externalImportHistoryStore';
import { formatRelativeTime, localeForLanguage } from '../../../../utils/i18nTime';
import { Button } from '../../../primitives';

type ExternalImportCopy = ReturnType<typeof useI18n>['t']['settings']['externalImport'];

function sourceName(source: ImportHistorySource, copy: ExternalImportCopy): string {
  return source === 'claude_code' || source === 'codex_cli'
    ? copy.chatsImport.engineNames[source]
    : copy.sourceNames[source];
}

function outcomeLabel(outcome: ImportHistoryOutcome, copy: ExternalImportCopy): string {
  return outcome === 'copied' || outcome === 'skipped'
    ? copy.skillActionLabels[outcome]
    : copy.chatsImport.statusLabels[outcome];
}

export const ExternalImportHistory: React.FC = () => {
  const { t } = useI18n();
  const language = useAppStore((state) => state.language);
  const entries = useExternalImportHistoryStore((state) => state.entries);
  const load = useExternalImportHistoryStore((state) => state.load);
  const [listOpen, setListOpen] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const copy = t.settings.externalImport;
  const historyCopy = copy.history;

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section
      data-testid="external-import-history"
      className="rounded-lg border border-zinc-700/70 bg-zinc-900/60 p-3"
      aria-label={historyCopy.title}
    >
      <Button
        variant="ghost"
        size="sm"
        fullWidth
        className="justify-start px-0"
        aria-expanded={listOpen}
        onClick={() => setListOpen((current) => !current)}
        leftIcon={<History className="h-4 w-4" />}
        rightIcon={listOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      >
        {historyCopy.title}
      </Button>
      {listOpen && (
        <div className="mt-2" data-testid="external-import-history-content">
          {entries.length === 0 ? (
            <div className="px-1 py-3 text-xs text-zinc-500" data-testid="external-import-history-empty">
              {historyCopy.empty}
            </div>
          ) : (
            <div className="space-y-1">
              {entries.map((entry) => (
                <HistoryRow
                  key={entry.id}
                  entry={entry}
                  copy={copy}
                  expanded={expandedId === entry.id}
                  onToggle={() => setExpandedId((current) => current === entry.id ? null : entry.id)}
                  absoluteTime={new Date(entry.at).toLocaleString(localeForLanguage(language))}
                  relativeTime={formatRelativeTime(t, entry.at)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
};

function HistoryRow({
  entry,
  copy,
  expanded,
  onToggle,
  absoluteTime,
  relativeTime,
}: {
  entry: ImportHistoryEntry;
  copy: ExternalImportCopy;
  expanded: boolean;
  onToggle: () => void;
  absoluteTime: string;
  relativeTime: string;
}) {
  const historyCopy = copy.history;
  const undo = useExternalImportHistoryStore((state) => state.undo);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const undoable = entry.items.filter((item) => isUndoableImportItem(entry, item)).length;
  const runUndo = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await undo(entry.id);
      setConfirming(false);
      void useSessionStore.getState().loadSessions({ silent: true }).catch(() => {});
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/40" data-testid={`external-import-history-row-${entry.id}`}>
      <Button
        variant="ghost"
        size="sm"
        fullWidth
        className="justify-start gap-2 px-3"
        aria-expanded={expanded}
        onClick={onToggle}
        rightIcon={expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      >
        <span className="min-w-0 flex-1 truncate text-left" title={absoluteTime}>
          {relativeTime} · {sourceName(entry.source, copy)} · {historyCopy.categories[entry.category]} ·{' '}
          {historyCopy.newCount.replace('{count}', String(entry.count))}
        </span>
      </Button>
      {expanded && (
        <div className="space-y-1 border-t border-zinc-800 px-3 py-2" data-testid={`external-import-history-items-${entry.id}`}>
          {entry.items.map((item, index) => (
            <div key={`${item.label}:${index}`} className="truncate text-[11px] text-zinc-500">
              {item.label} · {outcomeLabel(item.outcome, copy)}
            </div>
          ))}
        </div>
      )}
      {entry.undone ? (
        <div className="space-y-0.5 border-t border-zinc-800 px-3 py-2 text-[11px] text-zinc-400" data-testid={`external-import-history-undone-${entry.id}`}>
          <div>
            {historyCopy.undone} · {historyCopy.undoneRemoved.replace('{count}', String(entry.undone.removed))}
            {entry.undone.kept.length > 0 && ` · ${historyCopy.undoneKept.replace('{count}', String(entry.undone.kept.length))}`}
          </div>
          {entry.undone.kept.map((kept, index) => (
            <div key={`${kept.label}:${index}`} className="truncate text-zinc-500">
              {kept.label} · {historyCopy.keptReasons[kept.reason]}
            </div>
          ))}
        </div>
      ) : undoable > 0 && (
        <div className="space-y-2 border-t border-zinc-800 px-3 py-2">
          {confirming ? (
            <>
              <div className="text-[11px] text-zinc-300" data-testid={`external-import-history-undo-confirm-${entry.id}`}>
                {historyCopy.undoConfirm
                  .replace('{chats}', String(entry.category === 'chats' ? undoable : 0))
                  .replace('{skills}', String(entry.category === 'skills' ? undoable : 0))}
              </div>
              {failed && <div className="text-[11px] text-badge-danger">{historyCopy.undoFailed}</div>}
              <div className="flex gap-2">
                <Button variant="danger" size="sm" disabled={busy} onClick={() => void runUndo()}>
                  {historyCopy.undoConfirmAction}
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
                  {historyCopy.undoCancel}
                </Button>
              </div>
            </>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
              {historyCopy.undo}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
