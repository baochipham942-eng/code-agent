// ============================================================================
// Inbox digest line. Records that stored artifact paths expand into file rows.
// Older records (count only) stay a plain "{count} artifacts" line.
// ============================================================================

import React, { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { SessionAutomationConfig } from '@shared/contract';
import type { CronStoredArtifact } from '@shared/cronArtifactPath';
import { useI18n } from '../../../hooks/useI18n';
import { GhostButton } from '../../primitives';
import { CronArtifactRows } from './CronArtifactRows';

type ReviewDigest = NonNullable<NonNullable<SessionAutomationConfig['pendingReview']>['digest']>;

function storedArtifacts(digest: ReviewDigest): CronStoredArtifact[] {
  if (!Array.isArray(digest.artifacts)) return [];
  const stored: CronStoredArtifact[] = [];
  for (const item of digest.artifacts) {
    if (!item || typeof item.path !== 'string' || !item.path.trim()) continue;
    stored.push({ path: item.path, openable: item.openable === true });
  }
  return stored;
}

export const CronReviewDigest: React.FC<{
  digest: ReviewDigest;
  trailing?: React.ReactNode;
}> = ({ digest, trailing }) => {
  const { t } = useI18n();
  const cc = t.cronCenter;
  const artifacts = storedArtifacts(digest);
  const [open, setOpen] = useState(false);
  const label = cc.inboxDigestArtifacts.replace('{count}', String(digest.artifactCount));

  return (
    <div data-testid="automation-review-digest">
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-zinc-500">
        {artifacts.length > 0 ? (
          <GhostButton
            type="button"
            size="sm"
            data-testid="automation-review-digest-toggle"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            leftIcon={<ChevronRight className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`} />}
            className="h-auto shrink-0 px-1 py-0 text-[11px]"
          >
            {label}
          </GhostButton>
        ) : (
          <span className="shrink-0">{label}</span>
        )}
        {digest.summaryLine && (
          <span className="min-w-0 truncate">· {digest.summaryLine}</span>
        )}
        {trailing}
      </div>
      {open && artifacts.length > 0 && <CronArtifactRows artifacts={artifacts} />}
    </div>
  );
};
