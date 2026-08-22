import React from 'react';
import { CheckCircle2 } from 'lucide-react';
import type { DeliverablePublishState } from '@shared/contract';
import { useI18n } from '../hooks/useI18n';

export const DeliverablePublishBadge: React.FC<{
  state: DeliverablePublishState;
  testId?: string;
}> = ({ state, testId = 'deliverable-publish-state' }) => {
  const { t } = useI18n();

  if (state.kind === 'draft') {
    return (
      <span
        data-testid={testId}
        className="inline-flex shrink-0 items-center gap-1 rounded border border-zinc-600 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-zinc-500" />
        {t.deliverable.draft}
      </span>
    );
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1" data-testid={testId}>
      <span className="inline-flex items-center gap-1 rounded border border-teal-500/60 bg-teal-500/10 px-1.5 py-0.5 text-[10px] font-medium text-badge-success">
        <CheckCircle2 className="h-3 w-3" />
        {t.deliverable.publishedVersion.replace('{version}', String(state.version))}
      </span>
      {state.kind === 'published-dirty' && (
        <span className="inline-flex items-center gap-1 rounded bg-amber-500/12 px-1.5 py-0.5 text-[10px] font-medium text-badge-warning">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
          {t.deliverable.unpublishedChanges}
        </span>
      )}
    </span>
  );
};
