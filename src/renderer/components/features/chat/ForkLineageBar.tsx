import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, GitBranch, GitFork } from 'lucide-react';

import type { SessionForkLineageSummary } from '@shared/contract/sessionFork';
import type { ConversationBranchComparison } from '@shared/contract/conversationBranch';
import { IPC_DOMAINS } from '@shared/ipc';
import { useI18n } from '../../../hooks/useI18n';
import ipcService from '../../../services/ipcService';
import { useSessionStore } from '../../../stores/sessionStore';
import { BranchHistoryPanel } from './BranchHistoryPanel';

interface ForkLineageNavigationProps {
  sessionId: string;
  lineage: SessionForkLineageSummary | null;
  children: SessionForkLineageSummary[];
  onOpenSession: (sessionId: string) => void | Promise<void>;
  comparison?: ConversationBranchComparison | null;
  compareLoading?: boolean;
  compareError?: boolean;
  onCompareParent?: () => void | Promise<void>;
  historyExpanded?: boolean;
  onToggleHistory?: () => void;
}

export const ForkLineageNavigation: React.FC<ForkLineageNavigationProps> = ({
  sessionId,
  lineage,
  children,
  onOpenSession,
  comparison,
  compareLoading = false,
  compareError = false,
  onCompareParent,
  historyExpanded = false,
  onToggleHistory,
}) => {
  const { t } = useI18n();
  if (!lineage && children.length === 0) return null;

  return (
    <nav
      aria-label={t.forkLineage.navigation}
      className="mx-4 mt-2 flex min-h-8 items-center gap-2 overflow-x-auto rounded-lg border border-violet-500/20 bg-violet-500/5 px-2.5 py-1.5 text-xs text-zinc-400"
      data-testid="fork-lineage-navigation"
    >
      <GitBranch className="h-3.5 w-3.5 shrink-0 text-violet-400" />
      <span className="shrink-0 text-violet-300">
        {lineage
          ? t.forkLineage.depth.replace('{depth}', String(lineage.depth))
          : t.forkLineage.source}
      </span>
      {lineage && lineage.parentSessionId !== sessionId && (
        <>
          {lineage.parentDeleted ? (
            <span className="shrink-0 text-zinc-500" data-testid="fork-parent-deleted">
              {t.forkLineage.parentDeleted}
            </span>
          ) : (
            <button
              type="button"
              className="shrink-0 rounded-md border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:border-violet-500/50 hover:text-violet-200"
              onClick={() => void onOpenSession(lineage.parentSessionId)}
            >
              {t.forkLineage.openParent}
            </button>
          )}
          {!lineage.parentDeleted && onCompareParent && (
            <button
              type="button"
              className="shrink-0 rounded-md border border-violet-500/30 px-2 py-0.5 text-violet-300 hover:border-violet-400 hover:text-violet-100 disabled:opacity-50"
              disabled={compareLoading}
              onClick={() => void onCompareParent()}
            >
              {compareLoading ? t.forkLineage.comparing : t.forkLineage.compareParent}
            </button>
          )}
        </>
      )}
      {children.map((child, index) => (
        <button
          key={child.forkId}
          type="button"
          className="flex shrink-0 items-center gap-1 rounded-md border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:border-violet-500/50 hover:text-violet-200"
          onClick={() => void onOpenSession(child.childSessionId)}
        >
          <GitFork className="h-3 w-3 text-violet-400" />
          {t.forkLineage.openChild.replace('{index}', String(index + 1))}
        </button>
      ))}
      <span className="ml-auto shrink-0 text-zinc-500">
        {(lineage?.workspaceMode ?? children[0]?.workspaceMode) === 'isolated_at_anchor'
          ? t.forkLineage.anchorWorkspace
          : t.forkLineage.currentWorkspace}
      </span>
      {comparison && (
        <span className="shrink-0 text-violet-200" data-testid="fork-branch-comparison">
          {t.forkLineage.compareSummary
            .replace('{shared}', String(comparison.sharedPrefixLength))
            .replace('{current}', String(comparison.rightOnly.length))
            .replace('{parent}', String(comparison.leftOnly.length))}
        </span>
      )}
      {compareError && (
        <span className="shrink-0 text-red-300">{t.forkLineage.compareFailed}</span>
      )}
      {onToggleHistory && (
        <button
          type="button"
          aria-expanded={historyExpanded}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-violet-500/30 px-2 py-0.5 text-violet-300 hover:border-violet-400 hover:text-violet-100"
          onClick={onToggleHistory}
        >
          {historyExpanded
            ? <ChevronUp className="h-3 w-3" />
            : <ChevronDown className="h-3 w-3" />}
          {historyExpanded ? t.forkLineage.historyClose : t.forkLineage.historyOpen}
        </button>
      )}
    </nav>
  );
};

export const ForkLineageBar: React.FC<{ sessionId: string | null }> = ({ sessionId }) => {
  const [lineage, setLineage] = useState<SessionForkLineageSummary | null>(null);
  const [children, setChildren] = useState<SessionForkLineageSummary[]>([]);
  const [comparison, setComparison] = useState<ConversationBranchComparison | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const projectId = useSessionStore((state) =>
    state.sessions.find((session) => session.id === sessionId)?.projectId ?? null);

  useEffect(() => {
    let disposed = false;
    setLineage(null);
    setChildren([]);
    setComparison(null);
    setCompareError(false);
    if (!sessionId) return () => {
      disposed = true;
    };

    void Promise.all([
      ipcService.invokeDomain<SessionForkLineageSummary | null>(
        IPC_DOMAINS.SESSION,
        'getForkLineage',
        { sessionId },
      ),
      ipcService.invokeDomain<SessionForkLineageSummary[]>(
        IPC_DOMAINS.SESSION,
        'listForkChildren',
        { sessionId },
      ),
    ]).then(([nextLineage, nextChildren]) => {
      if (disposed) return;
      setLineage(nextLineage);
      setChildren(nextChildren);
    }).catch(() => {
      if (disposed) return;
      setLineage(null);
      setChildren([]);
    });

    return () => {
      disposed = true;
    };
  }, [sessionId]);

  if (!sessionId) return null;
  return (
    <>
      <ForkLineageNavigation
        sessionId={sessionId}
        lineage={lineage}
        children={children}
        onOpenSession={(targetSessionId) => useSessionStore.getState().switchSession(targetSessionId)}
        comparison={comparison}
        compareLoading={compareLoading}
        compareError={compareError}
        onCompareParent={lineage && !lineage.parentDeleted ? async () => {
          setCompareLoading(true);
          setCompareError(false);
          try {
            const next = await ipcService.invokeDomain<ConversationBranchComparison>(
              IPC_DOMAINS.SESSION,
              'compareConversationBranches',
              {
                leftSessionId: lineage.parentSessionId,
                rightSessionId: sessionId,
              },
            );
            setComparison(next);
          } catch {
            setComparison(null);
            setCompareError(true);
          } finally {
            setCompareLoading(false);
          }
        } : undefined}
        historyExpanded={historyExpanded}
        onToggleHistory={() => setHistoryExpanded((expanded) => !expanded)}
      />
      {historyExpanded && (lineage || children.length > 0) && (
        <BranchHistoryPanel
          key={sessionId}
          sessionId={sessionId}
          projectId={projectId}
          onOpenSession={(targetSessionId) => useSessionStore.getState().switchSession(targetSessionId)}
        />
      )}
    </>
  );
};
