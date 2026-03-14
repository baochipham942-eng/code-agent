// ============================================================================
// Workspace Artifact Index Service - Persist/index recent office artifacts
// ============================================================================

import type { Disposable } from '../services/serviceRegistry';
import { getServiceRegistry } from '../services/serviceRegistry';
import { createLogger } from '../services/infra/logger';
import { getDatabase } from '../services';
import { getConnectorRegistry } from '../connectors';
import { getVectorStore } from './vectorStore';
import type { MemoryRecord } from '../services/core/repositories';

const logger = createLogger('WorkspaceArtifactIndexService');

type ArtifactSourceKind = 'mail' | 'calendar' | 'reminders';
type ArtifactCategory = 'mail_message' | 'calendar_event' | 'reminder_item';

interface MailboxItem {
  account: string;
  name: string;
}

interface MailMessageSummary {
  id: number;
  account?: string;
  mailbox?: string;
  subject: string;
  sender: string;
  receivedAtMs: number | null;
  read: boolean;
}

interface MailMessageDetail extends MailMessageSummary {
  content: string;
  attachments?: string[];
  attachmentCount?: number;
}

interface CalendarEventItem {
  uid: string;
  calendar: string;
  title: string;
  startAtMs: number | null;
  endAtMs: number | null;
  location?: string;
  notes?: string;
  url?: string;
}

interface ReminderItem {
  id: string;
  list: string;
  title: string;
  completed: boolean;
  notes?: string;
  remindAtMs?: number | null;
}

export interface WorkspaceArtifactIndexConfig {
  refreshIntervalMs: number;
  mailLookbackHours: number;
  maxMailboxes: number;
  maxMessagesPerMailbox: number;
  maxMailBodyReadsPerMailbox: number;
  maxMailBodyChars: number;
  maxMailAttachmentNames: number;
  calendarLookbackHours: number;
  calendarAheadHours: number;
  maxCalendarEvents: number;
  maxCalendarNotesChars: number;
  maxReminders: number;
  maxReminderNotesChars: number;
}

export interface WorkspaceArtifactIndexRun {
  indexedArtifacts: number;
  createdArtifacts: number;
  updatedArtifacts: number;
  unchangedArtifacts: number;
  generatedAtMs: number;
  warnings: string[];
  bySource: Record<ArtifactSourceKind, number>;
}

export interface IndexedWorkspaceArtifact {
  id: string;
  sourceKind: ArtifactSourceKind;
  title: string;
  snippet: string;
  score: number;
  timestampMs?: number | null;
  metadata: Record<string, unknown>;
}

export interface WorkspaceArtifactSearchOptions {
  limit?: number;
  sinceHours?: number;
  sources?: ArtifactSourceKind[];
  account?: string;
  mailboxes?: string[];
  calendar?: string;
  reminderList?: string;
  includeCompletedReminders?: boolean;
}

export interface WorkspaceArtifactSearchResult {
  items: IndexedWorkspaceArtifact[];
  warnings: string[];
  countsBySource: Record<ArtifactSourceKind, number>;
}

interface WorkspaceArtifactMemoryMetadata extends Record<string, unknown> {
  kind: 'workspace_artifact';
  sourceKind: ArtifactSourceKind;
  artifactKey: string;
  title: string;
  subtitle?: string;
  timestampMs?: number | null;
  sender?: string;
  account?: string;
  mailbox?: string;
  messageId?: number;
  attachmentCount?: number;
  attachmentNames?: string[];
  threadKey?: string;
  threadSubject?: string;
  calendar?: string;
  eventUid?: string;
  startAtMs?: number | null;
  endAtMs?: number | null;
  location?: string;
  url?: string;
  list?: string;
  reminderId?: string;
  completed?: boolean;
  bodyPreview?: string;
  notesPreview?: string;
  contentLevel?: boolean;
  indexedAtMs: number;
}

interface ArtifactSnapshot {
  sourceKind: ArtifactSourceKind;
  artifactKey: string;
  category: ArtifactCategory;
  title: string;
  summary: string;
  content: string;
  confidence: number;
  timestampMs?: number | null;
  metadata: WorkspaceArtifactMemoryMetadata;
}

const DEFAULT_CONFIG: WorkspaceArtifactIndexConfig = {
  refreshIntervalMs: 15 * 60 * 1000,
  mailLookbackHours: 72,
  maxMailboxes: 6,
  maxMessagesPerMailbox: 8,
  maxMailBodyReadsPerMailbox: 3,
  maxMailBodyChars: 1600,
  maxMailAttachmentNames: 4,
  calendarLookbackHours: 24,
  calendarAheadHours: 72,
  maxCalendarEvents: 80,
  maxCalendarNotesChars: 1000,
  maxReminders: 120,
  maxReminderNotesChars: 800,
};

function formatTimestamp(timestampMs: number | null | undefined): string {
  if (typeof timestampMs !== 'number' || !Number.isFinite(timestampMs)) {
    return '时间未知';
  }
  return new Date(timestampMs).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function buildContentPreview(value: string | null | undefined, maxChars: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  const normalized = normalizeText(value);
  if (!normalized) {
    return '';
  }
  return truncateText(normalized, maxChars);
}

function normalizeMailThreadSubject(subject: string): string {
  let normalized = normalizeText(subject);
  while (/^(re|fw|fwd)\s*:\s*/i.test(normalized)) {
    normalized = normalized.replace(/^(re|fw|fwd)\s*:\s*/i, '').trim();
  }
  return normalized;
}

function buildAttachmentPreview(
  attachments: string[] | null | undefined,
  maxNames: number,
): { names: string[]; text: string } {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return { names: [], text: '' };
  }

  const names = attachments
    .map((item) => normalizeText(item))
    .filter(Boolean)
    .slice(0, Math.max(0, maxNames));

  if (names.length === 0) {
    return { names: [], text: '' };
  }

  return {
    names,
    text: names.join(', '),
  };
}

function prioritizeMailboxes(mailboxes: MailboxItem[]): MailboxItem[] {
  const primary = /inbox|收件箱|important|vip/i;
  return [...mailboxes].sort((left, right) => {
    const leftPrimary = primary.test(left.name) ? 1 : 0;
    const rightPrimary = primary.test(right.name) ? 1 : 0;
    if (leftPrimary !== rightPrimary) return rightPrimary - leftPrimary;
    return `${left.account}/${left.name}`.localeCompare(`${right.account}/${right.name}`, 'zh-CN');
  });
}

function buildVectorText(snapshot: ArtifactSnapshot): string {
  switch (snapshot.sourceKind) {
    case 'mail':
      return `Mail subject: ${snapshot.title}\n${snapshot.content}`;
    case 'calendar':
      return `Calendar event: ${snapshot.title}\n${snapshot.content}`;
    case 'reminders':
      return `Reminder: ${snapshot.title}\n${snapshot.content}`;
  }
}

function artifactMemoryFromRecord(memory: MemoryRecord): {
  artifactKey: string;
  sourceKind: ArtifactSourceKind;
  category: ArtifactCategory;
  title: string;
  subtitle: string;
  timestampMs?: number | null;
  metadata: WorkspaceArtifactMemoryMetadata;
} | null {
  if (memory.type !== 'workspace_activity') {
    return null;
  }
  if (!['mail_message', 'calendar_event', 'reminder_item'].includes(memory.category)) {
    return null;
  }

  const metadata = asWorkspaceArtifactMemoryMetadata(memory.metadata);
  if (!metadata) {
    return null;
  }

  return {
    artifactKey: metadata.artifactKey,
    sourceKind: metadata.sourceKind,
    category: memory.category as ArtifactCategory,
    title: metadata.title,
    subtitle: metadata.subtitle || memory.summary || '',
    timestampMs: metadata.timestampMs,
    metadata,
  };
}

function asWorkspaceArtifactMemoryMetadata(
  metadata: Record<string, unknown>,
): WorkspaceArtifactMemoryMetadata | null {
  if (metadata.kind !== 'workspace_artifact') {
    return null;
  }
  if (typeof metadata.artifactKey !== 'string' || metadata.artifactKey.length === 0) {
    return null;
  }
  if (!['mail', 'calendar', 'reminders'].includes(String(metadata.sourceKind))) {
    return null;
  }
  if (typeof metadata.title !== 'string' || metadata.title.length === 0) {
    return null;
  }
  if (typeof metadata.indexedAtMs !== 'number' || !Number.isFinite(metadata.indexedAtMs)) {
    return null;
  }

  return metadata as WorkspaceArtifactMemoryMetadata;
}

function toIndexedArtifact(memory: MemoryRecord, score: number): IndexedWorkspaceArtifact | null {
  const artifact = artifactMemoryFromRecord(memory);
  if (!artifact) {
    return null;
  }

  return {
    id: memory.id,
    sourceKind: artifact.sourceKind,
    title: artifact.title,
    snippet: artifact.subtitle || memory.content,
    score,
    timestampMs: artifact.timestampMs,
    metadata: artifact.metadata,
  };
}

async function collectMailSnapshots(config: WorkspaceArtifactIndexConfig, now: number): Promise<{ artifacts: ArtifactSnapshot[]; warning?: string }> {
  const connector = getConnectorRegistry().get('mail');
  if (!connector) {
    return { artifacts: [], warning: 'mail connector unavailable' };
  }

  try {
    const mailboxesResult = await connector.execute('list_mailboxes', {});
    const mailboxes = prioritizeMailboxes((mailboxesResult.data as MailboxItem[]) || []).slice(0, config.maxMailboxes);
    const cutoff = now - (config.mailLookbackHours * 60 * 60 * 1000);
    const batches = await Promise.all(mailboxes.map(async (mailbox) => {
      const result = await connector.execute('list_messages', {
        account: mailbox.account,
        mailbox: mailbox.name,
        limit: config.maxMessagesPerMailbox,
        scan_limit: Math.max(config.maxMessagesPerMailbox * 10, 40),
      });
      const messages = ((result.data as MailMessageSummary[]) || [])
        .filter((message) => !message.receivedAtMs || message.receivedAtMs >= cutoff);

      const detailWarnings: string[] = [];
      const detailEntries = await Promise.all(messages
        .slice(0, Math.max(0, config.maxMailBodyReadsPerMailbox))
        .map(async (message) => {
          const account = message.account || mailbox.account;
          const mailboxName = message.mailbox || mailbox.name;
          const artifactKey = `mail:${account}:${mailboxName}:${message.id}`;
          try {
            const detailResult = await connector.execute('read_message', {
              account,
              mailbox: mailboxName,
              message_id: message.id,
            });
            return [artifactKey, detailResult.data as MailMessageDetail] as const;
          } catch (error) {
            detailWarnings.push(`mail-detail:${account}/${mailboxName}/#${message.id}:${error instanceof Error ? error.message : String(error)}`);
            return null;
          }
        }));

      const detailByKey = new Map<string, MailMessageDetail>();
      for (const entry of detailEntries) {
        if (entry) {
          detailByKey.set(entry[0], entry[1]);
        }
      }

      const artifacts = messages
        .map((message) => {
          const account = message.account || mailbox.account;
          const mailboxName = message.mailbox || mailbox.name;
          const artifactKey = `mail:${account}:${mailboxName}:${message.id}`;
          const receivedAt = message.receivedAtMs;
          const detail = detailByKey.get(artifactKey);
          const bodyPreview = buildContentPreview(detail?.content, config.maxMailBodyChars);
          const threadSubject = normalizeMailThreadSubject(message.subject);
          const threadKey = threadSubject.toLowerCase();
          const attachmentPreview = buildAttachmentPreview(detail?.attachments, config.maxMailAttachmentNames);
          const attachmentCount = typeof detail?.attachmentCount === 'number'
            ? detail.attachmentCount
            : (detail?.attachments?.length || 0);
          return {
            sourceKind: 'mail' as const,
            artifactKey,
            category: 'mail_message' as const,
            title: message.subject,
            summary: `${message.subject} | ${message.sender}`,
            content: [
              `邮件主题：${message.subject}`,
              `发件人：${message.sender}`,
              `邮箱：${account} / ${mailboxName}`,
              `时间：${formatTimestamp(receivedAt)}`,
              `状态：${message.read ? '已读' : '未读'}`,
              attachmentCount > 0 ? `附件：${attachmentCount} 个${attachmentPreview.text ? ` (${attachmentPreview.text})` : ''}` : '',
              bodyPreview ? `正文摘要：${bodyPreview}` : '',
            ].filter(Boolean).join('\n'),
            confidence: bodyPreview ? (message.read ? 0.78 : 0.84) : (message.read ? 0.72 : 0.78),
            timestampMs: receivedAt,
            metadata: {
              kind: 'workspace_artifact',
              sourceKind: 'mail',
              artifactKey,
              title: message.subject,
              subtitle: `${message.sender} | ${account} / ${mailboxName}`,
              timestampMs: receivedAt,
              sender: message.sender,
              account,
              mailbox: mailboxName,
              messageId: message.id,
              attachmentCount,
              attachmentNames: attachmentPreview.names.length > 0 ? attachmentPreview.names : undefined,
              threadKey,
              threadSubject,
              bodyPreview: bodyPreview || undefined,
              contentLevel: Boolean(bodyPreview || attachmentCount > 0),
              indexedAtMs: now,
            } satisfies WorkspaceArtifactMemoryMetadata,
          } satisfies ArtifactSnapshot;
        });

      return { artifacts, warning: detailWarnings.length > 0 ? detailWarnings.join('; ') : undefined };
    }));

    return {
      artifacts: batches.flatMap((batch) => batch.artifacts),
      warning: batches
        .map((batch) => batch.warning)
        .filter((warning): warning is string => Boolean(warning))
        .join('; ') || undefined,
    };
  } catch (error) {
    return { artifacts: [], warning: `mail: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function collectCalendarSnapshots(config: WorkspaceArtifactIndexConfig, now: number): Promise<{ artifacts: ArtifactSnapshot[]; warning?: string }> {
  const connector = getConnectorRegistry().get('calendar');
  if (!connector) {
    return { artifacts: [], warning: 'calendar connector unavailable' };
  }

  try {
    const result = await connector.execute('list_events', {
      from_ms: now - (config.calendarLookbackHours * 60 * 60 * 1000),
      to_ms: now + (config.calendarAheadHours * 60 * 60 * 1000),
      limit: config.maxCalendarEvents,
    });

    const artifacts = ((result.data as CalendarEventItem[]) || []).map((event) => {
      const eventTime = event.startAtMs ?? event.endAtMs;
      const artifactKey = `calendar:${event.uid}`;
      const notesPreview = buildContentPreview(event.notes, config.maxCalendarNotesChars);
      return {
        sourceKind: 'calendar' as const,
        artifactKey,
        category: 'calendar_event' as const,
        title: event.title,
        summary: `${event.title} | ${event.calendar}`,
        content: [
          `日历事件：${event.title}`,
          `日历：${event.calendar}`,
          `开始：${formatTimestamp(event.startAtMs)}`,
          `结束：${formatTimestamp(event.endAtMs)}`,
          event.location ? `地点：${event.location}` : '',
          event.url ? `链接：${event.url}` : '',
          notesPreview ? `描述摘要：${notesPreview}` : '',
        ].filter(Boolean).join('\n'),
        confidence: notesPreview || event.url ? 0.86 : 0.8,
        timestampMs: eventTime,
        metadata: {
          kind: 'workspace_artifact',
          sourceKind: 'calendar',
          artifactKey,
          title: event.title,
          subtitle: `${event.calendar}${event.location ? ` | ${event.location}` : ''}${notesPreview ? ' | 含描述' : ''}`,
          timestampMs: eventTime,
          calendar: event.calendar,
          eventUid: event.uid,
          startAtMs: event.startAtMs,
          endAtMs: event.endAtMs,
          location: event.location,
          url: event.url,
          notesPreview: notesPreview || undefined,
          contentLevel: Boolean(notesPreview || event.url),
          indexedAtMs: now,
        } satisfies WorkspaceArtifactMemoryMetadata,
      } satisfies ArtifactSnapshot;
    });

    return { artifacts };
  } catch (error) {
    return { artifacts: [], warning: `calendar: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function collectReminderSnapshots(config: WorkspaceArtifactIndexConfig, now: number): Promise<{ artifacts: ArtifactSnapshot[]; warning?: string }> {
  const connector = getConnectorRegistry().get('reminders');
  if (!connector) {
    return { artifacts: [], warning: 'reminders connector unavailable' };
  }

  try {
    const result = await connector.execute('list_reminders', {
      include_completed: true,
      limit: config.maxReminders,
    });

    const artifacts = ((result.data as ReminderItem[]) || []).map((reminder) => {
      const artifactKey = `reminder:${reminder.id}`;
      const notesPreview = buildContentPreview(reminder.notes, config.maxReminderNotesChars);
      return {
        sourceKind: 'reminders' as const,
        artifactKey,
        category: 'reminder_item' as const,
        title: reminder.title,
        summary: `${reminder.title} | ${reminder.list}`,
        content: [
          `提醒事项：${reminder.title}`,
          `列表：${reminder.list}`,
          `状态：${reminder.completed ? '已完成' : '未完成'}`,
          typeof reminder.remindAtMs === 'number' ? `提醒时间：${formatTimestamp(reminder.remindAtMs)}` : '',
          notesPreview ? `备注摘要：${notesPreview}` : '',
        ].filter(Boolean).join('\n'),
        confidence: notesPreview ? (reminder.completed ? 0.74 : 0.82) : (reminder.completed ? 0.68 : 0.76),
        timestampMs: reminder.remindAtMs ?? null,
        metadata: {
          kind: 'workspace_artifact',
          sourceKind: 'reminders',
          artifactKey,
          title: reminder.title,
          subtitle: `${reminder.list}${reminder.completed ? ' | 已完成' : ''}${notesPreview ? ' | 含备注' : ''}`,
          timestampMs: reminder.remindAtMs ?? null,
          list: reminder.list,
          reminderId: reminder.id,
          completed: reminder.completed,
          notesPreview: notesPreview || undefined,
          contentLevel: Boolean(notesPreview),
          indexedAtMs: now,
        } satisfies WorkspaceArtifactMemoryMetadata,
      } satisfies ArtifactSnapshot;
    });

    return { artifacts };
  } catch (error) {
    return { artifacts: [], warning: `reminders: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function matchesArtifactFilters(
  artifact: IndexedWorkspaceArtifact,
  options: WorkspaceArtifactSearchOptions,
  cutoff: number | null,
): boolean {
  if (cutoff && artifact.timestampMs && artifact.timestampMs < cutoff) {
    return false;
  }

  const metadata = asWorkspaceArtifactMemoryMetadata(artifact.metadata);
  if (!metadata) {
    return false;
  }
  if (options.sources && options.sources.length > 0 && !options.sources.includes(artifact.sourceKind)) {
    return false;
  }

  if (artifact.sourceKind === 'mail') {
    if (options.account && metadata.account !== options.account) return false;
    if (options.mailboxes && options.mailboxes.length > 0 && !options.mailboxes.includes(metadata.mailbox || '')) {
      return false;
    }
  }

  if (artifact.sourceKind === 'calendar') {
    if (options.calendar && metadata.calendar !== options.calendar) return false;
  }

  if (artifact.sourceKind === 'reminders') {
    if (options.reminderList && metadata.list !== options.reminderList) return false;
    if (options.includeCompletedReminders !== true && metadata.completed === true) {
      return false;
    }
  }

  return true;
}

export class WorkspaceArtifactIndexService implements Disposable {
  private config: WorkspaceArtifactIndexConfig;
  private initialized = false;
  private disposed = false;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshPromise: Promise<WorkspaceArtifactIndexRun> | null = null;
  private lastRefreshAtMs = 0;

  constructor(config: Partial<WorkspaceArtifactIndexConfig> = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    await this.refreshRecentArtifacts().catch((error) => {
      logger.warn('Initial workspace artifact refresh failed', { error: String(error) });
    });

    this.refreshTimer = setInterval(() => {
      this.refreshRecentArtifacts().catch((error) => {
        logger.warn('Scheduled workspace artifact refresh failed', { error: String(error) });
      });
    }, this.config.refreshIntervalMs);

    logger.info('Workspace artifact index service initialized', {
      refreshIntervalMs: this.config.refreshIntervalMs,
      maxMailboxes: this.config.maxMailboxes,
      maxMessagesPerMailbox: this.config.maxMessagesPerMailbox,
      maxCalendarEvents: this.config.maxCalendarEvents,
      maxReminders: this.config.maxReminders,
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

  async ensureFreshData(maxAgeMs: number = 10 * 60 * 1000): Promise<void> {
    if (Date.now() - this.lastRefreshAtMs <= maxAgeMs) {
      return;
    }
    await this.refreshRecentArtifacts();
  }

  async refreshRecentArtifacts(): Promise<WorkspaceArtifactIndexRun> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.doRefreshRecentArtifacts()
      .finally(() => {
        this.refreshPromise = null;
      });
    return this.refreshPromise;
  }

  private async doRefreshRecentArtifacts(): Promise<WorkspaceArtifactIndexRun> {
    const now = Date.now();
    const warnings: string[] = [];
    const [mailBatch, calendarBatch, reminderBatch] = await Promise.all([
      collectMailSnapshots(this.config, now),
      collectCalendarSnapshots(this.config, now),
      collectReminderSnapshots(this.config, now),
    ]);

    for (const warning of [mailBatch.warning, calendarBatch.warning, reminderBatch.warning]) {
      if (warning) warnings.push(warning);
    }

    const artifacts = [...mailBatch.artifacts, ...calendarBatch.artifacts, ...reminderBatch.artifacts];
    const db = getDatabase();
    const vectorStore = getVectorStore();
    const existingMemories = db.listMemories({
      type: 'workspace_activity',
      limit: 5000,
      orderBy: 'updated_at',
      orderDir: 'DESC',
    });

    const existingByKey = new Map<string, MemoryRecord>();
    for (const memory of existingMemories) {
      const artifact = artifactMemoryFromRecord(memory);
      if (artifact) {
        existingByKey.set(artifact.artifactKey, memory);
      }
    }

    let createdArtifacts = 0;
    let updatedArtifacts = 0;
    let unchangedArtifacts = 0;
    let indexedArtifacts = 0;
    let vectorStoreChanged = false;

    for (const artifact of artifacts) {
      const existing = existingByKey.get(artifact.artifactKey);
      let memoryId: string;
      let changed = false;

      if (!existing) {
        const created = db.createMemory({
          type: 'workspace_activity',
          category: artifact.category,
          content: artifact.content,
          summary: artifact.summary,
          source: 'session_extracted',
          confidence: artifact.confidence,
          metadata: artifact.metadata,
        });
        memoryId = created.id;
        createdArtifacts += 1;
        changed = true;
      } else {
        memoryId = existing.id;
        const metadataChanged = JSON.stringify(existing.metadata) !== JSON.stringify(artifact.metadata);
        if (
          existing.content !== artifact.content
          || (existing.summary || '') !== artifact.summary
          || metadataChanged
          || existing.category !== artifact.category
        ) {
          db.updateMemory(existing.id, {
            category: artifact.category,
            content: artifact.content,
            summary: artifact.summary,
            confidence: artifact.confidence,
            metadata: artifact.metadata,
          });
          updatedArtifacts += 1;
          changed = true;
        } else {
          unchangedArtifacts += 1;
        }
      }

      if (changed) {
        try {
          vectorStore.deleteByMetadata({
            source: 'knowledge',
            category: 'workspace_artifact',
            artifactKey: artifact.artifactKey,
          });
          await vectorStore.add(buildVectorText(artifact), {
            source: 'knowledge',
            category: 'workspace_artifact',
            sourceKind: artifact.sourceKind,
            artifactKey: artifact.artifactKey,
            memoryId,
            timestampMs: artifact.timestampMs,
            createdAt: artifact.timestampMs || now,
          });
          vectorStoreChanged = true;
        } catch (error) {
          warnings.push(`vector:${artifact.artifactKey}:${error instanceof Error ? error.message : String(error)}`);
        }
      }

      indexedArtifacts += 1;
    }

    if (vectorStoreChanged) {
      await vectorStore.save().catch((error) => {
        warnings.push(`vector-save:${error instanceof Error ? error.message : String(error)}`);
      });
    }

    this.lastRefreshAtMs = now;

    return {
      indexedArtifacts,
      createdArtifacts,
      updatedArtifacts,
      unchangedArtifacts,
      generatedAtMs: now,
      warnings,
      bySource: {
        mail: mailBatch.artifacts.length,
        calendar: calendarBatch.artifacts.length,
        reminders: reminderBatch.artifacts.length,
      },
    };
  }

  searchArtifacts(
    query: string,
    options: WorkspaceArtifactSearchOptions = {},
  ): WorkspaceArtifactSearchResult {
    const normalized = query.trim();
    if (!normalized) {
      return {
        items: [],
        warnings: [],
        countsBySource: { mail: 0, calendar: 0, reminders: 0 },
      };
    }

    const limit = options.limit || 8;
    const cutoff = options.sinceHours
      ? Date.now() - (options.sinceHours * 60 * 60 * 1000)
      : null;
    const db = getDatabase();
    const vectorStore = getVectorStore();
    const seen = new Set<string>();
    const matches: IndexedWorkspaceArtifact[] = [];

    const semanticResults = vectorStore.search(normalized, {
      topK: Math.max(limit * 6, 20),
      filter: {
        source: 'knowledge',
        category: 'workspace_artifact',
      },
    });

    for (const result of semanticResults) {
      const memoryId = typeof result.document.metadata.memoryId === 'string'
        ? result.document.metadata.memoryId
        : null;
      if (!memoryId || seen.has(memoryId)) continue;

      const memory = db.getMemory(memoryId);
      if (!memory) continue;

      const artifact = toIndexedArtifact(memory, result.score);
      if (!artifact) continue;
      if (!matchesArtifactFilters(artifact, options, cutoff)) continue;

      seen.add(memoryId);
      matches.push(artifact);
      if (matches.length >= limit) {
        break;
      }
    }

    if (matches.length < limit) {
      const lexicalMatches = db.searchMemories(normalized, {
        type: 'workspace_activity',
        limit: Math.max(limit * 4, 20),
      });

      for (const memory of lexicalMatches) {
        if (seen.has(memory.id)) continue;
        const artifact = toIndexedArtifact(memory, 0.35);
        if (!artifact) continue;
        if (!matchesArtifactFilters(artifact, options, cutoff)) continue;

        seen.add(memory.id);
        matches.push(artifact);
        if (matches.length >= limit) {
          break;
        }
      }
    }

    const countsBySource: Record<ArtifactSourceKind, number> = {
      mail: 0,
      calendar: 0,
      reminders: 0,
    };
    for (const match of matches) {
      countsBySource[match.sourceKind] += 1;
    }

    return {
      items: matches,
      warnings: [],
      countsBySource,
    };
  }
}

let workspaceArtifactIndexService: WorkspaceArtifactIndexService | null = null;

export function getWorkspaceArtifactIndexService(): WorkspaceArtifactIndexService {
  if (!workspaceArtifactIndexService) {
    workspaceArtifactIndexService = new WorkspaceArtifactIndexService();
    getServiceRegistry().register('WorkspaceArtifactIndexService', workspaceArtifactIndexService);
  }
  return workspaceArtifactIndexService;
}

export async function initWorkspaceArtifactIndexService(
  config?: Partial<WorkspaceArtifactIndexConfig>,
): Promise<WorkspaceArtifactIndexService> {
  if (config) {
    workspaceArtifactIndexService = new WorkspaceArtifactIndexService({
      ...DEFAULT_CONFIG,
      ...config,
    });
    getServiceRegistry().register('WorkspaceArtifactIndexService', workspaceArtifactIndexService);
  }

  const service = getWorkspaceArtifactIndexService();
  await service.initialize();
  return service;
}
