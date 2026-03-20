// ============================================================================
// Desktop Activity Understanding Service
// ============================================================================
// Turns raw native desktop activity into derived memory artifacts:
// - time-slice summaries
// - todo candidates
// - semantic retrieval over derived summaries
// ============================================================================

import path from 'path';
import type {
  DesktopActivityEvent,
  DesktopActivitySemanticMatch,
  DesktopActivitySliceSummary,
  DesktopActivityTodoCandidate,
  SessionTask,
  SessionTaskPriority,
  TodoItem,
} from '../../shared/types';
import { getNativeDesktopService } from '../services/nativeDesktopService';
import { createLogger } from '../services/infra/logger';
import { getDatabase } from '../services/core/databaseService';
import type { MemoryRecord } from '../services/core/repositories';
import { getEventBus } from '../events/eventBus';
import type { Disposable } from '../services/serviceRegistry';
import { getServiceRegistry } from '../services/serviceRegistry';
import { createTask, listTasks, updateTask } from '../tools/planning/taskStore';

const logger = createLogger('DesktopActivityUnderstanding');

const GENERIC_SUBJECTS = new Set([
  'new tab',
  'google chrome',
  'chrome',
  'cursor',
  'finder',
  'mail',
  'calendar',
  'safari',
  'arc',
  'slack',
  '微信',
  'wecom',
  'visual studio code',
]);

const ACTIONABLE_PATTERNS = [
  /issue|ticket|bug|pr\b|pull request|review|fix|todo|task|需求|缺陷|修复|评审/i,
  /rfc|spec|proposal|plan|roadmap|设计|方案|计划|文档/i,
  /\.[cm]?[jt]sx?$|\.(md|py|go|rs|json|yaml|yml)$/i,
];

const COMMUNICATION_PATTERNS = /(mail|gmail|outlook|slack|discord|飞书|lark|teams|telegram|微信)/i;
const RESEARCH_PATTERNS = /(docs|notion|readme|wikipedia|google docs|deep research|research|调研|文档)/i;
const CODING_PATTERNS = /(cursor|terminal|iterm|warp|xcode|visual studio code|vscode|github|gitlab|sourcegraph)/i;

export interface DesktopActivityUnderstandingConfig {
  lookbackHours: number;
  sliceMinutes: number;
  refreshIntervalMs: number;
  maxEventsPerRefresh: number;
  minEventsPerSlice: number;
  maxSubjectsPerSlice: number;
  maxTodoCandidatesPerSlice: number;
}

export interface DesktopActivitySlice {
  sliceKey: string;
  fromMs: number;
  toMs: number;
  events: DesktopActivityEvent[];
}

export interface DesktopActivityDerivationRun {
  scannedEvents: number;
  slicesConsidered: number;
  summariesCreated: number;
  summariesUpdated: number;
  summariesUnchanged: number;
  todoCandidatesCreated: number;
  generatedAtMs: number;
}

export type DesktopTodoFeedbackStatus =
  | 'accepted'
  | 'completed'
  | 'dismissed'
  | 'snoozed'
  | 'superseded';

const ACCEPTED_FEEDBACK_SUPPRESS_MS = 2 * 60 * 60 * 1000;
const AUTO_SUPERSEDED_SUPPRESS_MS = 12 * 60 * 60 * 1000;

const DEFAULT_CONFIG: DesktopActivityUnderstandingConfig = {
  lookbackHours: 24,
  sliceMinutes: 30,
  refreshIntervalMs: 5 * 60 * 1000,
  maxEventsPerRefresh: 5000,
  minEventsPerSlice: 2,
  maxSubjectsPerSlice: 3,
  maxTodoCandidatesPerSlice: 3,
};

interface SubjectCandidate {
  subject: string;
  count: number;
  latestAtMs: number;
  evidence: string[];
  actionableScore: number;
}

interface SummaryMemoryMetadata extends Record<string, unknown> {
  kind: 'activity_summary';
  sliceKey: string;
  fromMs: number;
  toMs: number;
  lastCapturedAtMs: number;
  eventCount: number;
  salientSubjects: string[];
  topApps: Array<{ appName: string; count: number }>;
  domains: string[];
  generatedAtMs: number;
}

interface TodoMemoryMetadata extends Record<string, unknown> {
  kind: 'activity_todo_candidate';
  sliceKey: string;
  todoKey?: string;
  confidence: number;
  evidence: string[];
  createdAtMs: number;
}

interface TodoFeedbackMemoryMetadata extends Record<string, unknown> {
  kind: 'activity_todo_feedback';
  todoKey: string;
  feedbackStatus: DesktopTodoFeedbackStatus;
  sessionId?: string;
  taskId?: string;
  source: 'task' | 'plan' | 'sync';
  resumeAtMs?: number;
  reason?: string;
  updatedAtMs: number;
}

export interface DesktopTaskSyncResult {
  totalCandidates: number;
  created: SessionTask[];
  updated: SessionTask[];
  skipped: SessionTask[];
  supersededTodoKeys: string[];
  tasks: SessionTask[];
}

export interface DesktopTodoFeedbackRecord {
  todoKey: string;
  status: DesktopTodoFeedbackStatus;
  sessionId?: string;
  taskId?: string;
  source: 'task' | 'plan' | 'sync';
  resumeAtMs?: number;
  reason?: string;
  updatedAtMs: number;
}

function bucketStart(timestampMs: number, sliceMinutes: number): number {
  const bucketMs = sliceMinutes * 60 * 1000;
  return Math.floor(timestampMs / bucketMs) * bucketMs;
}

function formatTime(timestampMs: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestampMs));
}

function sanitizeSubject(raw: string | null | undefined, appName?: string): string | null {
  if (!raw) return null;

  let text = raw
    .replace(/\s+/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();

  if (!text) return null;

  const separators = [' - ', ' | ', ' · ', ' — ', ' – ', ' • ', ' — '];
  for (const separator of separators) {
    const index = text.lastIndexOf(separator);
    if (index > 8) {
      const suffix = text.slice(index + separator.length).trim().toLowerCase();
      const app = appName?.trim().toLowerCase();
      if (suffix === app || GENERIC_SUBJECTS.has(suffix)) {
        text = text.slice(0, index).trim();
      }
    }
  }

  if (!text || text.length < 3) return null;
  if (GENERIC_SUBJECTS.has(text.toLowerCase())) return null;

  return text.slice(0, 160);
}

function subjectFromUrl(urlValue: string | null | undefined): string | null {
  if (!urlValue) return null;

  try {
    const url = new URL(urlValue);
    const pathSegments = url.pathname
      .split('/')
      .map((segment) => decodeURIComponent(segment).trim())
      .filter(Boolean)
      .filter((segment) => segment.length > 2)
      .filter((segment) => !['issues', 'pull', 'pulls', 'docs', 'blob', 'tree'].includes(segment.toLowerCase()));

    if (pathSegments.length > 0) {
      return sanitizeSubject(pathSegments[pathSegments.length - 1]);
    }

    return sanitizeSubject(url.hostname.replace(/^www\./, ''));
  } catch {
    return null;
  }
}

function domainFromUrl(urlValue: string | null | undefined): string | null {
  if (!urlValue) return null;

  try {
    return new URL(urlValue).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function extractSubjects(events: DesktopActivityEvent[]): SubjectCandidate[] {
  const subjects = new Map<string, SubjectCandidate>();

  for (const event of events) {
    const rawCandidates = [
      sanitizeSubject(event.browserTitle, event.appName),
      sanitizeSubject(event.windowTitle, event.appName),
      sanitizeSubject(event.documentPath ? path.basename(event.documentPath) : null),
      subjectFromUrl(event.browserUrl),
    ].filter((value): value is string => Boolean(value));

    for (const candidate of rawCandidates) {
      const normalized = candidate.toLowerCase();
      const existing = subjects.get(normalized);
      const evidence = buildEvidence(event);
      const actionableScore = isActionableSubject(candidate, event) ? 1 : 0;

      if (!existing) {
        subjects.set(normalized, {
          subject: candidate,
          count: 1,
          latestAtMs: event.capturedAtMs,
          evidence,
          actionableScore,
        });
        continue;
      }

      existing.count += 1;
      existing.latestAtMs = Math.max(existing.latestAtMs, event.capturedAtMs);
      existing.actionableScore = Math.max(existing.actionableScore, actionableScore);
      for (const item of evidence) {
        if (existing.evidence.length >= 3) break;
        if (!existing.evidence.includes(item)) {
          existing.evidence.push(item);
        }
      }
    }
  }

  return Array.from(subjects.values())
    .sort((a, b) => {
      if (b.actionableScore !== a.actionableScore) {
        return b.actionableScore - a.actionableScore;
      }
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return b.latestAtMs - a.latestAtMs;
    });
}

function isActionableSubject(subject: string, event?: DesktopActivityEvent): boolean {
  if (ACTIONABLE_PATTERNS.some((pattern) => pattern.test(subject))) {
    return true;
  }

  const haystack = [
    event?.browserUrl,
    event?.windowTitle,
    event?.browserTitle,
    event?.documentPath,
  ]
    .filter(Boolean)
    .join(' ');

  return ACTIONABLE_PATTERNS.some((pattern) => pattern.test(haystack));
}

function buildEvidence(event: DesktopActivityEvent): string[] {
  const evidence = [
    event.browserTitle,
    event.windowTitle,
    event.documentPath ? path.basename(event.documentPath) : null,
    domainFromUrl(event.browserUrl),
  ].filter((value): value is string => Boolean(value));

  return evidence.slice(0, 3);
}

function inferTheme(events: DesktopActivityEvent[]): string | null {
  const haystack = events
    .map((event) => [
      event.appName,
      event.browserTitle,
      event.windowTitle,
      event.browserUrl,
      event.documentPath,
    ].filter(Boolean).join(' '))
    .join('\n');

  if (COMMUNICATION_PATTERNS.test(haystack)) return '沟通协调';
  if (CODING_PATTERNS.test(haystack)) return '编码实现';
  if (RESEARCH_PATTERNS.test(haystack)) return '资料阅读';
  return null;
}

export function buildDesktopActivitySlices(
  events: DesktopActivityEvent[],
  sliceMinutes: number = DEFAULT_CONFIG.sliceMinutes
): DesktopActivitySlice[] {
  const sorted = [...events].sort((a, b) => a.capturedAtMs - b.capturedAtMs);
  const slices = new Map<string, DesktopActivitySlice>();
  const bucketMs = sliceMinutes * 60 * 1000;

  for (const event of sorted) {
    const fromMs = bucketStart(event.capturedAtMs, sliceMinutes);
    const toMs = fromMs + bucketMs;
    const sliceKey = `${fromMs}-${toMs}`;
    const existing = slices.get(sliceKey);

    if (existing) {
      existing.events.push(event);
      continue;
    }

    slices.set(sliceKey, {
      sliceKey,
      fromMs,
      toMs,
      events: [event],
    });
  }

  return Array.from(slices.values()).sort((a, b) => a.fromMs - b.fromMs);
}

export function summarizeDesktopActivitySlice(
  slice: DesktopActivitySlice,
  maxSubjects: number = DEFAULT_CONFIG.maxSubjectsPerSlice
): DesktopActivitySliceSummary {
  const byApp = new Map<string, number>();
  const domains = new Map<string, number>();

  for (const event of slice.events) {
    byApp.set(event.appName, (byApp.get(event.appName) || 0) + 1);

    const domain = domainFromUrl(event.browserUrl);
    if (domain) {
      domains.set(domain, (domains.get(domain) || 0) + 1);
    }
  }

  const topApps = Array.from(byApp.entries())
    .map(([appName, count]) => ({ appName, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  const salientSubjects = extractSubjects(slice.events)
    .slice(0, maxSubjects)
    .map((candidate) => candidate.subject);

  const topDomains = Array.from(domains.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([domain]) => domain);

  const timeRange = `${formatTime(slice.fromMs)}-${formatTime(slice.toMs)}`;
  const appsText = topApps.map((item) => `${item.appName}(${item.count})`).join('、');
  const theme = inferTheme(slice.events);
  const subjectText = salientSubjects.length > 0
    ? `，聚焦 ${salientSubjects.map((subject) => `「${subject}」`).join('、')}`
    : '';
  const themeText = theme ? `，以${theme}为主` : '';
  const domainText = topDomains.length > 0 ? `，涉及 ${topDomains.join('、')}` : '';

  const summary = `${timeRange} 主要活跃于 ${appsText}${themeText}${subjectText}${domainText}。共 ${slice.events.length} 条桌面事件。`;

  return {
    sliceKey: slice.sliceKey,
    fromMs: slice.fromMs,
    toMs: slice.toMs,
    eventCount: slice.events.length,
    lastCapturedAtMs: slice.events[slice.events.length - 1]?.capturedAtMs || slice.toMs,
    summary,
    salientSubjects,
    topApps,
    domains: topDomains,
  };
}

function buildTodoContent(subject: string): string {
  if (/\.[cm]?[jt]sx?$|\.(md|py|go|rs|json|yaml|yml)$/i.test(subject)) {
    return `继续处理 ${subject}`;
  }

  if (/issue|ticket|bug|pr\b|pull request|review|需求|缺陷|修复|评审/i.test(subject)) {
    return `跟进 ${subject}`;
  }

  if (/rfc|spec|proposal|plan|roadmap|设计|方案|计划|文档/i.test(subject)) {
    return `继续完善 ${subject}`;
  }

  return `继续跟进 ${subject}`;
}

function buildTodoKey(sliceKey: string, content: string): string {
  return `${sliceKey}:${content.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

function toActiveForm(content: string): string {
  if (content.startsWith('继续处理 ')) {
    return `正在处理 ${content.slice('继续处理 '.length)}`;
  }
  if (content.startsWith('跟进 ')) {
    return `正在跟进 ${content.slice('跟进 '.length)}`;
  }
  if (content.startsWith('继续完善 ')) {
    return `正在完善 ${content.slice('继续完善 '.length)}`;
  }
  if (content.startsWith('继续跟进 ')) {
    return `正在跟进 ${content.slice('继续跟进 '.length)}`;
  }
  return content;
}

export function deriveTodoCandidatesFromSlice(
  slice: DesktopActivitySlice,
  summary: DesktopActivitySliceSummary,
  maxCandidates: number = DEFAULT_CONFIG.maxTodoCandidatesPerSlice
): DesktopActivityTodoCandidate[] {
  const subjects = extractSubjects(slice.events);
  const recentCutoff = summary.lastCapturedAtMs - (10 * 60 * 1000);

  return subjects
    .map((candidate) => {
      const recencyBoost = candidate.latestAtMs >= recentCutoff ? 0.2 : 0;
      const frequencyBoost = Math.min(candidate.count / Math.max(slice.events.length, 1), 0.4);
      const actionableBoost = candidate.actionableScore > 0 ? 0.3 : 0;
      const confidence = Math.min(0.95, 0.25 + recencyBoost + frequencyBoost + actionableBoost);
      const content = buildTodoContent(candidate.subject);

      return {
        id: buildTodoKey(summary.sliceKey, content),
        sliceKey: summary.sliceKey,
        content,
        activeForm: toActiveForm(content),
        status: 'pending' as const,
        confidence,
        evidence: candidate.evidence.slice(0, 3),
        createdAtMs: summary.lastCapturedAtMs,
      };
    })
    .filter((candidate) => candidate.confidence >= 0.55)
    .slice(0, maxCandidates);
}

function buildVectorText(summary: DesktopActivitySliceSummary): string {
  const lines = [
    summary.summary,
    `time_slice: ${summary.sliceKey}`,
    `apps: ${summary.topApps.map((item) => `${item.appName} ${item.count}`).join(', ')}`,
  ];

  if (summary.salientSubjects.length > 0) {
    lines.push(`subjects: ${summary.salientSubjects.join(', ')}`);
  }

  if (summary.domains.length > 0) {
    lines.push(`domains: ${summary.domains.join(', ')}`);
  }

  return lines.join('\n');
}

function summaryFromMemory(memory: MemoryRecord): DesktopActivitySliceSummary | null {
  if (memory.type !== 'desktop_activity' || memory.category !== 'activity_summary') {
    return null;
  }

  const metadata = (memory.metadata || {}) as Partial<SummaryMemoryMetadata>;
  if (!metadata.sliceKey || typeof metadata.fromMs !== 'number' || typeof metadata.toMs !== 'number') {
    return null;
  }

  return {
    sliceKey: metadata.sliceKey,
    fromMs: metadata.fromMs,
    toMs: metadata.toMs,
    eventCount: metadata.eventCount || 0,
    lastCapturedAtMs: metadata.lastCapturedAtMs || memory.updatedAt,
    summary: memory.summary || memory.content,
    salientSubjects: Array.isArray(metadata.salientSubjects) ? metadata.salientSubjects : [],
    topApps: Array.isArray(metadata.topApps) ? metadata.topApps : [],
    domains: Array.isArray(metadata.domains) ? metadata.domains : [],
  };
}

function todoFromMemory(memory: MemoryRecord): DesktopActivityTodoCandidate | null {
  if (memory.type !== 'desktop_activity' || memory.category !== 'activity_todo_candidate') {
    return null;
  }

  const metadata = (memory.metadata || {}) as Partial<TodoMemoryMetadata>;
  if (!metadata.sliceKey) {
    return null;
  }

  return {
    id: typeof metadata.todoKey === 'string'
      ? metadata.todoKey
      : buildTodoKey(metadata.sliceKey, memory.content),
    sliceKey: metadata.sliceKey,
    content: memory.content,
    activeForm: memory.summary || toActiveForm(memory.content),
    status: 'pending',
    confidence: metadata.confidence || memory.confidence,
    evidence: Array.isArray(metadata.evidence) ? metadata.evidence : [],
    createdAtMs: metadata.createdAtMs || memory.createdAt,
  };
}

function buildSearchSnippet(summary: DesktopActivitySliceSummary, query: string): string {
  const lower = query.toLowerCase();
  const text = buildVectorText(summary);
  const index = text.toLowerCase().indexOf(lower);

  if (index === -1) {
    return summary.summary;
  }

  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + query.length + 80);
  const snippet = text.slice(start, end).trim();
  return `${start > 0 ? '...' : ''}${snippet}${end < text.length ? '...' : ''}`;
}

function buildDesktopTaskDescription(todo: DesktopActivityTodoCandidate): string {
  const evidenceText = todo.evidence.length > 0
    ? `线索：${todo.evidence.join('；')}`
    : '线索：来自最近桌面活动时间片。';
  const confidenceText = `置信度：${Math.round(todo.confidence * 100)}%`;

  return [
    '从最近桌面活动推断出的待跟进事项。',
    `时间片：${todo.sliceKey}`,
    evidenceText,
    confidenceText,
    '这是理解层推断结果，优先级低于用户明确指令。',
  ].join('\n');
}

function buildDesktopTaskPriority(todo: DesktopActivityTodoCandidate): SessionTaskPriority {
  return todo.confidence >= 0.8 ? 'normal' : 'low';
}

export function isDesktopDerivedSessionTask(task: Pick<SessionTask, 'metadata'>): boolean {
  return task.metadata?.source === 'desktop_activity'
    && task.metadata?.sourceKind === 'activity_todo_candidate';
}

export function getDesktopTaskKey(task: Pick<SessionTask, 'metadata'>): string | null {
  return typeof task.metadata?.desktopTodoKey === 'string'
    ? task.metadata.desktopTodoKey
    : null;
}

function normalizeTaskSubject(subject: string): string {
  return subject.trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildDesktopTaskMetadata(todo: DesktopActivityTodoCandidate): Record<string, unknown> {
  return {
    source: 'desktop_activity',
    sourceKind: 'activity_todo_candidate',
    desktopTodoKey: todo.id,
    sliceKey: todo.sliceKey,
    confidence: todo.confidence,
    evidence: todo.evidence,
    createdAtMs: todo.createdAtMs,
  };
}

function shouldUpdateDesktopTask(
  task: SessionTask,
  todo: DesktopActivityTodoCandidate,
  description: string,
  metadata: Record<string, unknown>
): boolean {
  const taskMetadata = task.metadata || {};
  const sameDesktopMetadata =
    taskMetadata.source === metadata.source
    && taskMetadata.sourceKind === metadata.sourceKind
    && taskMetadata.desktopTodoKey === metadata.desktopTodoKey
    && taskMetadata.sliceKey === metadata.sliceKey
    && taskMetadata.confidence === metadata.confidence
    && taskMetadata.createdAtMs === metadata.createdAtMs
    && JSON.stringify(taskMetadata.evidence || []) === JSON.stringify(metadata.evidence || []);

  if (task.subject !== todo.content) return true;
  if (task.description !== description) return true;
  if (task.activeForm !== todo.activeForm) return true;
  return !sameDesktopMetadata;
}

function todoFeedbackFromMemory(memory: MemoryRecord): DesktopTodoFeedbackRecord | null {
  if (memory.type !== 'desktop_activity' || memory.category !== 'activity_todo_feedback') {
    return null;
  }

  const metadata = (memory.metadata || {}) as Partial<TodoFeedbackMemoryMetadata>;
  if (!metadata.todoKey || !metadata.feedbackStatus || !metadata.source) {
    return null;
  }

  return {
    todoKey: metadata.todoKey,
    status: metadata.feedbackStatus,
    sessionId: metadata.sessionId,
    taskId: metadata.taskId,
    source: metadata.source,
    resumeAtMs: metadata.resumeAtMs,
    reason: metadata.reason,
    updatedAtMs: metadata.updatedAtMs || memory.updatedAt,
  };
}

export function filterTodoCandidatesByFeedback(
  candidates: DesktopActivityTodoCandidate[],
  feedbackRecords: Iterable<DesktopTodoFeedbackRecord>,
): DesktopActivityTodoCandidate[] {
  const blockedTodoKeys = new Set<string>();
  const now = Date.now();

  for (const feedback of feedbackRecords) {
    if (feedback.status === 'completed' || feedback.status === 'dismissed') {
      blockedTodoKeys.add(feedback.todoKey);
      continue;
    }

    if (
      feedback.status === 'accepted'
      && now - feedback.updatedAtMs <= ACCEPTED_FEEDBACK_SUPPRESS_MS
    ) {
      blockedTodoKeys.add(feedback.todoKey);
      continue;
    }

    if (
      (feedback.status === 'snoozed' || feedback.status === 'superseded')
      && (
        typeof feedback.resumeAtMs !== 'number'
        || now < feedback.resumeAtMs
      )
    ) {
      blockedTodoKeys.add(feedback.todoKey);
    }
  }

  return candidates.filter((candidate) => !blockedTodoKeys.has(candidate.id));
}

export function syncDesktopTodoCandidatesToTaskStore(
  sessionId: string,
  candidates: DesktopActivityTodoCandidate[]
): DesktopTaskSyncResult {
  const existingTasks = listTasks(sessionId);
  const byDesktopKey = new Map<string, SessionTask>();
  const bySubject = new Map<string, SessionTask>();

  for (const task of existingTasks) {
    const desktopKey = getDesktopTaskKey(task);
    if (desktopKey && !byDesktopKey.has(desktopKey)) {
      byDesktopKey.set(desktopKey, task);
    }

    const subjectKey = normalizeTaskSubject(task.subject);
    if (!bySubject.has(subjectKey)) {
      bySubject.set(subjectKey, task);
    }
  }

  const created: SessionTask[] = [];
  const updated: SessionTask[] = [];
  const skipped: SessionTask[] = [];
  const supersededTodoKeys: string[] = [];

  for (const todo of candidates) {
    const description = buildDesktopTaskDescription(todo);
    const metadata = buildDesktopTaskMetadata(todo);
    const existingByKey = byDesktopKey.get(todo.id);
    const existingBySubject = bySubject.get(normalizeTaskSubject(todo.content));
    const existing = existingByKey || existingBySubject;

    if (!existing) {
      const task = createTask(sessionId, {
        subject: todo.content,
        description,
        activeForm: todo.activeForm,
        priority: buildDesktopTaskPriority(todo),
        metadata,
      });
      created.push(task);
      byDesktopKey.set(todo.id, task);
      bySubject.set(normalizeTaskSubject(todo.content), task);
      continue;
    }

    if (!existingByKey && existingBySubject) {
      skipped.push(existingBySubject);
      supersededTodoKeys.push(todo.id);
      byDesktopKey.set(todo.id, existingBySubject);
      continue;
    }

    if (!shouldUpdateDesktopTask(existing, todo, description, metadata)) {
      skipped.push(existing);
      byDesktopKey.set(todo.id, existing);
      continue;
    }

    const task = updateTask(sessionId, existing.id, {
      subject: todo.content,
      description,
      activeForm: todo.activeForm,
      metadata,
    });

    if (task) {
      updated.push(task);
      byDesktopKey.set(todo.id, task);
      bySubject.set(normalizeTaskSubject(todo.content), task);
    }
  }

  return {
    totalCandidates: candidates.length,
    created,
    updated,
    skipped,
    supersededTodoKeys,
    tasks: listTasks(sessionId),
  };
}

export class DesktopActivityUnderstandingService implements Disposable {
  private initialized = false;
  private disposed = false;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshPromise: Promise<DesktopActivityDerivationRun> | null = null;
  private lastRefreshAtMs = 0;

  constructor(private config: DesktopActivityUnderstandingConfig = DEFAULT_CONFIG) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.initialized = true;

    await this.refreshRecentActivity().catch((error) => {
      logger.warn('Initial desktop activity refresh failed', { error: String(error) });
    });

    this.refreshTimer = setInterval(() => {
      this.refreshRecentActivity().catch((error) => {
        logger.warn('Scheduled desktop activity refresh failed', { error: String(error) });
      });
    }, this.config.refreshIntervalMs);

    logger.info('Desktop activity understanding service initialized', {
      lookbackHours: this.config.lookbackHours,
      sliceMinutes: this.config.sliceMinutes,
      refreshIntervalMs: this.config.refreshIntervalMs,
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  async refreshRecentActivity(options: {
    lookbackHours?: number;
    sliceMinutes?: number;
    maxEvents?: number;
  } = {}): Promise<DesktopActivityDerivationRun> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.doRefreshRecentActivity(options)
      .finally(() => {
        this.refreshPromise = null;
      });

    return this.refreshPromise;
  }

  async ensureFreshData(maxAgeMs: number = 5 * 60 * 1000): Promise<void> {
    if (Date.now() - this.lastRefreshAtMs <= maxAgeMs) {
      return;
    }

    await this.refreshRecentActivity();
  }

  private async doRefreshRecentActivity(options: {
    lookbackHours?: number;
    sliceMinutes?: number;
    maxEvents?: number;
  }): Promise<DesktopActivityDerivationRun> {
    const lookbackHours = options.lookbackHours || this.config.lookbackHours;
    const sliceMinutes = options.sliceMinutes || this.config.sliceMinutes;
    const maxEvents = options.maxEvents || this.config.maxEventsPerRefresh;
    const now = Date.now();
    const fromMs = now - (lookbackHours * 60 * 60 * 1000);

    const events = getNativeDesktopService().getTimeline({
      from: fromMs,
      to: now,
      limit: maxEvents,
    });

    const slices = buildDesktopActivitySlices(events, sliceMinutes)
      .filter((slice) => slice.events.length >= this.config.minEventsPerSlice);

    const db = getDatabase();
    const existingSummaries = db.listMemories({
      type: 'desktop_activity',
      category: 'activity_summary',
      limit: 2000,
      orderBy: 'updated_at',
      orderDir: 'DESC',
    });
    const existingTodos = db.listMemories({
      type: 'desktop_activity',
      category: 'activity_todo_candidate',
      limit: 4000,
      orderBy: 'updated_at',
      orderDir: 'DESC',
    });

    const summaryBySlice = new Map<string, MemoryRecord>();
    for (const memory of existingSummaries) {
      const metadata = memory.metadata as Partial<SummaryMemoryMetadata>;
      if (metadata.sliceKey) {
        summaryBySlice.set(metadata.sliceKey, memory);
      }
    }

    const todosBySlice = new Map<string, MemoryRecord[]>();
    for (const memory of existingTodos) {
      const metadata = memory.metadata as Partial<TodoMemoryMetadata>;
      if (!metadata.sliceKey) continue;

      const bucket = todosBySlice.get(metadata.sliceKey) || [];
      bucket.push(memory);
      todosBySlice.set(metadata.sliceKey, bucket);
    }

    let summariesCreated = 0;
    let summariesUpdated = 0;
    let summariesUnchanged = 0;
    let todoCandidatesCreated = 0;

    for (const slice of slices) {
      const summary = summarizeDesktopActivitySlice(slice, this.config.maxSubjectsPerSlice);
      const summaryMetadata: SummaryMemoryMetadata = {
        kind: 'activity_summary',
        sliceKey: summary.sliceKey,
        fromMs: summary.fromMs,
        toMs: summary.toMs,
        lastCapturedAtMs: summary.lastCapturedAtMs,
        eventCount: summary.eventCount,
        salientSubjects: summary.salientSubjects,
        topApps: summary.topApps,
        domains: summary.domains,
        generatedAtMs: now,
      };

      const existingSummary = summaryBySlice.get(summary.sliceKey);
      let summaryMemoryId: string;
      let summaryChanged = false;

      if (!existingSummary) {
        const created = db.createMemory({
          type: 'desktop_activity',
          category: 'activity_summary',
          content: summary.summary,
          summary: summary.summary,
          source: 'session_extracted',
          confidence: Math.min(0.95, 0.55 + (summary.eventCount / 100)),
          metadata: summaryMetadata,
        });
        summaryMemoryId = created.id;
        summaryBySlice.set(summary.sliceKey, created);
        summariesCreated += 1;
        summaryChanged = true;
      } else {
        summaryMemoryId = existingSummary.id;
        const previous = summaryFromMemory(existingSummary);
        const summaryTextChanged = existingSummary.content !== summary.summary;
        const metadataChanged = JSON.stringify(previous) !== JSON.stringify(summary);

        if (summaryTextChanged || metadataChanged) {
          db.updateMemory(existingSummary.id, {
            content: summary.summary,
            summary: summary.summary,
            confidence: Math.min(0.95, 0.55 + (summary.eventCount / 100)),
            metadata: summaryMetadata,
          });
          summariesUpdated += 1;
          summaryChanged = true;
        } else {
          summariesUnchanged += 1;
        }
      }

      if (summaryChanged) {
        // Vector store indexing removed (memory module deleted)

        getEventBus().publish('memory', 'desktop_activity_summary_generated', {
          sliceKey: summary.sliceKey,
          summary: summary.summary,
          eventCount: summary.eventCount,
        }, { bridgeToRenderer: false });
      }

      const nextTodos = deriveTodoCandidatesFromSlice(slice, summary, this.config.maxTodoCandidatesPerSlice);
      const existingSliceTodos = todosBySlice.get(summary.sliceKey) || [];
      const existingTodoSignature = existingSliceTodos
        .map((item) => `${item.content}:${item.summary || ''}`)
        .sort()
        .join('|');
      const nextTodoSignature = nextTodos
        .map((item) => `${item.content}:${item.activeForm}`)
        .sort()
        .join('|');

      if (existingTodoSignature !== nextTodoSignature) {
        for (const memory of existingSliceTodos) {
          db.deleteMemory(memory.id);
        }

        for (const todo of nextTodos) {
          db.createMemory({
            type: 'desktop_activity',
            category: 'activity_todo_candidate',
            content: todo.content,
            summary: todo.activeForm,
            source: 'session_extracted',
            confidence: todo.confidence,
            metadata: {
              kind: 'activity_todo_candidate',
              sliceKey: todo.sliceKey,
              todoKey: todo.id,
              confidence: todo.confidence,
              evidence: todo.evidence,
              createdAtMs: todo.createdAtMs,
            } satisfies TodoMemoryMetadata,
          });
          todoCandidatesCreated += 1;
        }

        if (nextTodos.length > 0) {
          getEventBus().publish('memory', 'desktop_activity_todo_candidates_updated', {
            sliceKey: summary.sliceKey,
            count: nextTodos.length,
          }, { bridgeToRenderer: false });
        }
      }
    }

    const result: DesktopActivityDerivationRun = {
      scannedEvents: events.length,
      slicesConsidered: slices.length,
      summariesCreated,
      summariesUpdated,
      summariesUnchanged,
      todoCandidatesCreated,
      generatedAtMs: now,
    };

    this.lastRefreshAtMs = now;

    logger.info('Desktop activity derivation completed', result);
    return result;
  }

  listRecentSummaries(options: {
    limit?: number;
    sinceHours?: number;
  } = {}): DesktopActivitySliceSummary[] {
    const limit = options.limit || 10;
    const cutoff = options.sinceHours
      ? Date.now() - (options.sinceHours * 60 * 60 * 1000)
      : null;

    return getDatabase()
      .listMemories({
        type: 'desktop_activity',
        category: 'activity_summary',
        limit: Math.max(limit * 4, 50),
        orderBy: 'updated_at',
        orderDir: 'DESC',
      })
      .map(summaryFromMemory)
      .filter((item): item is DesktopActivitySliceSummary => item !== null)
      .filter((item) => !cutoff || item.toMs >= cutoff)
      .slice(0, limit);
  }

  listTodoCandidates(options: {
    limit?: number;
    sinceHours?: number;
  } = {}): DesktopActivityTodoCandidate[] {
    const limit = options.limit || 10;
    const cutoff = options.sinceHours
      ? Date.now() - (options.sinceHours * 60 * 60 * 1000)
      : null;

    const candidates = getDatabase()
      .listMemories({
        type: 'desktop_activity',
        category: 'activity_todo_candidate',
        limit: Math.max(limit * 4, 50),
        orderBy: 'updated_at',
        orderDir: 'DESC',
      })
      .map((memory) => ({ memory, todo: todoFromMemory(memory) }))
      .filter((item): item is { memory: MemoryRecord; todo: DesktopActivityTodoCandidate } => item.todo !== null)
      .filter((item) => !cutoff || item.todo.createdAtMs >= cutoff)
      .sort((a, b) => b.todo.confidence - a.todo.confidence || b.todo.createdAtMs - a.todo.createdAtMs)
      .map((item) => item.todo);

    return filterTodoCandidatesByFeedback(candidates, this.listTodoFeedbackRecords())
      .slice(0, limit);
  }

  listTodoItems(options: {
    limit?: number;
    sinceHours?: number;
  } = {}): TodoItem[] {
    return this.listTodoCandidates(options).map((todo) => ({
      content: todo.content,
      status: 'pending' as const,
      activeForm: todo.activeForm,
    }));
  }

  buildContextBlock(options: {
    summaryLimit?: number;
    todoLimit?: number;
    sinceHours?: number;
  } = {}): string | null {
    const summaryLimit = options.summaryLimit || 3;
    const todoLimit = options.todoLimit || 3;
    const sinceHours = options.sinceHours || 6;

    const summaries = this.listRecentSummaries({
      limit: summaryLimit,
      sinceHours,
    });
    const todos = this.listTodoCandidates({
      limit: todoLimit,
      sinceHours,
    });

    if (summaries.length === 0 && todos.length === 0) {
      return null;
    }

    const lines: string[] = ['## Recent Desktop Activity'];

    if (summaries.length > 0) {
      lines.push('');
      lines.push('Recent work slices:');
      for (const summary of summaries) {
        lines.push(`- ${formatTime(summary.fromMs)}-${formatTime(summary.toMs)}: ${summary.summary}`);
      }
    }

    if (todos.length > 0) {
      lines.push('');
      lines.push('Recovered follow-ups from desktop activity:');
      for (const todo of todos) {
        lines.push(`- [pending] ${todo.content}`);
      }
    }

    lines.push('');
    lines.push('Use this as soft context only. Prefer explicit user instructions over inferred desktop activity.');

    return lines.join('\n');
  }

  syncTodoCandidatesToTasks(
    sessionId: string,
    options: {
      limit?: number;
      sinceHours?: number;
    } = {}
  ): DesktopTaskSyncResult {
    const candidates = this.listTodoCandidates(options);
    const result = syncDesktopTodoCandidatesToTaskStore(sessionId, candidates);

    for (const todoKey of result.supersededTodoKeys) {
      this.recordTodoFeedback({
        todoKey,
        status: 'superseded',
        sessionId,
        source: 'sync',
        resumeAtMs: Date.now() + AUTO_SUPERSEDED_SUPPRESS_MS,
        reason: 'matched_existing_task',
      });
    }

    return result;
  }

  listTodoFeedbackRecords(): DesktopTodoFeedbackRecord[] {
    return getDatabase()
      .listMemories({
        type: 'desktop_activity',
        category: 'activity_todo_feedback',
        limit: 1000,
        orderBy: 'updated_at',
        orderDir: 'DESC',
      })
      .map(todoFeedbackFromMemory)
      .filter((item): item is DesktopTodoFeedbackRecord => item !== null);
  }

  recordTodoFeedback(input: {
    todoKey: string;
    status: DesktopTodoFeedbackStatus;
    sessionId?: string;
    taskId?: string;
    source: 'task' | 'plan' | 'sync';
    resumeAtMs?: number;
    reason?: string;
  }): void {
    const db = getDatabase();
    const now = Date.now();
    const existing = db.listMemories({
      type: 'desktop_activity',
      category: 'activity_todo_feedback',
      limit: 1000,
      orderBy: 'updated_at',
      orderDir: 'DESC',
    }).find((memory) => {
      const metadata = memory.metadata as Partial<TodoFeedbackMemoryMetadata>;
      return metadata.todoKey === input.todoKey;
    });

    const metadata: TodoFeedbackMemoryMetadata = {
      kind: 'activity_todo_feedback',
      todoKey: input.todoKey,
      feedbackStatus: input.status,
      sessionId: input.sessionId,
      taskId: input.taskId,
      source: input.source,
      resumeAtMs: input.resumeAtMs,
      reason: input.reason,
      updatedAtMs: now,
    };

    if (existing) {
      db.updateMemory(existing.id, {
        content: `${input.status}:${input.todoKey}`,
        summary: `${input.status} via ${input.source}`,
        confidence: 1,
        metadata,
      });
      return;
    }

    db.createMemory({
      type: 'desktop_activity',
      category: 'activity_todo_feedback',
      content: `${input.status}:${input.todoKey}`,
      summary: `${input.status} via ${input.source}`,
      source: 'session_extracted',
      confidence: 1,
      metadata,
    });
  }

  clearTodoFeedback(todoKey: string): void {
    const db = getDatabase();
    const existing = db.listMemories({
      type: 'desktop_activity',
      category: 'activity_todo_feedback',
      limit: 1000,
      orderBy: 'updated_at',
      orderDir: 'DESC',
    }).find((memory) => {
      const metadata = memory.metadata as Partial<TodoFeedbackMemoryMetadata>;
      return metadata.todoKey === todoKey;
    });

    if (existing) {
      db.deleteMemory(existing.id);
    }
  }

  recordTodoFeedbackForTask(
    task: SessionTask,
    status: DesktopTodoFeedbackStatus,
    options: {
      sessionId?: string;
      source: 'task' | 'plan' | 'sync';
      resumeAtMs?: number;
      reason?: string;
    },
  ): boolean {
    if (!isDesktopDerivedSessionTask(task)) {
      return false;
    }

    const todoKey = getDesktopTaskKey(task);
    if (!todoKey) {
      return false;
    }

    this.recordTodoFeedback({
      todoKey,
      status,
      sessionId: options.sessionId,
      taskId: task.id,
      source: options.source,
      resumeAtMs: options.resumeAtMs,
      reason: options.reason,
    });
    return true;
  }

  clearTodoFeedbackForTask(task: SessionTask): boolean {
    const todoKey = getDesktopTaskKey(task);
    if (!todoKey) {
      return false;
    }

    this.clearTodoFeedback(todoKey);
    return true;
  }

  async searchSummaries(
    query: string,
    options: {
      limit?: number;
      sinceHours?: number;
    } = {}
  ): Promise<DesktopActivitySemanticMatch[]> {
    const normalized = query.trim();
    if (!normalized) return [];

    const limit = options.limit || 5;
    const cutoff = options.sinceHours
      ? Date.now() - (options.sinceHours * 60 * 60 * 1000)
      : null;

    const db = getDatabase();
    // Vector store removed — fall back to lexical search only
    const matches: DesktopActivitySemanticMatch[] = [];
    const seen = new Set<string>();

    const lexicalMatches = db.searchMemories(normalized, {
      type: 'desktop_activity',
      category: 'activity_summary',
      limit: Math.max(limit * 2, 10),
    });

    for (const memory of lexicalMatches) {
      if (seen.has(memory.id)) continue;

      const summary = summaryFromMemory(memory);
      if (!summary) continue;
      if (cutoff && summary.toMs < cutoff) continue;

      seen.add(memory.id);
      matches.push({
        summary,
        score: 0.35,
        snippet: buildSearchSnippet(summary, normalized),
      });

      if (matches.length >= limit) {
        break;
      }
    }

    return matches;
  }
}

let desktopActivityUnderstandingService: DesktopActivityUnderstandingService | null = null;

export function getDesktopActivityUnderstandingService(): DesktopActivityUnderstandingService {
  if (!desktopActivityUnderstandingService) {
    desktopActivityUnderstandingService = new DesktopActivityUnderstandingService();
    getServiceRegistry().register('DesktopActivityUnderstandingService', desktopActivityUnderstandingService);
  }

  return desktopActivityUnderstandingService;
}

export async function initDesktopActivityUnderstandingService(
  config?: Partial<DesktopActivityUnderstandingConfig>
): Promise<DesktopActivityUnderstandingService> {
  if (config) {
    desktopActivityUnderstandingService = new DesktopActivityUnderstandingService({
      ...DEFAULT_CONFIG,
      ...config,
    });
    getServiceRegistry().register('DesktopActivityUnderstandingService', desktopActivityUnderstandingService);
  }

  const service = getDesktopActivityUnderstandingService();
  await service.initialize();
  return service;
}
