import React, { useEffect, useState } from 'react';
import { GitBranch, GitFork } from 'lucide-react';

import type { SessionForkLineageSummary } from '@shared/contract/sessionFork';
import { IPC_DOMAINS } from '@shared/ipc';
import { useI18n } from '../../../hooks/useI18n';
import ipcService from '../../../services/ipcService';
import { useSessionStore } from '../../../stores/sessionStore';

interface ForkLineageNavigationProps {
  sessionId: string;
  lineage: SessionForkLineageSummary | null;
  children: SessionForkLineageSummary[];
  onOpenSession: (sessionId: string) => void | Promise<void>;
}

export const ForkLineageNavigation: React.FC<ForkLineageNavigationProps> = ({
  sessionId,
  lineage,
  children,
  onOpenSession,
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
        <button
          type="button"
          className="shrink-0 rounded-md border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:border-violet-500/50 hover:text-violet-200"
          onClick={() => void onOpenSession(lineage.parentSessionId)}
        >
          {t.forkLineage.openParent}
        </button>
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
    </nav>
  );
};

export const ForkLineageBar: React.FC<{ sessionId: string | null }> = ({ sessionId }) => {
  const [lineage, setLineage] = useState<SessionForkLineageSummary | null>(null);
  const [children, setChildren] = useState<SessionForkLineageSummary[]>([]);

  useEffect(() => {
    let disposed = false;
    setLineage(null);
    setChildren([]);
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
    <ForkLineageNavigation
      sessionId={sessionId}
      lineage={lineage}
      children={children}
      onOpenSession={(targetSessionId) => useSessionStore.getState().switchSession(targetSessionId)}
    />
  );
};
