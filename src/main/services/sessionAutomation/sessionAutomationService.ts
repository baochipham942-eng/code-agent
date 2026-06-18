// ============================================================================
// SessionAutomationService — 会话级自动化状态与回流消息
// ============================================================================

import { randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type {
  Message,
  MessageMetadata,
  SessionAutomationConfig,
  SessionAutomationEventKind,
  SessionAutomationNextStageConfig,
  SessionAutomationRecord,
  SessionAutomationSessionSummary,
  SessionAutomationStatus,
  SessionAutomationSummaryItem,
  SessionAutomationType,
  UpsertSessionAutomationInput,
} from '../../../shared/contract';
import { getDatabase } from '../core/databaseService';
import { getSessionManager } from '../infra/sessionManager';
import { createLogger } from '../infra/logger';

const logger = createLogger('SessionAutomationService');

type SessionAutomationRow = {
  id: string;
  source_session_id: string;
  type: SessionAutomationType;
  status: SessionAutomationStatus;
  title: string;
  cadence_label?: string | null;
  next_run_at?: number | null;
  last_run_at?: number | null;
  source_ref_id?: string | null;
  result_session_id?: string | null;
  config_json?: string | null;
  created_at: number;
  updated_at: number;
};

export interface RecordAutomationEventInput {
  automationId?: string;
  type?: SessionAutomationType;
  sourceRefId?: string;
  event: SessionAutomationEventKind;
  /** Status displayed in the feedback message. */
  status?: SessionAutomationStatus;
  /** Status persisted on the automation record after this event. Defaults to status. */
  recordStatus?: SessionAutomationStatus;
  title?: string;
  summary?: string;
  resultSessionId?: string;
  error?: string;
  eventId?: string;
  nextRunAt?: number;
  lastRunAt?: number;
  configPatch?: SessionAutomationConfig;
}

const ACTIVE_STATUSES = new Set<SessionAutomationStatus>(['active', 'running', 'paused']);
const RUNNING_STATUSES = new Set<SessionAutomationStatus>(['running']);

function parseJsonRecord(raw: unknown): SessionAutomationConfig {
  if (typeof raw !== 'string' || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as SessionAutomationConfig
      : {};
  } catch {
    return {};
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function nextStageValue(value: unknown): SessionAutomationNextStageConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const prompt = stringValue(raw.prompt);
  const goal = stringValue(raw.goal);
  const title = stringValue(raw.title);
  if (!prompt && !goal && !title) return undefined;
  return { ...(prompt ? { prompt } : {}), ...(goal ? { goal } : {}), ...(title ? { title } : {}) };
}

function getNextStage(record: SessionAutomationRecord): SessionAutomationNextStageConfig | undefined {
  return nextStageValue(record.config?.nextStage);
}

function getHandoffPrompt(record: SessionAutomationRecord): string | undefined {
  const explicitPrompt = stringValue(record.config?.handoffPrompt);
  if (explicitPrompt) return explicitPrompt;
  const nextStage = getNextStage(record);
  return stringValue(nextStage?.prompt) ?? stringValue(nextStage?.goal);
}

function shouldTriggerNextStep(input: RecordAutomationEventInput): boolean {
  if (input.event === 'completed' || input.event === 'stage_ready') return true;
  return input.status === 'completed';
}

function rowToRecord(row: SessionAutomationRow): SessionAutomationRecord {
  return {
    id: row.id,
    sourceSessionId: row.source_session_id,
    type: row.type,
    status: row.status,
    title: row.title,
    cadenceLabel: row.cadence_label ?? undefined,
    nextRunAt: row.next_run_at ?? undefined,
    lastRunAt: row.last_run_at ?? undefined,
    sourceRefId: row.source_ref_id ?? undefined,
    resultSessionId: row.result_session_id ?? undefined,
    config: parseJsonRecord(row.config_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getDb(): BetterSqlite3.Database | null {
  return getDatabase().getDb();
}

function statusLabel(status: SessionAutomationStatus): string {
  switch (status) {
    case 'active': return '已启用';
    case 'running': return '运行中';
    case 'completed': return '已完成';
    case 'failed': return '失败';
    case 'paused': return '已暂停';
    case 'cancelled': return '已停止';
    case 'skipped': return '已跳过';
    case 'archived': return '已归档';
    default: return status;
  }
}

function formatTimestamp(ts?: number): string | undefined {
  if (!ts) return undefined;
  try {
    return new Date(ts).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return undefined;
  }
}

function formatShortRemaining(ts?: number): string | undefined {
  if (!ts) return undefined;
  const delta = ts - Date.now();
  if (delta <= 0) return '现在';
  const minutes = Math.ceil(delta / 60_000);
  if (minutes < 60) return `${minutes} 分`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.ceil(hours / 24);
  return `${days} 天`;
}

function buildCreationMessage(record: SessionAutomationRecord): string {
  const lines = [`自动化已创建：${record.title}`];
  if (record.cadenceLabel) lines.push(`频率：${record.cadenceLabel}`);
  const nextRun = formatTimestamp(record.nextRunAt);
  if (nextRun) lines.push(`下次运行：${nextRun}`);
  lines.push(`状态：${statusLabel(record.status)}`);
  return lines.join('\n');
}

function buildEventMessage(record: SessionAutomationRecord, input: RecordAutomationEventInput): string {
  const handoffPrompt = shouldTriggerNextStep(input) ? getHandoffPrompt(record) : undefined;
  const nextStage = getNextStage(record);
  const heading = input.event === 'stage_ready'
    ? `阶段已就绪：${input.title || record.title}`
    : `自动化${statusLabel(input.status ?? record.status)}：${input.title || record.title}`;
  const lines = [heading];
  if (input.summary?.trim()) lines.push(input.summary.trim());
  if (input.error?.trim()) lines.push(`错误：${input.error.trim()}`);
  if (input.resultSessionId) lines.push(`结果会话：${input.resultSessionId}`);
  if (handoffPrompt) {
    lines.push(`下一步：已发送交接提示词${nextStage?.title ? `「${nextStage.title}」` : ''}`);
  }
  const nextRun = formatTimestamp(input.nextRunAt ?? record.nextRunAt);
  if (nextRun && ACTIVE_STATUSES.has(input.status ?? record.status)) {
    lines.push(`下次运行：${nextRun}`);
  }
  return lines.join('\n');
}

function summaryItem(record: SessionAutomationRecord): SessionAutomationSummaryItem {
  return {
    id: record.id,
    type: record.type,
    status: record.status,
    title: record.title,
    cadenceLabel: record.cadenceLabel,
    nextRunAt: record.nextRunAt,
    lastRunAt: record.lastRunAt,
    sourceRefId: record.sourceRefId,
    resultSessionId: record.resultSessionId,
  };
}

export class SessionAutomationService {
  upsert(input: UpsertSessionAutomationInput): SessionAutomationRecord {
    const db = getDb();
    if (!db) throw new Error('Database not initialized');
    const now = Date.now();
    const existing = input.id
      ? this.getById(input.id)
      : input.sourceRefId
        ? this.getBySourceRef(input.type, input.sourceRefId)
        : null;
    const record: SessionAutomationRecord = {
      id: existing?.id ?? input.id ?? `automation_${randomUUID()}`,
      sourceSessionId: input.sourceSessionId,
      type: input.type,
      status: input.status ?? existing?.status ?? 'active',
      title: input.title,
      cadenceLabel: input.cadenceLabel ?? existing?.cadenceLabel,
      nextRunAt: input.nextRunAt ?? existing?.nextRunAt,
      lastRunAt: input.lastRunAt ?? existing?.lastRunAt,
      sourceRefId: input.sourceRefId ?? existing?.sourceRefId,
      resultSessionId: input.resultSessionId ?? existing?.resultSessionId,
      config: {
        ...(existing?.config ?? {}),
        ...(input.config ?? {}),
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    db.prepare(`
      INSERT OR REPLACE INTO session_automations
      (id, source_session_id, type, status, title, cadence_label, next_run_at, last_run_at, source_ref_id, result_session_id, config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.sourceSessionId,
      record.type,
      record.status,
      record.title,
      record.cadenceLabel ?? null,
      record.nextRunAt ?? null,
      record.lastRunAt ?? null,
      record.sourceRefId ?? null,
      record.resultSessionId ?? null,
      JSON.stringify(record.config ?? {}),
      record.createdAt,
      record.updatedAt,
    );
    return record;
  }

  getById(id: string): SessionAutomationRecord | null {
    const db = getDb();
    if (!db) return null;
    const row = db.prepare('SELECT * FROM session_automations WHERE id = ?').get(id) as SessionAutomationRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  getBySourceRef(type: SessionAutomationType, sourceRefId: string): SessionAutomationRecord | null {
    const db = getDb();
    if (!db) return null;
    const row = db.prepare(`
      SELECT * FROM session_automations
      WHERE type = ? AND source_ref_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(type, sourceRefId) as SessionAutomationRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  listBySessionIds(sessionIds: string[]): SessionAutomationRecord[] {
    const db = getDb();
    const ids = [...new Set(sessionIds.filter(Boolean))];
    if (!db || ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT * FROM session_automations
      WHERE source_session_id IN (${placeholders})
      ORDER BY
        CASE status WHEN 'running' THEN 0 WHEN 'active' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,
        COALESCE(next_run_at, 9223372036854775807) ASC,
        updated_at DESC
    `).all(...ids) as SessionAutomationRow[];
    return rows.map(rowToRecord);
  }

  summarizeSessions(sessionIds: string[]): Record<string, SessionAutomationSessionSummary> {
    const records = this.listBySessionIds(sessionIds);
    const bySession = new Map<string, SessionAutomationRecord[]>();
    for (const record of records) {
      const list = bySession.get(record.sourceSessionId) ?? [];
      list.push(record);
      bySession.set(record.sourceSessionId, list);
    }

    const result: Record<string, SessionAutomationSessionSummary> = {};
    for (const sessionId of sessionIds) {
      const list = bySession.get(sessionId) ?? [];
      const active = list.filter((record) => ACTIVE_STATUSES.has(record.status));
      const running = list.filter((record) => RUNNING_STATUSES.has(record.status));
      const nextRunAt = active
        .map((record) => record.nextRunAt)
        .filter((value): value is number => typeof value === 'number')
        .sort((a, b) => a - b)[0];
      const label = running.length > 0
        ? '运行中'
        : active.length > 1
          ? `${active.length} 个`
          : formatShortRemaining(nextRunAt) ?? active[0]?.cadenceLabel;
      const tooltip = list.length === 0
        ? ''
        : list.slice(0, 6).map((record) => {
            const schedule = record.nextRunAt ? ` · ${formatTimestamp(record.nextRunAt)}` : record.cadenceLabel ? ` · ${record.cadenceLabel}` : '';
            return `${record.title} · ${statusLabel(record.status)}${schedule}`;
          }).join('\n');
      result[sessionId] = {
        sessionId,
        total: list.length,
        activeCount: active.length,
        runningCount: running.length,
        nextRunAt,
        label,
        tooltip,
        items: list.map(summaryItem),
      };
    }
    return result;
  }

  async recordCreated(input: UpsertSessionAutomationInput): Promise<SessionAutomationRecord> {
    const record = this.upsert(input);
    await this.writeAutomationMessage(record, 'created', buildCreationMessage(record), `created:${record.id}`);
    return record;
  }

  async recordEvent(input: RecordAutomationEventInput): Promise<SessionAutomationRecord | null> {
    const existing = input.automationId
      ? this.getById(input.automationId)
      : input.type && input.sourceRefId
        ? this.getBySourceRef(input.type, input.sourceRefId)
        : null;
    if (!existing) return null;

    const nextConfig = input.configPatch
      ? { ...(existing.config ?? {}), ...input.configPatch }
      : existing.config;
    const record = this.upsert({
      id: existing.id,
      sourceSessionId: existing.sourceSessionId,
      type: existing.type,
      status: input.recordStatus ?? input.status ?? existing.status,
      title: input.title ?? existing.title,
      cadenceLabel: existing.cadenceLabel,
      nextRunAt: input.nextRunAt ?? existing.nextRunAt,
      lastRunAt: input.lastRunAt ?? Date.now(),
      sourceRefId: existing.sourceRefId,
      resultSessionId: input.resultSessionId ?? existing.resultSessionId,
      config: nextConfig,
    });

    await this.writeAutomationMessage(
      record,
      input.event,
      buildEventMessage(record, input),
      input.eventId ?? `${input.event}:${record.id}:${input.resultSessionId ?? record.updatedAt}`,
    );
    if (shouldTriggerNextStep(input)) {
      void this.runConfiguredNextStep(record, input)
        .catch((error) => logger.warn('Failed to run configured automation next step', {
          automationId: record.id,
          sourceSessionId: record.sourceSessionId,
          error: String(error),
        }));
    }
    return record;
  }

  private async writeAutomationMessage(
    record: SessionAutomationRecord,
    event: SessionAutomationEventKind,
    content: string,
    eventId: string,
  ): Promise<void> {
    if (!record.sourceSessionId) return;
    const message: Message = {
      id: `automation:${eventId}`,
      role: 'assistant',
      source: 'automation',
      content,
      timestamp: Date.now(),
      isMeta: true,
      metadata: {
        automation: {
          automationId: record.id,
          automationType: record.type,
          event,
          sourceSessionId: record.sourceSessionId,
          sourceRefId: record.sourceRefId,
          resultSessionId: record.resultSessionId,
          status: record.status,
          title: record.title,
          cadenceLabel: record.cadenceLabel,
          nextRunAt: record.nextRunAt,
          lastRunAt: record.lastRunAt,
          handoffPrompt: getHandoffPrompt(record),
          nextStage: getNextStage(record),
        },
      },
    };
    try {
      await getSessionManager().addMessageToSession(record.sourceSessionId, message);
    } catch (error) {
      logger.warn('Failed to write automation message', {
        automationId: record.id,
        sourceSessionId: record.sourceSessionId,
        error: String(error),
      });
    }
  }

  private async runConfiguredNextStep(
    record: SessionAutomationRecord,
    input: RecordAutomationEventInput,
  ): Promise<void> {
    const prompt = getHandoffPrompt(record);
    if (!prompt || !record.sourceSessionId) return;
    const nextStage = getNextStage(record);
    const clientMessageId = `automation:handoff:${input.eventId ?? input.event}:${record.id}:${Date.now()}`;
    const messageMetadata: MessageMetadata = {
      automation: {
        automationId: record.id,
        automationType: record.type,
        event: 'stage_ready',
        sourceSessionId: record.sourceSessionId,
        sourceRefId: record.sourceRefId,
        resultSessionId: input.resultSessionId ?? record.resultSessionId,
        status: 'running',
        title: nextStage?.title ?? record.title,
        cadenceLabel: record.cadenceLabel,
        nextRunAt: record.nextRunAt,
        lastRunAt: input.lastRunAt ?? record.lastRunAt,
        handoffPrompt: prompt,
        nextStage,
      },
    };

    try {
      const { getTaskManager } = await import('../../task');
      const taskManager = getTaskManager();
      const state = taskManager.getSessionState(record.sourceSessionId);
      if (state.status === 'idle' || state.status === 'error') {
        await taskManager.startTask(record.sourceSessionId, prompt, undefined, undefined, messageMetadata, clientMessageId);
      } else {
        await taskManager.interruptAndContinue(record.sourceSessionId, prompt, undefined, undefined, messageMetadata, clientMessageId);
      }
    } catch (error) {
      logger.warn('Automation next step could not start; writing prompt back as visible user message', {
        automationId: record.id,
        sourceSessionId: record.sourceSessionId,
        error: String(error),
      });
      await getSessionManager().addMessageToSession(record.sourceSessionId, {
        id: clientMessageId,
        role: 'user',
        source: 'automation',
        content: prompt,
        timestamp: Date.now(),
        metadata: messageMetadata,
      });
    }
  }
}

let instance: SessionAutomationService | null = null;

export function getSessionAutomationService(): SessionAutomationService {
  if (!instance) instance = new SessionAutomationService();
  return instance;
}
