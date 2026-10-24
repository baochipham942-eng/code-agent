// ============================================================================
// Cron artifact rows — inbox digest and the run-summary card share this list.
// Desktop: name opens the file, the row action reveals it. Web: both copy the
// path and toast. A rejected IPC marks that row "file moved" and does not toast.
// ============================================================================

import React, { useState } from 'react';
import { Folder } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import { cronArtifactFileName, type CronStoredArtifact } from '@shared/cronArtifactPath';
import ipcService from '../../../services/ipcService';
import { copyPathToClipboard, isWebMode } from '../../../utils/platform';
import { useI18n } from '../../../hooks/useI18n';
import { toast } from '../../../hooks/useToast';
import { GhostButton } from '../../primitives';

async function copyArtifactPath(filePath: string, copiedMessage: string): Promise<void> {
  const copied = await copyPathToClipboard(filePath);
  if (copied) toast.success(copiedMessage);
}

export const CronArtifactRows: React.FC<{ artifacts: readonly CronStoredArtifact[] }> = ({ artifacts }) => {
  const { t } = useI18n();
  const cc = t.cronCenter;
  const [movedPaths, setMovedPaths] = useState<ReadonlySet<string>>(new Set());

  const openOrCopy = async (artifact: CronStoredArtifact, action: 'openPath' | 'showItemInFolder') => {
    if (!artifact.openable) return;
    if (isWebMode()) {
      await copyArtifactPath(artifact.path, cc.inboxDigestPathCopied);
      return;
    }
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.WORKSPACE, action, { filePath: artifact.path });
    } catch {
      setMovedPaths((current) => {
        const next = new Set(current);
        next.add(artifact.path);
        return next;
      });
    }
  };

  return (
    <div className="mt-1 space-y-0.5" data-testid="cron-artifact-list">
      {artifacts.map((artifact) => {
        const moved = movedPaths.has(artifact.path);
        const name = cronArtifactFileName(artifact.path);
        return (
          <div
            key={artifact.path}
            className={`flex min-w-0 items-center gap-1 ${moved ? 'opacity-60' : ''}`}
            data-testid="cron-artifact-row"
            data-moved={moved ? 'true' : 'false'}
          >
            {artifact.openable && !moved ? (
              <GhostButton
                type="button"
                size="sm"
                title={artifact.path}
                data-testid="cron-artifact-open"
                className="h-auto min-w-0 flex-1 justify-start px-1 py-0 text-left text-[11px]"
                onClick={() => { void openOrCopy(artifact, 'openPath'); }}
              >
                <span className="truncate">{name}</span>
              </GhostButton>
            ) : (
              <span
                className="min-w-0 flex-1 truncate px-1 text-[11px] text-zinc-500"
                title={artifact.path}
                data-testid="cron-artifact-text"
              >
                {name}
              </span>
            )}
            {moved ? (
              <span className="shrink-0 text-[11px] text-zinc-500" data-testid="cron-artifact-moved">
                {cc.inboxDigestFileMoved}
              </span>
            ) : artifact.openable ? (
              <GhostButton
                type="button"
                size="sm"
                title={cc.inboxDigestShowInFolder}
                aria-label={cc.inboxDigestShowInFolder}
                data-testid="cron-artifact-reveal"
                className="h-auto shrink-0 px-1 py-0 text-[11px]"
                leftIcon={<Folder className="h-3 w-3" />}
                onClick={() => { void openOrCopy(artifact, 'showItemInFolder'); }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
};
