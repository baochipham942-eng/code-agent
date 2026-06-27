import type { GoalGateVerificationCard } from '../../shared/contract/agent';
import {
  isExportSafe,
  makeEvidenceRef,
  type EvidenceKind,
  type EvidenceRef,
  type EvidenceState,
  type RedactionStatus,
} from '../../shared/contract/evidence';
import type { BrowserComputerProofTimelineEntry } from '../../shared/contract/evaluation';
import type {
  EvidenceControlSummaryProjection,
  StructuredReplay,
} from '../../shared/contract/evaluation';
import type { CompletionSummaryRecord } from '../../shared/contract/completionSummary';
import type { Task } from '../../shared/contract/backgroundTask';
import { getBackgroundTaskLedger } from '../task/backgroundTaskLedger';
import {
  readCompletionSummaryRecordsBySession,
} from './completionSummaryService';
import {
  readBrowserComputerProofRecordsBySession,
  type BrowserComputerProofRecord,
} from './browserComputerProofStore';
import type { CachedMessage, CachedSession } from './localCache';

export type EvidenceControlSource =
  | 'verification'
  | 'browser_computer'
  | 'trajectory'
  | 'background_recovery';

export type EvidenceControlItemStatus =
  | 'passed'
  | 'failed'
  | 'not_run'
  | 'observed'
  | 'not_observed'
  | 'manual_takeover'
  | 'running'
  | 'recovered'
  | 'orphaned'
  | 'completed'
  | 'warning'
  | 'unknown';

export type EvidenceControlTrustLevel = 'strong' | 'partial' | 'weak';

export interface EvidenceControlItem {
  id: string;
  source: EvidenceControlSource;
  title: string;
  status: EvidenceControlItemStatus;
  summary: string;
  createdAt: number;
  evidenceRefs: EvidenceRef[];
  evidenceRefIds: string[];
  exportSafe: boolean;
  stale: boolean;
  blocked: boolean;
  metadata?: Record<string, unknown>;
}

export interface EvidenceControlSummary {
  sessionId: string;
  generatedAt: number;
  trustLevel: EvidenceControlTrustLevel;
  items: EvidenceControlItem[];
  counts: {
    totalItems: number;
    totalEvidenceRefs: number;
    exportSafeItems: number;
    blockedItems: number;
    staleItems: number;
    conflictItems: number;
    bySource: Record<EvidenceControlSource, number>;
    byStatus: Record<string, number>;
  };
  conflicts: string[];
  gaps: string[];
}

export interface BuildEvidenceControlSummaryInput {
  session: CachedSession;
  browserComputerProofRecords?: BrowserComputerProofRecord[];
  browserComputerProofTimeline?: BrowserComputerProofTimelineEntry[];
  backgroundTasks?: Task[];
  completionSummaries?: CompletionSummaryRecord[];
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function isEvidenceKind(value: unknown): value is EvidenceKind {
  return (
    value === 'read' ||
    value === 'file' ||
    value === 'diff' ||
    value === 'patch' ||
    value === 'tool' ||
    value === 'test' ||
    value === 'typecheck' ||
    value === 'build' ||
    value === 'ci' ||
    value === 'browser_dom' ||
    value === 'browser_a11y' ||
    value === 'screenshot' ||
    value === 'computer_ax' ||
    value === 'artifact' ||
    value === 'trace'
  );
}

function isEvidenceState(value: unknown): value is EvidenceState {
  return (
    value === 'fresh' ||
    value === 'candidate' ||
    value === 'read' ||
    value === 'stale' ||
    value === 'needs_re_read' ||
    value === 'not_run'
  );
}

function isRedactionStatus(value: unknown): value is RedactionStatus {
  return value === 'clean' || value === 'redacted' || value === 'contains_secret_blocked';
}

function normalizeEvidenceRef(value: unknown): EvidenceRef | null {
  if (!isRecord(value) || !isRecord(value.freshness)) return null;
  if (!(
    typeof value.id === 'string' &&
    isEvidenceKind(value.kind) &&
    typeof value.ref === 'string' &&
    typeof value.source === 'string' &&
    typeof value.freshness.capturedAtMs === 'number' &&
    isEvidenceState(value.freshness.state)
  )) {
    return null;
  }
  return {
    id: value.id,
    kind: value.kind,
    ref: value.ref,
    source: value.source,
    freshness: {
      capturedAtMs: value.freshness.capturedAtMs,
      ...(typeof value.freshness.digest === 'string' ? { digest: value.freshness.digest } : {}),
      state: value.freshness.state,
    },
    redactionStatus: isRedactionStatus(value.redactionStatus) ? value.redactionStatus : 'redacted',
  };
}

function evidenceRefsFromValue(value: unknown): EvidenceRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const ref = normalizeEvidenceRef(item);
    return ref ? [ref] : [];
  });
}

function compactId(value: string): string {
  return value.replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 120);
}

function sanitizeSummaryText(value: string): string {
  return value
    .replace(/^data:[^\s]+/gi, '[redacted]')
    .replace(/base64[,=][^\s]+/gi, 'base64,[redacted]')
    .replace(
      /(?:\/Users\/[^\s"'`]+|\/private\/tmp\/[^\s"'`]+|\/tmp\/[^\s"'`]+|\/var\/folders\/[^\s"'`]+|\/Volumes\/[^\s"'`]+)(?:\/[^\s"'`]*)*/g,
      (match) => `.../${match.split('/').filter(Boolean).at(-1) || 'path'}`,
    )
    .replace(/\b(cookie|cookies|localStorage|sessionStorage|storageState)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[redacted]')
    .replace(/([?&](?:token|password|secret|credential)=)[^&\s]+/gi, '$1[redacted]');
}

function sanitizeProjectionText(value: string): string {
  return sanitizeSummaryText(value).slice(0, 240);
}

function evidenceRefsState(refs: EvidenceRef[]): Pick<EvidenceControlItem, 'exportSafe' | 'stale' | 'blocked'> {
  return {
    exportSafe: refs.every(isExportSafe),
    stale: refs.some((ref) => ref.freshness.state === 'stale' || ref.freshness.state === 'needs_re_read'),
    blocked: refs.some((ref) => ref.redactionStatus === 'contains_secret_blocked'),
  };
}

function makeItem(args: Omit<EvidenceControlItem, 'evidenceRefIds' | 'exportSafe' | 'stale' | 'blocked'>): EvidenceControlItem {
  const refsState = evidenceRefsState(args.evidenceRefs);
  return {
    ...args,
    evidenceRefIds: args.evidenceRefs.map((ref) => ref.id),
    ...refsState,
  };
}

function commandKind(command: string): EvidenceKind {
  if (/\btypecheck\b|tsc --noEmit/.test(command)) return 'typecheck';
  if (/\bbuild\b/.test(command)) return 'build';
  if (/\btest\b|vitest|jest|playwright/.test(command)) return 'test';
  return 'tool';
}

function statusFromVerification(value: unknown): EvidenceControlItemStatus {
  if (value === 'passed' || value === 'failed' || value === 'not_run') return value;
  return 'unknown';
}

function collectVerificationFromObject(value: unknown, now: number, seen = new Set<unknown>()): EvidenceControlItem[] {
  if (!isRecord(value) || seen.has(value)) return [];
  seen.add(value);

  const direct = collectDirectVerificationObject(value, now);
  const nested = Object.entries(value)
    .filter(([key]) => key !== 'evidenceRefs')
    .flatMap(([, child]) => {
      if (Array.isArray(child)) {
        return child.flatMap((entry) => collectVerificationFromObject(entry, now, seen));
      }
      return collectVerificationFromObject(child, now, seen);
    });
  return [...direct, ...nested];
}

function collectDirectVerificationObject(value: Record<string, unknown>, now: number): EvidenceControlItem[] {
  const card = isRecord(value.verificationCard) ? value.verificationCard as Partial<GoalGateVerificationCard> : null;
  const status = statusFromVerification(value.verificationStatus ?? card?.status ?? card?.requiredStatus);
  const refs = evidenceRefsFromValue(value.evidenceRefs);
  const cardRefIds = stringArray(card?.evidenceRefIds);
  if (!card && refs.length === 0 && status === 'unknown') return [];

  const fallbackRef = makeEvidenceRef({
    kind: status === 'not_run' ? 'tool' : 'test',
    ref: `verification:${compactId(stringValue(value.id) ?? stringValue(value.type) ?? 'session-metadata')}`,
    source: 'session.metadata.verification',
    capturedAtMs: now,
    state: status === 'not_run' ? 'not_run' : 'read',
  });
  const evidenceRefs = refs.length > 0 ? refs : [fallbackRef];
  return [makeItem({
    id: `verification:${compactId(evidenceRefs[0]?.id ?? cardRefIds[0] ?? 'metadata')}`,
    source: 'verification',
    title: 'Verification',
    status,
    summary: stringValue(card?.summary) ?? `verification status: ${status}`,
    createdAt: numberValue(value.timestamp) ?? now,
    evidenceRefs,
    metadata: {
      requiredStatus: card?.requiredStatus,
      cardEvidenceRefIds: cardRefIds,
    },
  })];
}

function collectVerificationFromSession(session: CachedSession, now: number): EvidenceControlItem[] {
  const values: unknown[] = [
    session.metadata,
    ...session.messages.map((message: CachedMessage) => message.metadata),
  ];
  return values.flatMap((value) => collectVerificationFromObject(value, now));
}

function collectVerificationFromCompletionSummaries(records: CompletionSummaryRecord[], now: number): EvidenceControlItem[] {
  return records.flatMap((record) =>
    record.verificationEvidence.map((evidence) => {
      const ref = makeEvidenceRef({
        kind: commandKind(evidence.command),
        ref: `completion:${record.id}:${evidence.toolCallId}`,
        source: 'completionSummary.verification',
        capturedAtMs: record.endedAt || now,
        state: 'read',
      });
      return makeItem({
        id: `verification:${compactId(record.id)}:${compactId(evidence.toolCallId)}`,
        source: 'verification',
        title: 'Verification command',
        status: evidence.success ? 'passed' : 'failed',
        summary: `${evidence.success ? 'passed' : 'failed'} exit=${evidence.exitCode ?? 'unknown'} ${evidence.command}`,
        createdAt: record.endedAt || now,
        evidenceRefs: [ref],
      });
    })
  );
}

function collectBrowserComputerProofItems(records: BrowserComputerProofRecord[], now: number): EvidenceControlItem[] {
  return records.map((record) => {
    const proof = isRecord(record.proof) ? record.proof : {};
    const refs = evidenceRefsFromValue(proof.evidenceRefs);
    const fallbackRef = makeEvidenceRef({
      kind: 'trace',
      ref: record.traceId || record.id,
      source: 'browserComputerProofStore',
      capturedAtMs: record.createdAt || now,
      state: 'read',
    });
    return makeItem({
      id: `browser_computer:${compactId(record.id)}`,
      source: 'browser_computer',
      title: `${record.toolName} proof`,
      status: statusFromBrowserComputer(record.status),
      summary: record.summary,
      createdAt: record.createdAt || now,
      evidenceRefs: refs.length > 0 ? refs : [fallbackRef],
      metadata: {
        toolName: record.toolName,
        targetKind: record.targetKind,
        traceId: record.traceId,
      },
    });
  });
}

function statusFromBrowserComputer(status: string): EvidenceControlItemStatus {
  if (status === 'observed' || status === 'not_observed' || status === 'manual_takeover') return status;
  return 'unknown';
}

function collectTrajectoryProofItems(timeline: BrowserComputerProofTimelineEntry[], now: number): EvidenceControlItem[] {
  return timeline.map((entry) => {
    const ref = makeEvidenceRef({
      kind: 'trace',
      ref: entry.traceId || entry.toolCallId,
      source: 'trajectory.browserComputerProofTimeline',
      capturedAtMs: entry.timestamp || now,
      state: 'read',
    });
    return makeItem({
      id: `trajectory:${compactId(entry.toolCallId)}`,
      source: 'trajectory',
      title: `${entry.toolName} replay proof`,
      status: statusFromBrowserComputer(entry.status),
      summary: entry.summary,
      createdAt: entry.timestamp || now,
      evidenceRefs: [ref],
      metadata: {
        turnNumber: entry.turnNumber,
        visualSource: entry.visualSource,
        manualTakeoverStatus: entry.manualTakeoverStatus,
      },
    });
  });
}

function collectBackgroundRecoveryItems(tasks: Task[], now: number): EvidenceControlItem[] {
  return tasks.flatMap((task) => {
    const recoveryPlan = isRecord(task.metadata?.recoveryPlan) ? task.metadata.recoveryPlan : null;
    const recoveryStatus = stringValue(task.metadata?.recoveryStatus);
    if (!recoveryPlan && !recoveryStatus) return [];
    const ref = makeEvidenceRef({
      kind: 'trace',
      ref: `background_task:${task.id}`,
      source: 'backgroundTask.recoveryPlan',
      capturedAtMs: task.updatedAt || now,
      state: task.status === 'running' ? 'fresh' : 'read',
    });
    return [makeItem({
      id: `background_recovery:${compactId(task.id)}`,
      source: 'background_recovery',
      title: task.title,
      status: statusFromBackgroundTask(task, recoveryStatus),
      summary: stringValue(recoveryPlan?.summary) ?? task.failure?.message ?? task.summary ?? task.status,
      createdAt: task.updatedAt || now,
      evidenceRefs: [ref],
      metadata: {
        taskId: task.id,
        taskStatus: task.status,
        recoveryStatus,
        controlActions: Array.isArray(recoveryPlan?.controlActions)
          ? recoveryPlan.controlActions.filter((item): item is string => typeof item === 'string')
          : undefined,
      },
    })];
  });
}

function statusFromBackgroundTask(task: Task, recoveryStatus?: string): EvidenceControlItemStatus {
  if (recoveryStatus === 'running-recovered') return 'recovered';
  if (recoveryStatus === 'dead-log-only' || task.status === 'orphaned') return 'orphaned';
  if (task.status === 'running') return 'running';
  if (task.status === 'completed') return 'completed';
  if (task.status === 'failed') return 'failed';
  return 'warning';
}

function dedupeItems(items: EvidenceControlItem[]): EvidenceControlItem[] {
  const seen = new Set<string>();
  const out: EvidenceControlItem[] = [];
  for (const item of items) {
    const key = `${item.source}:${item.id}:${item.evidenceRefIds.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

function statusConflict(left: string, right: string): boolean {
  const pair = new Set([left, right]);
  return (
    (pair.has('passed') && pair.has('failed')) ||
    (pair.has('observed') && pair.has('not_observed')) ||
    (pair.has('completed') && pair.has('orphaned')) ||
    (pair.has('running') && pair.has('orphaned'))
  );
}

function detectEvidenceConflicts(items: EvidenceControlItem[]): string[] {
  const byRef = new Map<string, EvidenceControlItem[]>();
  for (const item of items) {
    for (const refId of item.evidenceRefIds) {
      const list = byRef.get(refId) ?? [];
      list.push(item);
      byRef.set(refId, list);
    }
  }
  const conflicts: string[] = [];
  for (const [refId, list] of byRef.entries()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        if (statusConflict(list[i].status, list[j].status)) {
          conflicts.push(`${refId}: ${list[i].status} vs ${list[j].status}`);
        }
      }
    }
  }
  return Array.from(new Set(conflicts)).sort();
}

function conflictRefIds(conflicts: string[]): Set<string> {
  return new Set(conflicts.map((conflict) => {
    const match = /: [a-z_]+ vs [a-z_]+$/.exec(conflict);
    if (match?.index !== undefined) {
      return conflict.slice(0, match.index);
    }
    return conflict.split(':')[0];
  }).filter(Boolean));
}

function trustLevel(items: EvidenceControlItem[], conflicts: string[]): EvidenceControlTrustLevel {
  if (items.length === 0) return 'weak';
  if (conflicts.length > 0) return 'weak';
  if (items.some((item) => item.blocked || item.status === 'failed')) return 'weak';
  if (items.some((item) => item.status === 'not_run' || item.status === 'not_observed' || item.status === 'manual_takeover' || item.status === 'orphaned' || item.stale)) {
    return 'partial';
  }
  const sources = new Set(items.map((item) => item.source));
  return sources.has('verification') && sources.has('browser_computer') ? 'strong' : 'partial';
}

function buildCounts(items: EvidenceControlItem[], conflicts: string[]): EvidenceControlSummary['counts'] {
  const bySource: Record<EvidenceControlSource, number> = {
    verification: 0,
    browser_computer: 0,
    trajectory: 0,
    background_recovery: 0,
  };
  const byStatus: Record<string, number> = {};
  for (const item of items) {
    bySource[item.source] += 1;
    byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
  }
  return {
    totalItems: items.length,
    totalEvidenceRefs: items.reduce((sum, item) => sum + item.evidenceRefs.length, 0),
    exportSafeItems: items.filter((item) => item.exportSafe).length,
    blockedItems: items.filter((item) => item.blocked).length,
    staleItems: items.filter((item) => item.stale).length,
    conflictItems: countItemsWithConflicts(items, conflicts),
    bySource,
    byStatus,
  };
}

function countItemsWithConflicts(items: EvidenceControlItem[], conflicts: string[]): number {
  const refIds = conflictRefIds(conflicts);
  if (refIds.size === 0) return 0;
  return items.filter((item) => item.evidenceRefIds.some((refId) => refIds.has(refId))).length;
}

function buildGaps(items: EvidenceControlItem[], conflicts: string[]): string[] {
  const gaps: string[] = [];
  const sources = new Set(items.map((item) => item.source));
  if (!sources.has('verification')) gaps.push('missing verification evidence');
  if (!sources.has('browser_computer')) gaps.push('missing browser/computer proof');
  if (!sources.has('background_recovery')) gaps.push('missing background recovery evidence');
  if (items.some((item) => item.status === 'not_run')) gaps.push('required verification was not run');
  if (items.some((item) => item.status === 'manual_takeover')) gaps.push('manual takeover remains in proof timeline');
  if (items.some((item) => item.status === 'orphaned')) gaps.push('background task has dead-log-only recovery');
  if (items.some((item) => item.blocked)) gaps.push('export-blocked evidence present');
  if (items.some((item) => item.stale)) gaps.push('stale evidence present');
  if (conflicts.length > 0) gaps.push('conflicting evidence statuses present');
  return Array.from(new Set(gaps));
}

export function buildEvidenceControlSummary(input: BuildEvidenceControlSummaryInput): EvidenceControlSummary {
  const now = input.now?.() ?? Date.now();
  const items = dedupeItems([
    ...collectVerificationFromSession(input.session, now),
    ...collectVerificationFromCompletionSummaries(input.completionSummaries ?? [], now),
    ...collectBrowserComputerProofItems(input.browserComputerProofRecords ?? [], now),
    ...collectTrajectoryProofItems(input.browserComputerProofTimeline ?? [], now),
    ...collectBackgroundRecoveryItems(input.backgroundTasks ?? [], now),
  ]);
  const conflicts = detectEvidenceConflicts(items);
  return {
    sessionId: input.session.sessionId,
    generatedAt: now,
    trustLevel: trustLevel(items, conflicts),
    items,
    counts: buildCounts(items, conflicts),
    conflicts,
    gaps: buildGaps(items, conflicts),
  };
}

export async function loadEvidenceControlSummaryForSession(
  session: CachedSession,
): Promise<EvidenceControlSummary> {
  const [completionSummaries] = await Promise.all([
    readCompletionSummaryRecordsBySession(session.sessionId, 20),
  ]);
  return buildEvidenceControlSummary({
    session,
    completionSummaries,
    browserComputerProofRecords: readBrowserComputerProofRecordsBySession(session.sessionId, 100),
    backgroundTasks: getBackgroundTaskLedger().listTasks({ sessionId: session.sessionId }),
  });
}

export function projectEvidenceControlSummary(summary: EvidenceControlSummary): EvidenceControlSummaryProjection {
  return {
    schemaVersion: 1,
    trustLevel: summary.trustLevel,
    generatedAt: summary.generatedAt,
    totalItems: summary.counts.totalItems,
    totalEvidenceRefs: summary.counts.totalEvidenceRefs,
    exportSafeItems: summary.counts.exportSafeItems,
    blockedItems: summary.counts.blockedItems,
    staleItems: summary.counts.staleItems,
    conflictItems: summary.counts.conflictItems,
    bySource: summary.counts.bySource,
    byStatus: summary.counts.byStatus,
    gaps: summary.gaps.slice(0, 10).map(sanitizeProjectionText),
    conflicts: summary.conflicts.slice(0, 10).map(sanitizeProjectionText),
  };
}

export function attachEvidenceControlProjectionToReplay(
  replay: StructuredReplay,
  summary: EvidenceControlSummary,
): StructuredReplay {
  if (summary.items.length === 0) return replay;
  return {
    ...replay,
    summary: {
      ...replay.summary,
      evidenceControl: projectEvidenceControlSummary(summary),
    },
  };
}

export function formatEvidenceControlSummaryForMarkdown(summary: EvidenceControlSummary): string {
  if (summary.items.length === 0) return '';
  const lines: string[] = [
    '## Evidence Control Summary',
    '',
    `- trust: ${summary.trustLevel}`,
    `- items: ${summary.counts.totalItems}; refs: ${summary.counts.totalEvidenceRefs}; export_safe: ${summary.counts.exportSafeItems}; blocked: ${summary.counts.blockedItems}; stale: ${summary.counts.staleItems}; conflicts: ${summary.counts.conflictItems}`,
    `- sources: verification ${summary.counts.bySource.verification}, browser/computer ${summary.counts.bySource.browser_computer}, trajectory ${summary.counts.bySource.trajectory}, background recovery ${summary.counts.bySource.background_recovery}`,
  ];
  if (summary.gaps.length > 0) {
    lines.push(`- gaps: ${summary.gaps.slice(0, 5).join('; ')}`);
  }
  lines.push('');
  for (const item of summary.items.slice(0, 20)) {
    const refs = item.evidenceRefIds.length > 0
      ? ` · refs ${item.evidenceRefIds.slice(0, 5).join(', ')}${item.evidenceRefIds.length > 5 ? ` +${item.evidenceRefIds.length - 5}` : ''}`
      : '';
    lines.push(`- ${item.source} · ${item.status} · ${sanitizeSummaryText(item.summary)}${refs}`);
  }
  lines.push('');
  return lines.join('\n');
}
