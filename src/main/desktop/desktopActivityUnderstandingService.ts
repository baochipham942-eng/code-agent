// ============================================================================
// Desktop Activity Understanding Service
// ============================================================================
// Turns raw native desktop activity into derived memory artifacts:
// - time-slice summaries
// - todo candidates
// - semantic retrieval over derived summaries
// ============================================================================

import type {
  DesktopActivitySemanticMatch,
  DesktopActivitySliceSummary,
  DesktopActivityTodoCandidate,
  SessionTask,
  TodoItem,
} from '../../shared/contract';
import { getNativeDesktopService } from '../services/desktop/nativeDesktopService';
import { createLogger } from '../services/infra/logger';
import { getDatabase } from '../services/core/databaseService';
import type { MemoryRecord } from '../protocol/types';
import { getEventBus } from '../services/eventing';
import type { Disposable } from '../services/serviceRegistry';
import { getServiceRegistry } from '../services/serviceRegistry';
import {
  AUTO_SUPERSEDED_SUPPRESS_MS,
  DEFAULT_CONFIG,
  buildDesktopActivitySlices,
  buildSearchSnippet,
  deriveTodoCandidatesFromSlice,
  filterTodoCandidatesByFeedback,
  formatTime,
  getDesktopTaskKey,
  isDesktopDerivedSessionTask,
  summaryFromMemory,
  summarizeDesktopActivitySlice,
  syncDesktopTodoCandidatesToTaskStore,
  todoFeedbackFromMemory,
  todoFromMemory,
} from './desktopActivityDerivation';
import type {
  DesktopActivityDerivationRun,
  DesktopActivityUnderstandingConfig,
  DesktopTaskSyncResult,
  DesktopTodoFeedbackRecord,
  DesktopTodoFeedbackStatus,
  SummaryMemoryMetadata,
  TodoFeedbackMemoryMetadata,
  TodoMemoryMetadata,
} from './desktopActivityDerivation';

const logger = createLogger('DesktopActivityUnderstanding');

export {
  buildDesktopActivitySlices,
  deriveTodoCandidatesFromSlice,
  filterTodoCandidatesByFeedback,
  getDesktopTaskKey,
  isDesktopDerivedSessionTask,
  summarizeDesktopActivitySlice,
  syncDesktopTodoCandidatesToTaskStore,
} from './desktopActivityDerivation';

export type {
  DesktopActivityDerivationRun,
  DesktopActivitySlice,
  DesktopActivityUnderstandingConfig,
  DesktopTaskSyncResult,
  DesktopTodoFeedbackRecord,
  DesktopTodoFeedbackStatus,
} from './desktopActivityDerivation';

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
        summaryBySlice.set(summary.sliceKey, created);
        summariesCreated += 1;
        summaryChanged = true;
      } else {
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
