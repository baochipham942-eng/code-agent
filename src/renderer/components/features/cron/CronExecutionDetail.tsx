import React, { useState } from 'react';
import type { CronJobDefinition, CronJobExecution } from '@shared/contract';
import { classifyCronFailure, type CronFailurePresentationKind } from '@shared/utils/cronFailureClassification';
import { ExternalLink, MessageSquareText } from 'lucide-react';
import { useI18n } from '../../../hooks/useI18n';
import { useAppStore } from '../../../stores/appStore';
import { useCronStore } from '../../../stores/cronStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { Button } from '../../primitives/Button';
import {
  formatDateTime,
  formatDuration,
  getExecutionStatusMeta,
  prettyJson,
} from './types';
import { CronRunsOnPill } from './CronRunsOnSelector';
import { cronLoginWallCopy, openCronLoginWallSite } from './cronLoginWallNotice';
import { cronFailureSentence } from './cronFailureNotice';

const CLOUD_NOT_WIRED = 'Cloud execution is not wired yet (N-L3-MINLOOP-SRV).';
const BUDGET_LIMIT = /Cron job run exceeded its \$(\d+(?:\.\d+)?) budget limit\./;

function failureAction(kind: CronFailurePresentationKind): 'model' | 'account' | 'rerun' | null {
  if (kind === 'quota') return 'model';
  if (kind === 'auth') return 'account';
  if (kind === 'rate_limit' || kind === 'timeout' || kind === 'network') return 'rerun';
  return null;
}

interface CronExecutionDetailProps {
  execution: CronJobExecution | null;
  runsOn?: CronJobDefinition['runsOn'];
}

export const CronExecutionDetail: React.FC<CronExecutionDetailProps> = ({ execution, runsOn = 'local' }) => {
  const { t, language } = useI18n();
  const cc = t.cronCenter;
  const switchSession = useSessionStore((state) => state.switchSession);
  const setShowCronCenter = useAppStore((state) => state.setShowCronCenter);
  const [isOpeningSession, setIsOpeningSession] = useState(false);
  const [isRerunning, setIsRerunning] = useState(false);

  if (!execution) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 text-sm text-zinc-500">
        {cc.execSelectHint}
      </div>
    );
  }

  const statusMeta = getExecutionStatusMeta(execution.status);
  const loginWall = cronLoginWallCopy(execution.error, { error: cc.loginWallError });
  const budgetAmount = execution.error?.match(BUDGET_LIMIT)?.[1];
  const preservedError = loginWall?.message
    ?? (execution.error === 'unsupported_action' ? cc.unsupportedAction
      : execution.error === CLOUD_NOT_WIRED ? cc.cloudExecutionNotWired
        : budgetAmount ? cc.runBudgetExceeded.replace('{amount}', budgetAmount) : undefined);
  const classified = preservedError || !execution.error ? undefined : classifyCronFailure(execution.error);
  const failureSentence = classified
    ? cronFailureSentence(classified.kind, classified, cc, language)
    : undefined;
  const action = classified ? failureAction(classified.kind) : null;
  const handleRerun = async () => {
    if (isRerunning) return;
    setIsRerunning(true);
    try {
      await useCronStore.getState().triggerJob(execution.jobId);
    } finally {
      setIsRerunning(false);
    }
  };
  const handleOpenSession = async () => {
    if (!execution.sessionId || isOpeningSession) return;
    setIsOpeningSession(true);
    try {
      await switchSession(execution.sessionId);
      setShowCronCenter(false);
    } finally {
      setIsOpeningSession(false);
    }
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h4 className="text-sm font-medium text-zinc-100">{cc.execDetailTitle}</h4>
          <p className="mt-1 text-xs text-zinc-500">{execution.id}</p>
        </div>
        <div className="flex items-center gap-2">
          {execution.sessionId && (
            <button
              type="button"
              onClick={handleOpenSession}
              disabled={isOpeningSession}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-300 transition-colors hover:border-zinc-700 hover:bg-zinc-800 disabled:opacity-50"
            >
              <MessageSquareText className="h-3.5 w-3.5" />
              {isOpeningSession ? cc.execOpeningSession : cc.execOpenSession}
            </button>
          )}
          <span className={`rounded-full px-2.5 py-1 text-xs ${statusMeta.className}`}>
            {cc.status[execution.status]}
          </span>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Info label={cc.execSession} value={execution.sessionId || '—'} />
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3">
          <div className="text-xs text-zinc-500">{cc.execLocation}</div>
          <div className="mt-1">
            <CronRunsOnPill runsOn={runsOn} localLabel={cc.locationLocal} cloudLabel={cc.locationCloud} />
          </div>
        </div>
        {execution.trigger?.kind === 'event' && (
          // 事件 run 的触发源标签（N-TRIGGER-CONNECTOR-MAIL）：channel = 通道消息，connector:mail = 邮件。
          <Info
            label={cc.execTriggerSource}
            value={execution.trigger.source === 'connector' ? cc.triggerSourceMail : cc.triggerSourceChannel}
            testId="cron-exec-trigger-source"
          />
        )}
        <Info label={cc.colScheduledAt} value={formatDateTime(execution.scheduledAt)} />
        <Info label={cc.colStartedAt} value={formatDateTime(execution.startedAt)} />
        <Info label={cc.execCompletedAt} value={formatDateTime(execution.completedAt)} />
        <Info label={cc.colDuration} value={formatDuration(execution.duration)} />
        <Info label={cc.execRetryCount} value={String(execution.retryAttempt)} />
        <Info label={cc.colExitCode} value={execution.exitCode != null ? String(execution.exitCode) : '—'} />
      </div>

      {preservedError && (
        <section className="mt-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h5 className="text-xs font-medium uppercase tracking-wide text-badge-danger">{cc.execError}</h5>
            {loginWall && (
              <div className="flex items-center gap-2">
                <button /* ds-allow:button: 错误区标题旁紧凑警示色链接按钮（px-2 py-1 text-xs），primitive 无警示色 variant 且最小 sm 内边距更大 */
                  type="button"
                  onClick={() => openCronLoginWallSite(loginWall.siteOrigin, execution.jobId)}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-badge-warning transition-colors hover:bg-amber-500/10"
                  data-testid="cron-execution-open-login-site"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {cc.loginWallOpenSite}
                </button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  loading={isRerunning}
                  data-testid="cron-login-wall-rerun"
                  onClick={() => { void handleRerun(); }}
                >
                  {cc.failureActionRunAgain}
                </Button>
              </div>
            )}
          </div>
          <pre className="max-h-40 overflow-auto rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-badge-danger whitespace-pre-wrap">
            {preservedError}
          </pre>
        </section>
      )}

      {failureSentence && (
        <section className="mt-4" data-testid="cron-failure-plain">
          <h5 className="mb-2 text-xs font-medium uppercase tracking-wide text-badge-danger">{cc.execError}</h5>
          <p className="text-sm text-zinc-100" data-testid="cron-failure-sentence">{failureSentence}</p>
          {action === 'model' && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="mt-3"
              data-testid="cron-failure-action"
              onClick={() => useAppStore.getState().openSettingsTab('model')}
            >
              {cc.failureActionSwitchModel}
            </Button>
          )}
          {action === 'account' && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="mt-3"
              data-testid="cron-failure-action"
              onClick={() => useAppStore.getState().openSettingsTab('model')}
            >
              {cc.failureActionCheckAccount}
            </Button>
          )}
          {action === 'rerun' && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="mt-3"
              data-testid="cron-failure-action"
              loading={isRerunning}
              onClick={() => { void handleRerun(); }}
            >
              {cc.failureActionRunAgain}
            </Button>
          )}
          <details className="mt-3" data-testid="cron-failure-technical">
            <summary className="cursor-pointer text-xs text-zinc-400">{cc.failureTechnical}</summary>
            <pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-400 whitespace-pre-wrap">
              {execution.error}
            </pre>
          </details>
        </section>
      )}

      <section className="mt-4">
        <h5 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">{cc.execResult}</h5>
        <pre className="max-h-56 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-300 whitespace-pre-wrap">
          {prettyJson(execution.result)}
        </pre>
      </section>
    </div>
  );
};

const Info: React.FC<{ label: string; value: string; testId?: string }> = ({ label, value, testId }) => (
  <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3" data-testid={testId}>
    <div className="text-xs text-zinc-500">{label}</div>
    <div className="mt-1 text-sm text-zinc-200">{value}</div>
  </div>
);

export default CronExecutionDetail;
