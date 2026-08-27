import React from 'react';
import { useI18n } from '../../../../../hooks/useI18n';
import { useAppStore } from '../../../../../stores/appStore';
import { describeLastToolStep } from '../../../../../utils/agentActivity';
import { openExternalLink } from '../../../../../utils/platform';
import type { DelegationPresentation } from './delegationPresentation';

export function DelegationHeader({ presentation }: { presentation: DelegationPresentation }) {
  const { t } = useI18n();
  const status = t.chat.delegationReceipt[presentation.state];
  return (
    <div className="flex min-w-0 flex-1 items-baseline gap-2">
      <span className="flex-shrink-0 text-xs text-zinc-500">{status}</span>
      <span className="min-w-0 truncate font-semibold text-zinc-200" title={presentation.title}>
        {presentation.title}
      </span>
    </div>
  );
}

export function DelegationReceipt({ presentation }: { presentation: DelegationPresentation }) {
  const { t } = useI18n();
  const openPreview = useAppStore((state) => state.openPreview);

  if (presentation.state === 'working') {
    return (
      <div className="ml-6 mt-0.5 truncate text-xs text-zinc-500" data-testid="delegation-activity">
        {describeLastToolStep(presentation.lastToolStep, t)}
      </div>
    );
  }

  return (
    <div className="ml-6 mt-0.5 space-y-0.5 text-xs text-zinc-500" data-testid="delegation-receipt">
      {presentation.stepCount !== undefined && (
        <div>{t.chat.delegationReceipt.steps.replace('{count}', String(presentation.stepCount))}</div>
      )}
      {presentation.outputs.length > 0 && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span>{t.chat.delegationReceipt.output}</span>
          {presentation.outputs.map((output) => (
            <button
              key={output.id}
              type="button"
              className="max-w-[240px] truncate rounded bg-white/[0.04] px-1.5 py-0.5 text-zinc-300 hover:bg-white/[0.08] hover:text-zinc-100"
              title={output.target}
              onClick={() => {
                if (output.kind === 'file') openPreview(output.target);
                else openExternalLink(output.target);
              }}
            >
              {output.label}
            </button>
          ))}
        </div>
      )}
      {presentation.failure && (
        <div className="line-clamp-2 break-words text-badge-danger" data-testid="delegation-failure">
          {presentation.failure}
        </div>
      )}
    </div>
  );
}
