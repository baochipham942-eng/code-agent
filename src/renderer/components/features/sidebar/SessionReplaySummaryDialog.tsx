import React from 'react';
import { X } from 'lucide-react';
import { IconButton, Modal } from '../../primitives';
import { Z_LAYERS } from '../../../styles/zLayers';
import type { StructuredReplay } from '@shared/contract/evaluation';
import {
  evaluateAgentTrajectoryReplay,
  resolveAgentTrajectoryCollectionMetadata,
} from '@shared/contract/agentTrajectory';
import type {
  AgentTrajectoryDatasetRole,
  AgentTrajectorySessionQualitySummary,
} from '@shared/contract/agentTrajectory';
import type { Task } from '@shared/contract/backgroundTask';
import type { ScriptRunSnapshot } from '@shared/contract/scriptRun';
import { useI18n } from '../../../hooks/useI18n';
import type { SessionReplayEvidence } from '../../../utils/sessionReplayEvidence';
import {
  TRAJECTORY_DATASET_ROLE_OPTIONS,
  formatBackgroundTaskMeta,
  formatBlockDetail,
  formatBlockLabel,
  formatDuration,
  formatEvidenceControlTitle,
  formatEvidenceLabel,
  formatTaskEventDetail,
  formatTaskEventLabel,
  formatTaskOutputRef,
  formatTaskStatus,
  formatToolDistribution,
  formatWorkflowAgentBody,
  formatWorkflowAgentDetail,
  formatWorkflowAgentStatus,
  formatWorkflowAgentSummary,
  formatWorkflowRunMeta,
  formatWorkflowStatus,
  getBackgroundEvidenceTaskId,
  getBackgroundTaskSortTime,
  getBlockToneClassName,
  getEvidenceControlToneClassName,
  getFocusedReplayOwnerKey,
  getTrajectoryDatasetLabel,
  getTrajectoryTaskKindLabel,
  getTrajectoryTierToneClassName,
  getTurnSummary,
  getWorkflowEvidenceRunId,
  getWorkflowSortTime,
  groupEvidenceByOwner,
  shouldRenderBlockDetail,
  truncateContent,
  type FocusedReplayOwner,
  type SessionReplayLabels,
} from './sessionReplayFormatters';

export interface SessionReplaySummaryDialogProps {
  sessionTitle: string;
  replay: StructuredReplay;
  workflowRuns?: ScriptRunSnapshot[];
  backgroundTasks?: Task[];
  evidence?: SessionReplayEvidence[];
  trajectorySummary?: AgentTrajectorySessionQualitySummary;
  onUpdateTrajectoryDatasetRole?: (datasetRole: AgentTrajectoryDatasetRole) => void | Promise<void>;
  onOpenEvidence?: (evidence: SessionReplayEvidence) => void | Promise<void>;
  onClose: () => void;
}

function renderEvidenceChip(
  item: SessionReplayEvidence,
  labels: SessionReplayLabels,
  onOpenEvidence?: (evidence: SessionReplayEvidence) => void | Promise<void>,
): React.ReactElement {
  const label = formatEvidenceLabel(item);
  const className = 'rounded border border-zinc-700/60 bg-zinc-900/60 px-1.5 py-0.5 text-[10px] text-zinc-400';
  if (!onOpenEvidence || item.actionKind === 'sessionReplay') {
    return (
      <span key={item.id} title={item.title} className={className}>
        {label}
      </span>
    );
  }
  return (
    <button
      key={item.id}
      type="button"
      title={item.title}
      aria-label={labels.dialog.openEvidenceAria.replace('{label}', label)}
      onClick={(event) => {
        event.preventDefault();
        void onOpenEvidence(item);
      }}
      className={`${className} transition-colors hover:border-zinc-600 hover:bg-zinc-800 hover:text-zinc-200 focus:outline-hidden`}
    >
      {label}
    </button>
  );
}

export const SessionReplaySummaryDialog: React.FC<SessionReplaySummaryDialogProps> = ({
  sessionTitle,
  replay,
  workflowRuns = [],
  backgroundTasks = [],
  evidence = [],
  trajectorySummary,
  onUpdateTrajectoryDatasetRole,
  onOpenEvidence,
  onClose,
}) => {
  const { t } = useI18n();
  const labels = t.sessionReplay;
  const [focusedReplayOwner, setFocusedReplayOwner] = React.useState<FocusedReplayOwner | null>(null);
  const [updatingDatasetRole, setUpdatingDatasetRole] = React.useState<AgentTrajectoryDatasetRole | null>(null);
  const completeness = replay.summary.telemetryCompleteness;
  const replayTrajectoryQuality = React.useMemo(() => evaluateAgentTrajectoryReplay(replay), [replay]);
  const trajectoryQuality = trajectorySummary?.quality ?? replayTrajectoryQuality;
  const trajectoryCollection =
    trajectorySummary?.collection ?? resolveAgentTrajectoryCollectionMetadata(trajectoryQuality, undefined);
  const evidenceControl = replay.summary.evidenceControl ?? trajectorySummary?.evidenceControl;
  const incompleteReasons = completeness?.incompleteReasons ?? [];
  const issueCount = replay.summary.deviations?.length ?? 0;
  const visibleTurns = replay.turns.slice(0, 8);
  const hiddenTurnCount = Math.max(0, replay.turns.length - visibleTurns.length);
  const workflowEvidenceByRunId = groupEvidenceByOwner(evidence, getWorkflowEvidenceRunId);
  const backgroundEvidenceByTaskId = groupEvidenceByOwner(evidence, getBackgroundEvidenceTaskId);
  const sortedWorkflowRuns = [...workflowRuns].sort((a, b) => getWorkflowSortTime(b) - getWorkflowSortTime(a));
  const sortedBackgroundTasks = [...backgroundTasks].sort(
    (a, b) => getBackgroundTaskSortTime(b) - getBackgroundTaskSortTime(a),
  );
  const visibleWorkflowRuns = sortedWorkflowRuns.slice(0, 3);
  const visibleBackgroundTasks = sortedBackgroundTasks.slice(0, 3);
  const attachedEvidenceIds = new Set<string>();
  for (const snapshot of visibleWorkflowRuns) {
    for (const item of workflowEvidenceByRunId.get(snapshot.runId) ?? []) {
      attachedEvidenceIds.add(item.id);
    }
  }
  for (const task of visibleBackgroundTasks) {
    for (const item of backgroundEvidenceByTaskId.get(task.id) ?? []) {
      attachedEvidenceIds.add(item.id);
    }
  }
  const remainingEvidence = evidence.filter((item) => !attachedEvidenceIds.has(item.id));
  const visibleEvidence = remainingEvidence.slice(0, 4);
  const hiddenWorkflowRunCount = Math.max(0, workflowRuns.length - visibleWorkflowRuns.length);
  const hiddenBackgroundTaskCount = Math.max(0, backgroundTasks.length - visibleBackgroundTasks.length);
  const hiddenEvidenceCount = Math.max(0, remainingEvidence.length - visibleEvidence.length);
  const hasWorkflowEvidence =
    visibleWorkflowRuns.length > 0 || visibleBackgroundTasks.length > 0 || visibleEvidence.length > 0;
  const focusedWorkflowRun =
    focusedReplayOwner?.kind === 'workflow'
      ? (visibleWorkflowRuns.find((snapshot) => snapshot.runId === focusedReplayOwner.id) ?? null)
      : null;
  const focusedBackgroundTask =
    focusedReplayOwner?.kind === 'background'
      ? (visibleBackgroundTasks.find((task) => task.id === focusedReplayOwner.id) ?? null)
      : null;
  const activeFocusedOwner = focusedWorkflowRun || focusedBackgroundTask ? focusedReplayOwner : null;
  const activeFocusedOwnerKey = getFocusedReplayOwnerKey(activeFocusedOwner);
  const focusedEvidence = focusedWorkflowRun
    ? (workflowEvidenceByRunId.get(focusedWorkflowRun.runId) ?? [])
    : focusedBackgroundTask
      ? (backgroundEvidenceByTaskId.get(focusedBackgroundTask.id) ?? [])
      : [];

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={sessionTitle}
      size="md"
      className="!w-[80vw] !max-w-[1100px]"
      zIndex={Z_LAYERS.criticalOverlay}
      header={
        <>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium uppercase tracking-wide text-badge-accent">Replay</div>
            <h2 className="mt-1 truncate text-sm font-semibold text-zinc-100">{sessionTitle}</h2>
            <p className="mt-1 truncate text-[11px] text-zinc-500">{replay.traceIdentity.replayKey}</p>
          </div>
          <IconButton
            variant="default"
            size="sm"
            icon={<X className="h-4 w-4" />}
            aria-label={labels.dialog.closeAria}
            onClick={onClose}
          />
        </>
      }
    >
      <dl className="mt-4 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-2">
          <dt className="text-zinc-500">{labels.trajectory}</dt>
          <dd className="mt-1 flex items-center gap-1">
            <span
              className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${getTrajectoryTierToneClassName(trajectoryQuality.tier)}`}
            >
              {trajectoryQuality.tier}
            </span>
            <span className="truncate font-medium text-zinc-200">
              {getTrajectoryTaskKindLabel(trajectoryQuality.classification.taskKind, labels)}
            </span>
          </dd>
        </div>
        <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-2">
          <dt className="text-zinc-500">{labels.dataset}</dt>
          <dd className="mt-1">
            <div className="flex flex-wrap gap-1">
              {TRAJECTORY_DATASET_ROLE_OPTIONS.map((role) => {
                const active = trajectoryCollection.datasetRole === role;
                const roleLabel = getTrajectoryDatasetLabel(role, labels);
                return (
                  <button
                    key={role}
                    type="button"
                    disabled={!onUpdateTrajectoryDatasetRole || updatingDatasetRole !== null}
                    aria-pressed={active ? 'true' : 'false'}
                    aria-label={`${active ? labels.confirmReview : labels.markAs} ${roleLabel}`}
                    onClick={async (event) => {
                      event.preventDefault();
                      if (!onUpdateTrajectoryDatasetRole) return;
                      setUpdatingDatasetRole(role);
                      try {
                        await onUpdateTrajectoryDatasetRole(role);
                      } finally {
                        setUpdatingDatasetRole(null);
                      }
                    }}
                    className={`rounded border px-1.5 py-0.5 text-[10px] font-medium transition-colors ${active ? 'border-badge-info/40 bg-sky-500/15 text-badge-info' : 'border-zinc-700 bg-zinc-950/40 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200 disabled:opacity-50'}`}
                  >
                    {updatingDatasetRole === role ? '...' : roleLabel}
                  </button>
                );
              })}
            </div>
            <div className="mt-1 truncate text-[10px] text-zinc-500">
              {trajectoryCollection.datasetVersion} · {trajectoryCollection.source}
            </div>
          </dd>
        </div>
        {evidenceControl && (
          <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-2">
            <dt className="text-zinc-500">{labels.evidenceControl}</dt>
            <dd className="mt-1 flex min-w-0 items-center gap-1">
              <span
                title={formatEvidenceControlTitle(evidenceControl)}
                className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${getEvidenceControlToneClassName(evidenceControl.trustLevel)}`}
              >
                {evidenceControl.trustLevel}
              </span>
              <span className="truncate font-medium text-zinc-200">
                {evidenceControl.totalItems} items · {evidenceControl.totalEvidenceRefs} refs
              </span>
            </dd>
            <div className="mt-1 truncate text-[10px] text-zinc-500">
              blocked {evidenceControl.blockedItems} · stale {evidenceControl.staleItems} · conflicts {evidenceControl.conflictItems}
            </div>
          </div>
        )}
        <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-2">
          <dt className="text-zinc-500">{labels.turns}</dt>
          <dd className="mt-1 font-medium text-zinc-200">{replay.summary.totalTurns}</dd>
        </div>
        <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-2">
          <dt className="text-zinc-500">{labels.source}</dt>
          <dd className="mt-1 font-medium text-zinc-200">{replay.dataSource}</dd>
        </div>
        <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-2">
          <dt className="text-zinc-500">{labels.duration}</dt>
          <dd className="mt-1 font-medium text-zinc-200">{formatDuration(replay.summary.totalDurationMs, labels)}</dd>
        </div>
        <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-2">
          <dt className="text-zinc-500">
            <span title={labels.deviationTooltip}>{labels.deviation}</span>
          </dt>
          <dd className="mt-1 font-medium text-zinc-200" title={labels.deviationTooltip}>
            {issueCount}
          </dd>
        </div>
      </dl>

      <div className="mt-3 rounded-md border border-zinc-800 bg-zinc-900/40 p-2 text-xs">
        <div className="text-zinc-500">{labels.toolDistribution}</div>
        <div className="mt-1 text-zinc-300">{formatToolDistribution(replay, labels)}</div>
      </div>

      {trajectoryQuality.failures.length > 0 && (
        <div className="mt-3 rounded-md border border-badge-warning/20 bg-amber-500/10 p-2 text-xs">
          <div className="text-badge-warning">{labels.trajectoryGate}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {trajectoryQuality.failures.slice(0, 12).map((failure) => (
              <span
                key={failure}
                className="rounded border border-badge-warning/20 bg-zinc-950/30 px-1.5 py-0.5 text-[10px] text-badge-warning/80"
              >
                {failure}
              </span>
            ))}
          </div>
        </div>
      )}

      {evidenceControl && evidenceControl.gaps.length > 0 && (
        <div className="mt-3 rounded-md border border-zinc-800 bg-zinc-950/60 p-2 text-xs">
          <div className="text-zinc-400">{labels.evidenceGaps}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {evidenceControl.gaps.slice(0, 8).map((gap) => (
              <span
                key={gap}
                className="rounded border border-zinc-700 bg-zinc-900/70 px-1.5 py-0.5 text-[10px] text-zinc-300"
              >
                {gap}
              </span>
            ))}
          </div>
        </div>
      )}

      {hasWorkflowEvidence && (
        <div className="mt-3 rounded-md border border-zinc-800 bg-zinc-950/60 p-2 text-xs">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="font-medium text-zinc-300">{labels.workflowBackground}</div>
            <div className="text-[10px] text-zinc-600">
              {workflowRuns.length} workflow · {backgroundTasks.length} task · {evidence.length} evidence
            </div>
          </div>

          <div className="grid gap-2">
            {activeFocusedOwner && (
              <div className="rounded-md border border-zinc-700 bg-zinc-900/60 p-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">{labels.dialog.focusedEvidence}</div>
                    <div className="mt-0.5 truncate text-xs font-medium text-zinc-200">
                      {focusedWorkflowRun
                        ? focusedWorkflowRun.goal
                          ? `Workflow: ${focusedWorkflowRun.goal}`
                          : `Workflow ${focusedWorkflowRun.runId}`
                        : focusedBackgroundTask?.title}
                    </div>
                    <div className="mt-0.5 truncate text-[10px] text-zinc-500">
                      {focusedWorkflowRun
                        ? `${formatWorkflowStatus(focusedWorkflowRun, labels)} · ${formatWorkflowRunMeta(focusedWorkflowRun, labels)}`
                        : focusedBackgroundTask
                          ? `${formatTaskStatus(focusedBackgroundTask, labels)} · ${formatBackgroundTaskMeta(focusedBackgroundTask, labels)}`
                          : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setFocusedReplayOwner(null)}
                    className="shrink-0 rounded border border-zinc-700 bg-zinc-950/40 px-1.5 py-0.5 text-[10px] text-zinc-400 transition-colors hover:border-zinc-600 hover:bg-zinc-800 hover:text-zinc-200"
                  >
                    {labels.dialog.exitFocus}
                  </button>
                </div>
                {focusedEvidence.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1" aria-label={labels.dialog.focusedEvidenceListAria}>
                    {focusedEvidence.map((item) => renderEvidenceChip(item, labels, onOpenEvidence))}
                  </div>
                ) : (
                  <div className="mt-2 rounded border border-zinc-800 bg-zinc-950/40 px-2 py-1 text-[10px] text-zinc-500">
                    {labels.dialog.noFocusedEvidence}
                  </div>
                )}
                {focusedWorkflowRun && focusedWorkflowRun.phases.length > 0 && (
                  <div className="mt-2 truncate text-[10px] text-zinc-500">
                    Phases: {focusedWorkflowRun.phases.slice(0, 6).join(' · ')}
                  </div>
                )}
                {focusedWorkflowRun && focusedWorkflowRun.agents.length > 0 && (
                  <div className="mt-2 grid gap-1" aria-label={labels.dialog.focusedWorkflowAgentsAria}>
                    <div className="text-[10px] font-medium text-zinc-400">
                      Agents · {formatWorkflowAgentSummary(focusedWorkflowRun)}
                    </div>
                    {focusedWorkflowRun.agents.slice(0, 6).map((agent) => {
                      const body = formatWorkflowAgentBody(agent);
                      return (
                        <div
                          key={`focused:${focusedWorkflowRun.runId}:agent:${agent.id}`}
                          className="rounded border border-zinc-800 bg-zinc-950/40 px-2 py-1 text-[10px]"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="min-w-0 truncate font-medium text-zinc-300">
                              {agent.label || 'workflow agent'}
                            </span>
                            <span className="shrink-0 text-zinc-500">{formatWorkflowAgentStatus(agent, labels)}</span>
                          </div>
                          <div className="mt-0.5 truncate text-zinc-500">{formatWorkflowAgentDetail(agent)}</div>
                          {body && <div className="mt-0.5 truncate text-zinc-400">{body}</div>}
                        </div>
                      );
                    })}
                    {focusedWorkflowRun.agents.length > 6 && (
                      <div className="px-1 text-[10px] text-zinc-600">
                        {labels.dialog.moreWorkflowAgents.replace('{count}', String(focusedWorkflowRun.agents.length - 6))}
                      </div>
                    )}
                  </div>
                )}
                {focusedWorkflowRun && focusedWorkflowRun.logs.length > 0 && (
                  <div className="mt-2 rounded border border-zinc-800 bg-zinc-950/40 px-2 py-1">
                    <div className="text-[10px] font-medium text-zinc-400">Logs</div>
                    <div className="mt-1 grid gap-0.5 text-[10px] text-zinc-500">
                      {focusedWorkflowRun.logs.slice(-5).map((log, index) => (
                        <div key={`focused:${focusedWorkflowRun.runId}:log:${index}`} className="truncate">
                          {truncateContent(log, 120)}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {focusedBackgroundTask && focusedBackgroundTask.outputRefs.length > 0 && (
                  <div className="mt-2" aria-label={labels.dialog.focusedBackgroundOutputsAria}>
                    <div className="mb-1 text-[10px] font-medium text-zinc-400">Outputs</div>
                    <div className="flex flex-wrap gap-1">
                      {focusedBackgroundTask.outputRefs.slice(0, 6).map((ref) => (
                        <span
                          key={`focused:${focusedBackgroundTask.id}:output:${ref.id}`}
                          title={ref.path || ref.uri || ref.label}
                          className="rounded border border-zinc-700/60 bg-zinc-950/40 px-1.5 py-0.5 text-[10px] text-zinc-400"
                        >
                          {formatTaskOutputRef(ref)}
                        </span>
                      ))}
                      {focusedBackgroundTask.outputRefs.length > 6 && (
                        <span className="rounded border border-zinc-800 bg-zinc-950/60 px-1.5 py-0.5 text-[10px] text-zinc-600">
                          {labels.dialog.moreOutputs.replace('{count}', String(focusedBackgroundTask.outputRefs.length - 6))}
                        </span>
                      )}
                    </div>
                  </div>
                )}
                {focusedBackgroundTask && focusedBackgroundTask.events.length > 0 && (
                  <div className="mt-2 grid gap-1" aria-label={labels.dialog.focusedBackgroundEventsAria}>
                    <div className="text-[10px] font-medium text-zinc-400">Events</div>
                    {focusedBackgroundTask.events.slice(-5).map((event) => (
                      <div
                        key={`focused:${event.id}`}
                        className="rounded border border-zinc-800 bg-zinc-950/40 px-2 py-1 text-[10px]"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate font-medium text-zinc-300">
                            {formatTaskEventLabel(event)}
                          </span>
                          <span className="shrink-0 text-zinc-600">
                            {new Date(event.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                        <div className="mt-0.5 truncate text-zinc-500">{formatTaskEventDetail(event)}</div>
                      </div>
                    ))}
                    {focusedBackgroundTask.events.length > 5 && (
                      <div className="px-1 text-[10px] text-zinc-600">
                        {labels.dialog.moreTaskEvents.replace('{count}', String(focusedBackgroundTask.events.length - 5))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            {visibleWorkflowRuns.map((snapshot) => {
              const runEvidence = workflowEvidenceByRunId.get(snapshot.runId) ?? [];
              const owner: FocusedReplayOwner = {
                kind: 'workflow',
                id: snapshot.runId,
              };
              const ownerKey = getFocusedReplayOwnerKey(owner);
              const focused = ownerKey === activeFocusedOwnerKey;
              return (
                <div
                  key={snapshot.runId}
                  className={`rounded-md border p-2 ${focused ? 'border-badge-accent/40 bg-violet-500/10' : 'border-badge-accent/15 bg-violet-500/5'}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-badge-accent">
                        {snapshot.goal ? `Workflow: ${snapshot.goal}` : `Workflow ${snapshot.runId}`}
                      </div>
                      <div className="mt-0.5 truncate text-[10px] text-badge-accent/60">
                        {formatWorkflowStatus(snapshot, labels)}
                      </div>
                      <div className="mt-0.5 truncate text-[10px] text-badge-accent/45">
                        {formatWorkflowRunMeta(snapshot, labels)}
                      </div>
                    </div>
                    <div className="shrink-0 text-right text-[10px] text-badge-accent/60">
                      <div>{formatWorkflowAgentSummary(snapshot)}</div>
                      {snapshot.durationMs !== undefined && <div>{formatDuration(snapshot.durationMs, labels)}</div>}
                      <button
                        type="button"
                        aria-pressed={focused ? 'true' : 'false'}
                        aria-label={labels.dialog.focusWorkflowAria.replace('{id}', snapshot.runId)}
                        onClick={(event) => {
                          event.stopPropagation();
                          setFocusedReplayOwner(focused ? null : owner);
                        }}
                        className="mt-1 rounded border border-badge-accent/20 bg-zinc-950/30 px-1.5 py-0.5 text-[10px] text-badge-accent/70 transition-colors hover:border-badge-accent/40 hover:bg-violet-500/10 hover:text-badge-accent"
                      >
                        {focused ? labels.dialog.focused : labels.dialog.focus}
                      </button>
                    </div>
                  </div>
                  {snapshot.phases.length > 0 && (
                    <div className="mt-1 truncate text-[10px] text-zinc-500">
                      Phases: {snapshot.phases.slice(0, 4).join(' · ')}
                    </div>
                  )}
                  {runEvidence.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1" aria-label={labels.dialog.workflowEvidenceAria.replace('{id}', snapshot.runId)}>
                      {runEvidence.map((item) => renderEvidenceChip(item, labels, onOpenEvidence))}
                    </div>
                  )}
                  {snapshot.agents.length > 0 && (
                    <div className="mt-2 grid gap-1">
                      {snapshot.agents.slice(0, 4).map((agent) => {
                        const body = formatWorkflowAgentBody(agent);
                        return (
                          <div
                            key={agent.id}
                            className="rounded border border-badge-accent/10 bg-zinc-950/40 px-2 py-1 text-[10px]"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="min-w-0 truncate font-medium text-badge-accent">
                                {agent.label || 'workflow agent'}
                              </span>
                              <span className="shrink-0 text-badge-accent/60">{formatWorkflowAgentStatus(agent, labels)}</span>
                            </div>
                            <div className="mt-0.5 truncate text-zinc-500">{formatWorkflowAgentDetail(agent)}</div>
                            {body && <div className="mt-0.5 truncate text-zinc-400">{body}</div>}
                          </div>
                        );
                      })}
                      {snapshot.agents.length > 4 && (
                        <div className="px-1 text-[10px] text-zinc-600">
                          {labels.dialog.moreWorkflowAgents.replace('{count}', String(snapshot.agents.length - 4))}
                        </div>
                      )}
                    </div>
                  )}
                  {snapshot.logs.length > 0 && (
                    <div className="mt-2 rounded border border-badge-accent/10 bg-zinc-950/40 px-2 py-1">
                      <div className="text-[10px] font-medium text-badge-accent">Logs</div>
                      <div className="mt-1 grid gap-0.5 text-[10px] text-zinc-500">
                        {snapshot.logs.slice(-3).map((log, index) => (
                          <div key={`${snapshot.runId}:log:${index}`} className="truncate">
                            {truncateContent(log, 110)}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {hiddenWorkflowRunCount > 0 && (
              <div className="px-1 text-[10px] text-zinc-600">{labels.dialog.moreWorkflowRuns.replace('{count}', String(hiddenWorkflowRunCount))}</div>
            )}

            {visibleBackgroundTasks.map((task) => {
              const taskEvidence = backgroundEvidenceByTaskId.get(task.id) ?? [];
              const owner: FocusedReplayOwner = {
                kind: 'background',
                id: task.id,
              };
              const ownerKey = getFocusedReplayOwnerKey(owner);
              const focused = ownerKey === activeFocusedOwnerKey;
              return (
                <div
                  key={task.id}
                  className={`rounded-md border p-2 ${focused ? 'border-badge-info/40 bg-cyan-500/10' : 'border-badge-info/15 bg-cyan-500/5'}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-badge-info">{task.title}</div>
                      <div className="mt-0.5 truncate text-[10px] text-badge-info/60">{formatTaskStatus(task, labels)}</div>
                      <div className="mt-0.5 truncate text-[10px] text-badge-info/45">
                        {formatBackgroundTaskMeta(task, labels)}
                      </div>
                    </div>
                    <div className="shrink-0 text-right text-[10px] text-badge-info/60">
                      <div>{task.source}</div>
                      {task.durationMs !== undefined && <div>{formatDuration(task.durationMs, labels)}</div>}
                      <button
                        type="button"
                        aria-pressed={focused ? 'true' : 'false'}
                        aria-label={labels.dialog.focusBackgroundTaskAria.replace('{id}', task.id)}
                        onClick={(event) => {
                          event.stopPropagation();
                          setFocusedReplayOwner(focused ? null : owner);
                        }}
                        className="mt-1 rounded border border-badge-info/20 bg-zinc-950/30 px-1.5 py-0.5 text-[10px] text-badge-info/70 transition-colors hover:border-badge-info/40 hover:bg-cyan-500/10 hover:text-badge-info"
                      >
                        {focused ? labels.dialog.focused : labels.dialog.focus}
                      </button>
                    </div>
                  </div>
                  {task.outputRefs.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {task.outputRefs.slice(0, 4).map((ref) => (
                        <span
                          key={ref.id}
                          title={ref.path || ref.uri || ref.label}
                          className="rounded border border-zinc-700/60 bg-zinc-900/60 px-1.5 py-0.5 text-[10px] text-zinc-400"
                        >
                          {formatTaskOutputRef(ref)}
                        </span>
                      ))}
                    </div>
                  )}
                  {taskEvidence.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1" aria-label={labels.dialog.backgroundEvidenceAria.replace('{id}', task.id)}>
                      {taskEvidence.map((item) => renderEvidenceChip(item, labels, onOpenEvidence))}
                    </div>
                  )}
                  {task.events.length > 0 && (
                    <div className="mt-2 grid gap-1">
                      {task.events.slice(-3).map((event) => (
                        <div
                          key={event.id}
                          className="rounded border border-badge-info/10 bg-zinc-950/40 px-2 py-1 text-[10px]"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="min-w-0 truncate font-medium text-badge-info">
                              {formatTaskEventLabel(event)}
                            </span>
                            <span className="shrink-0 text-badge-info/50">
                              {new Date(event.timestamp).toLocaleTimeString()}
                            </span>
                          </div>
                          <div className="mt-0.5 truncate text-zinc-500">{formatTaskEventDetail(event)}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {hiddenBackgroundTaskCount > 0 && (
              <div className="px-1 text-[10px] text-zinc-600">{labels.dialog.moreBackgroundTasks.replace('{count}', String(hiddenBackgroundTaskCount))}</div>
            )}

            {visibleEvidence.length > 0 && (
              <div>
                <div className="mb-1 text-[10px] font-medium text-zinc-500">{labels.dialog.otherEvidence}</div>
                <div className="flex flex-wrap gap-1" aria-label={labels.dialog.otherEvidence}>
                  {visibleEvidence.map((item) => renderEvidenceChip(item, labels, onOpenEvidence))}
                  {hiddenEvidenceCount > 0 && (
                    <span className="rounded border border-zinc-800 bg-zinc-950/60 px-1.5 py-0.5 text-[10px] text-zinc-600">
                      {labels.dialog.moreEvidence.replace('{count}', String(hiddenEvidenceCount))}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950/60 p-2">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-xs font-medium text-zinc-300">{labels.timeline}</div>
          {hiddenTurnCount > 0 && <div className="text-[10px] text-zinc-600">{labels.dialog.moreTurnsHidden.replace('{count}', String(hiddenTurnCount))}</div>}
        </div>
        {visibleTurns.length === 0 ? (
          <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-2 text-xs text-zinc-500">
            {labels.emptyTimeline}
          </div>
        ) : (
          <div className="grid gap-2">
            {visibleTurns.map((turn) => (
              <div key={turn.turnNumber} className="rounded-md border border-zinc-800 bg-zinc-900/35 p-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-zinc-200">{labels.dialog.turnNumber.replace('{n}', String(turn.turnNumber))}</div>
                    <div className="mt-0.5 truncate text-[10px] text-zinc-600">{getTurnSummary(turn)}</div>
                  </div>
                  <div className="shrink-0 text-right text-[10px] text-zinc-600">
                    <div>{formatDuration(turn.durationMs, labels)}</div>
                    <div>{turn.inputTokens + turn.outputTokens} tokens</div>
                  </div>
                </div>
                {turn.blocks.length > 0 && (
                  <div className="mt-2 grid gap-1">
                    {turn.blocks.slice(0, 6).map((block, index) => {
                      const label = formatBlockLabel(block, labels);
                      const detail = formatBlockDetail(block, labels);
                      return (
                        <div
                          key={`${turn.turnNumber}:${block.type}:${block.timestamp}:${index}`}
                          className={`rounded border px-2 py-1 text-[11px] ${getBlockToneClassName(block)}`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <span className="min-w-0 whitespace-normal break-words font-medium leading-4">{label}</span>
                            <span className="shrink-0 text-[10px] opacity-70">{block.type}</span>
                          </div>
                          {shouldRenderBlockDetail(label, detail) && (
                            <div className="mt-1 whitespace-pre-wrap break-words opacity-80">{detail}</div>
                          )}
                        </div>
                      );
                    })}
                    {turn.blocks.length > 6 && (
                      <div className="px-2 text-[10px] text-zinc-600">{labels.dialog.moreBlocks.replace('{count}', String(turn.blocks.length - 6))}</div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {incompleteReasons.length > 0 && (
        <div className="mt-3 rounded-md border border-badge-warning/20 bg-amber-500/10 p-2 text-xs text-badge-warning">
          {labels.incompletePrefix}
          {incompleteReasons.join(' · ')}
        </div>
      )}
    </Modal>
  );
};

export default SessionReplaySummaryDialog;
