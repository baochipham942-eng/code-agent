// ============================================================================
// Cron/heartbeat assistant text: hide snapshot blocks, show alert bodies
// without tags, and render each summary as a small card (no urgency line).
// ============================================================================

import React, { useMemo } from 'react';
import { resolveCronArtifactsForReview } from '@shared/cronArtifactPath';
import { splitCronRunMessage } from '@shared/cronRunMessage';
import { useAppStore } from '../../../../stores/appStore';
import { useSessionStore } from '../../../../stores/sessionStore';
import { useI18n } from '../../../../hooks/useI18n';
import { CronArtifactRows } from '../../cron/CronArtifactRows';

export function useIsCronRunSession(sessionId: string | undefined): boolean {
  return useSessionStore((state) => {
    const id = sessionId || state.currentSessionId;
    if (!id) return false;
    const kind = state.sessions?.find((session) => session.id === id)?.origin?.kind;
    return kind === 'cron' || kind === 'heartbeat';
  });
}

function useRunWorkingDirectory(sessionId: string | undefined): string | undefined {
  const fromSession = useSessionStore((state) => {
    const id = sessionId || state.currentSessionId;
    if (!id) return undefined;
    return state.sessions?.find((session) => session.id === id)?.workingDirectory;
  });
  const fromApp = useAppStore((state) => state.workingDirectory);
  return fromSession || fromApp || undefined;
}

const CronRunSummaryCard: React.FC<{
  text: string;
  artifacts: ReturnType<typeof resolveCronArtifactsForReview>;
  renderSlice: (text: string) => React.ReactNode;
}> = ({ text, artifacts, renderSlice }) => {
  const { t } = useI18n();
  return (
    <div
      className="mt-2 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2"
      data-testid="cron-run-summary"
    >
      <div className="text-[11px] font-medium text-zinc-400">{t.cronCenter.runSummaryTitle}</div>
      {text ? <div className="mt-1">{renderSlice(text)}</div> : null}
      {artifacts.length > 0 && <CronArtifactRows artifacts={artifacts} />}
    </div>
  );
};

export const CronRunMessageFrame: React.FC<{
  source: string;
  sessionId?: string;
  renderSlice: (text: string) => React.ReactNode;
}> = ({ source, sessionId, renderSlice }) => {
  const cwd = useRunWorkingDirectory(sessionId);
  const segments = useMemo(() => splitCronRunMessage(source), [source]);
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === 'summary') {
          return (
            <CronRunSummaryCard
              key={`summary-${index}`}
              text={segment.text}
              artifacts={resolveCronArtifactsForReview(segment.artifacts, cwd)}
              renderSlice={renderSlice}
            />
          );
        }
        if (!segment.text.trim()) return null;
        return (
          <div
            key={`${segment.kind}-${index}`}
            data-testid={segment.kind === 'alert' ? 'cron-alert-body' : undefined}
          >
            {renderSlice(segment.text)}
          </div>
        );
      })}
    </>
  );
};
