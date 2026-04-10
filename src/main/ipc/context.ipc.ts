// ============================================================================
// Context IPC Handler - /context observability command
// Exposes the API-true view after projection, token distribution,
// and compression status to the renderer.
// ============================================================================

import { ipcMain } from '../platform';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { AgentApplicationService } from '../../shared/types/appService';
import type { Message } from '../../shared/types';
import { ProjectionEngine, type ProjectableMessage } from '../context/projectionEngine';
import { CompressionState, type CompressionCommit } from '../context/compressionState';
import { estimateTokens } from '../context/tokenEstimator';
import { getContextHealthService } from '../context/contextHealthService';
import { createEmptyHealthState } from '../../shared/types/contextHealth';
import { getContextInterventionState } from '../context/contextInterventionState';
import { applyInterventionsToMessages } from '../context/contextInterventionHelpers';
import { getSubagentContextStore, type SubagentContextAnnotation } from '../context/subagentContextStore';
import { getContextEventLedger, type ContextEventRecord } from '../context/contextEventLedger';
import type {
  ContextInterventionRequest,
  ContextInterventionStatus,
  ContextInterventionSetRequest,
  ContextInterventionSnapshot,
  ContextItemProvenance,
  ContextItemView,
  ContextProvenanceCategory,
  ContextProvenanceAction,
  ContextModificationType,
  ContextProvenanceEntry,
  ContextProvenanceListEntry,
  ContextProvenanceSource,
  ContextSelectionEntry,
  ContextSelectionMode,
  ContextSelectionState,
  ContextViewResponse as SharedContextViewResponse,
  ContextViewRequest,
  ContextViewResponse,
} from '../../shared/types/contextView';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ContextIPC');
const interventionState = getContextInterventionState();

// ----------------------------------------------------------------------------
// Public types
// ----------------------------------------------------------------------------

interface ContextViewDependencies {
  getAppService: () => AgentApplicationService | null;
}
// ----------------------------------------------------------------------------
// Pure function — injectable for testing
// ----------------------------------------------------------------------------

const engine = new ProjectionEngine();

function normalizeMessages(messages: Message[]): ProjectableMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content || '',
  }));
}

function estimateConversationTotalTokens(messages: ProjectableMessage[]): number {
  let total = 3;
  for (const message of messages) {
    total += 4;
    total += estimateTokens(message.content);
  }
  return total;
}

function buildEmptyResponse(maxTokens: number): ContextViewResponse {
  const defaultInterventions: ContextInterventionSnapshot = {
    pinned: [],
    excluded: [],
    retained: [],
  };

  const defaultSelections: ContextSelectionState = {
    sessionId: '',
    entries: [],
  };

  return {
    sessionId: '',
    totalTokens: 0,
    maxTokens,
    usagePercent: 0,
    messageCount: 0,
    tokenDistribution: {
      system: 0,
      user: 0,
      assistant: 0,
      tool: 0,
    },
    compressionStatus: {
      layersTriggered: [],
      totalCommits: 0,
      snippedCount: 0,
      collapsedSpans: 0,
      savedTokens: 0,
    },
    apiViewPreview: [],
    recentCommits: [],
    contextItems: [],
    selections: defaultSelections,
    provenance: [],
    interventions: defaultInterventions,
    rawInterventions: defaultInterventions,
    effectiveInterventions: defaultInterventions,
    interventionItems: [],
    provenanceEntries: [],
  };
}

/**
 * Compute the context view from a raw transcript + compression state.
 *
 * @param transcript  - Original (immutable) transcript messages
 * @param compressionState - Current compression state for the session
 * @param maxTokens   - Maximum context window size for the active model
 */
export function getContextView(
  transcript: ProjectableMessage[],
  compressionState: CompressionState,
  maxTokens: number,
): ContextViewResponse {
  // Generate the API view (apply collapses, snips, etc.)
  const apiView = engine.projectMessages(transcript, compressionState);

  // Token distribution per role
  const tokenDistribution = { system: 0, user: 0, assistant: 0, tool: 0 };
  for (const msg of apiView) {
    const tokens = estimateTokens(msg.content);
    const role = msg.role as string;
    if (role === 'system') {
      tokenDistribution.system += tokens;
    } else if (role === 'user') {
      tokenDistribution.user += tokens;
    } else if (role === 'assistant') {
      tokenDistribution.assistant += tokens;
    } else {
      // tool / function / other roles
      tokenDistribution.tool += tokens;
    }
  }

  // Total token count (with per-message overhead)
  const totalTokens = estimateConversationTotalTokens(apiView);

  const usagePercent = maxTokens > 0 ? Math.round((totalTokens / maxTokens) * 1000) / 10 : 0;

  // Compression status
  const commitLog = compressionState.getCommitLog();
  const snapshot = compressionState.getSnapshot();

  const layersSet = new Set<string>();
  for (const commit of commitLog) {
    if (commit.operation !== 'reset') {
      layersSet.add(commit.layer);
    }
  }

  // Saved tokens: sum of (originalTokens - truncatedTokens) from budgetedResults
  let savedTokens = 0;
  for (const [, entry] of snapshot.budgetedResults) {
    const diff = (entry.originalTokens ?? 0) - (entry.truncatedTokens ?? 0);
    if (diff > 0) savedTokens += diff;
  }

  const compressionStatus = {
    layersTriggered: Array.from(layersSet),
    totalCommits: commitLog.length,
    snippedCount: snapshot.snippedIds.size,
    collapsedSpans: snapshot.collapsedSpans.length,
    savedTokens,
  };
  const recentCommits = commitLog
    .slice(-6)
    .reverse()
    .map((commit) => ({
      layer: commit.layer,
      operation: commit.operation,
      timestamp: commit.timestamp,
      targetCount: commit.targetMessageIds.length,
    }));

  // API view preview (first 100 chars per message)
  const apiViewPreview = apiView.map((msg) => ({
    id: msg.id,
    role: msg.role,
    contentPreview:
      msg.content.length > 100 ? msg.content.slice(0, 100) + '...' : msg.content,
    tokens: estimateTokens(msg.content),
  }));

  return {
    totalTokens,
    maxTokens,
    usagePercent,
    messageCount: apiView.length,
    tokenDistribution,
    compressionStatus,
    apiViewPreview,
    recentCommits,
    contextItems: [],
    selections: { sessionId: '', entries: [] },
    provenance: [],
    interventions: {
      pinned: [],
      excluded: [],
      retained: [],
    },
    rawInterventions: {
      pinned: [],
      excluded: [],
      retained: [],
    },
    effectiveInterventions: {
      pinned: [],
      excluded: [],
      retained: [],
    },
    interventionItems: [],
    provenanceEntries: [],
  };
}

function buildSelectionEntries(snapshot: ContextInterventionSnapshot): ContextSelectionEntry[] {
  return [
    ...snapshot.pinned.map((itemId) => ({ itemId, selection: 'pinned' as const, updatedAt: Date.now() })),
    ...snapshot.excluded.map((itemId) => ({ itemId, selection: 'excluded' as const, updatedAt: Date.now() })),
    ...snapshot.retained.map((itemId) => ({ itemId, selection: 'retained' as const, updatedAt: Date.now() })),
  ];
}

function getSelectionMode(messageId: string, interventions: ContextInterventionSnapshot): ContextSelectionMode {
  if (interventions.pinned.includes(messageId)) return 'pinned';
  if (interventions.excluded.includes(messageId)) return 'excluded';
  if (interventions.retained.includes(messageId)) return 'retained';
  return 'default';
}

function getInterventionStatus(messageId: string, interventions: ContextInterventionSnapshot): ContextInterventionStatus {
  const selection = getSelectionMode(messageId, interventions);
  return selection === 'default' ? 'neutral' : selection;
}

function buildPreview(message: ProjectableMessage): SharedContextViewResponse['apiViewPreview'][number] {
  return {
    id: message.id,
    role: message.role,
    contentPreview: message.content.length > 100 ? `${message.content.slice(0, 100)}...` : message.content,
    tokens: estimateTokens(message.content),
  };
}

function getSourceType(message: Message): ContextItemProvenance['sourceType'] {
  if ((message.attachments?.length ?? 0) > 0) return 'attachment';
  if (message.role === 'system') return 'system';
  if (message.role === 'user') return 'user';
  if (message.role === 'assistant') return 'assistant';
  return 'tool';
}

function getInterventionSourceType(message: Message): ContextProvenanceListEntry['sourceType'] {
  if ((message.attachments?.length ?? 0) > 0) return 'attachment';
  if ((message.toolCalls?.length ?? 0) > 0 || message.role === 'tool') return 'tool';
  return 'message';
}

function resolveAnnotationCategory(
  annotation: SubagentContextAnnotation | undefined,
): ContextProvenanceCategory | undefined {
  if (annotation?.category) return annotation.category;
  if (annotation?.sourceKind && annotation.sourceKind !== 'message') {
    return annotation.sourceKind as ContextProvenanceCategory;
  }
  return undefined;
}

function hasRuntimeProvenance(annotation: SubagentContextAnnotation | undefined): boolean {
  return Boolean(
    annotation?.category
    || annotation?.sourceKind
    || annotation?.sourceDetail
    || annotation?.layer,
  );
}

function mergeAnnotation(
  base: SubagentContextAnnotation | undefined,
  event: ContextEventRecord | undefined,
): SubagentContextAnnotation | undefined {
  if (!base && !event) return undefined;
  return {
    category: event?.category ?? base?.category,
    sourceDetail: event?.sourceDetail ?? base?.sourceDetail,
    agentId: event?.agentId ?? base?.agentId,
    sourceKind: event?.sourceKind ?? base?.sourceKind,
    layer: event?.layer ?? base?.layer,
    toolCallId: base?.toolCallId,
  };
}

function getPrimaryRuntimeEvent(events: ReadonlyArray<ContextEventRecord> | undefined): ContextEventRecord | undefined {
  return events?.[0];
}

function getRuntimeEventCategories(
  events: ReadonlyArray<ContextEventRecord> | undefined,
  annotation: SubagentContextAnnotation | undefined,
): ContextProvenanceCategory[] {
  const categories = new Set<ContextProvenanceCategory>();
  if (annotation?.category) categories.add(annotation.category);
  for (const event of events ?? []) {
    if (event.category) categories.add(event.category);
  }
  return Array.from(categories);
}

function resolveSourceDetail(
  message: Message,
  annotation?: SubagentContextAnnotation,
  events?: ReadonlyArray<ContextEventRecord>,
): string | undefined {
  const primaryEvent = getPrimaryRuntimeEvent(events);
  return primaryEvent?.sourceDetail
    ?? annotation?.sourceDetail
    ?? (annotation?.layer ? `${annotation.sourceKind ?? 'runtime'}:${annotation.layer}` : undefined)
    ?? (message.attachments ?? []).map((attachment) => attachment.name).find(Boolean)
    ?? (message.toolCalls ?? []).map((toolCall) => toolCall.name).find(Boolean)
    ?? message.role;
}

function buildReasonList(
  message: Message,
  selection: ContextSelectionMode,
  commitEntry?: ContextProvenanceEntry,
  annotation?: SubagentContextAnnotation,
  events?: ReadonlyArray<ContextEventRecord>,
): string[] {
  const eventReasons = Array.from(new Set(
    (events ?? [])
      .map((event) => event.reason || event.sourceDetail)
      .filter((reason): reason is string => Boolean(reason)),
  ));
  const categories = buildProvenanceCategories(message, selection, commitEntry, annotation, events);
  const reasonText: Record<ContextProvenanceCategory, string> = {
    recent_turn: 'recent conversation turn',
    tool_result: 'contains tool result',
    attachment: 'contains attachment',
    dependency_carry_over: 'dependency carry-over from parent context',
    manual_pin_retain: selection === 'pinned' ? 'manually pinned' : 'retained across compression',
    compression_survivor: annotation?.layer
      ? `runtime compression survivor (${annotation.layer})`
      : commitEntry?.layer
        ? `compression layer ${commitEntry.layer}`
        : 'survived compression',
    excluded: 'manually excluded',
    system_anchor: 'system anchor',
    unknown: 'unknown provenance',
  };

  if (eventReasons.length > 0) {
    return [...eventReasons, ...categories.map((category) => reasonText[category])].filter((reason, index, all) => all.indexOf(reason) === index);
  }
  return categories.map((category) => reasonText[category]);
}

function buildProvenanceCategories(
  message: Message,
  selection: ContextSelectionMode,
  commitEntry?: ContextProvenanceEntry,
  annotation?: SubagentContextAnnotation,
  events?: ReadonlyArray<ContextEventRecord>,
): ContextProvenanceCategory[] {
  const categories = new Set<ContextProvenanceCategory>();
  const annotatedCategory = resolveAnnotationCategory(annotation);
  const runtimeCategories = getRuntimeEventCategories(events, annotation);
  const runtimeDriven = runtimeCategories.length > 0 || hasRuntimeProvenance(annotation);

  if (annotatedCategory) categories.add(annotatedCategory);
  for (const category of runtimeCategories) categories.add(category);
  if (selection === 'pinned' || selection === 'retained') categories.add('manual_pin_retain');
  if (selection === 'excluded') categories.add('excluded');

  if (!runtimeDriven) {
    if (message.role === 'system') categories.add('system_anchor');
    if ((message.toolCalls?.length ?? 0) > 0 || (message.toolResults?.length ?? 0) > 0 || message.role === 'tool') {
      categories.add('tool_result');
    }
    if ((message.attachments?.length ?? 0) > 0) categories.add('attachment');
    if (commitEntry?.layer || (message.content || '').includes('[truncated]')) categories.add('compression_survivor');
    if (message.role === 'system' && /#\s*当前会话上下文|dependency|carry-over/i.test(message.content || '')) {
      categories.add('dependency_carry_over');
    }
  }
  if (categories.size === 0) categories.add('recent_turn');

  return Array.from(categories);
}

function buildContextItem(
  message: Message,
  preview: SharedContextViewResponse['apiViewPreview'][number],
  included: boolean,
  selection: ContextSelectionMode,
  commitEntry?: ContextProvenanceEntry,
  annotation?: SubagentContextAnnotation,
  events?: ReadonlyArray<ContextEventRecord>,
): ContextItemView {
  const categories = buildProvenanceCategories(message, selection, commitEntry, annotation, events);
  return {
    id: message.id,
    role: message.role,
    contentPreview: preview.contentPreview,
    tokens: preview.tokens,
    included,
    selection,
    provenance: {
      sourceType: getSourceType(message),
      reasons: buildReasonList(message, selection, commitEntry, annotation, events),
      categories,
      sourceDetail: resolveSourceDetail(message, annotation, events),
      attachmentNames: (message.attachments ?? []).map((attachment) => attachment.name),
      toolNames: [
        ...(message.toolCalls ?? []).map((toolCall) => toolCall.name),
        ...((message.toolResults?.length ?? 0) > 0 ? ['tool_result'] : []),
      ],
    },
  };
}

function buildInterventionItem(
  message: Message,
  contextItem: ContextItemView,
  annotation?: SubagentContextAnnotation,
  events?: ReadonlyArray<ContextEventRecord>,
): NonNullable<ContextViewResponse['interventionItems']>[number] {
  const toolNames = contextItem.provenance.toolNames;
  const attachmentNames = contextItem.provenance.attachmentNames;
  const sourceDetail = resolveSourceDetail(message, annotation, events)
    ?? attachmentNames[0]
    ?? toolNames[0]
    ?? message.role;

  return {
    id: contextItem.id,
    label: contextItem.contentPreview || '空消息',
    sourceType: getInterventionSourceType(message),
    sourceDetail,
    reason: contextItem.provenance.reasons.join(' · '),
    tokens: contextItem.tokens,
    status: getInterventionStatus(message.id, {
      pinned: contextItem.selection === 'pinned' ? [message.id] : [],
      excluded: contextItem.selection === 'excluded' ? [message.id] : [],
      retained: contextItem.selection === 'retained' ? [message.id] : [],
    }),
    timestamp: message.timestamp ?? Date.now(),
  };
}

function buildProvenanceListEntry(
  message: Message,
  contextItem: ContextItemView,
  commitEntry?: ContextProvenanceEntry,
  agentId?: string,
  annotation?: SubagentContextAnnotation,
  events?: ReadonlyArray<ContextEventRecord>,
): ContextProvenanceListEntry {
  const primaryEvent = getPrimaryRuntimeEvent(events);
  let action: ContextProvenanceAction = 'added';
  if (contextItem.selection === 'pinned') action = 'pinned';
  else if (contextItem.selection === 'excluded') action = 'excluded';
  else if (contextItem.selection === 'retained') action = 'retained';
  else if (commitEntry) action = 'compressed';
  else if ((message.toolCalls?.length ?? 0) > 0 || (message.attachments?.length ?? 0) > 0 || message.role === 'tool') action = 'retrieved';
  else if (primaryEvent?.action) action = primaryEvent.action;

  return {
    id: `${message.id}:${action}`,
    label: contextItem.contentPreview || '空消息',
    source: primaryEvent?.sourceDetail
      ?? annotation?.sourceDetail
      ?? (annotation?.layer ? `${annotation.sourceKind ?? 'runtime'}:${annotation.layer}` : undefined)
      ?? commitEntry?.layer
      ?? message.role,
    sourceType: getInterventionSourceType(message),
    reason: contextItem.provenance.reasons.join(' · '),
    tokens: contextItem.tokens,
    action,
    category: contextItem.provenance.categories?.[0] ?? 'recent_turn',
    agentId,
    timestamp: message.timestamp ?? commitEntry?.timestamp ?? Date.now(),
  };
}

function resolveProvenanceSource(layer: string): ContextProvenanceSource {
  if (layer?.includes('system')) {
    return 'system';
  }
  if (/tool/.test(layer)) {
    return 'tool';
  }
  return 'assistant';
}

function mapOperationToModifications(operation: CompressionCommit['operation']): ContextModificationType[] {
  switch (operation) {
    case 'collapse':
      return ['collapsed'];
    case 'compact':
      return ['microcompact'];
    case 'snip':
      return ['snipped'];
    case 'truncate':
      return ['truncated'];
    default:
      return [];
  }
}

function buildProvenanceEntries(
  commitLog: ReadonlyArray<CompressionCommit>,
  agentId?: string,
): ContextProvenanceEntry[] {
  const entries: ContextProvenanceEntry[] = [];
  for (const commit of commitLog) {
    const modifications = mapOperationToModifications(commit.operation);
    const source = resolveProvenanceSource(commit.layer);
    for (const messageId of commit.targetMessageIds) {
      entries.push({
        messageId,
        source,
        reason: `${commit.operation} via ${commit.layer}`,
        modifications,
        category: 'compression_survivor',
        agentId,
        layer: commit.layer,
        timestamp: commit.timestamp,
      });
    }
  }
  return entries;
}

function buildProvenanceEntriesFromEvents(
  events: ReadonlyArray<ContextEventRecord>,
): ContextProvenanceEntry[] {
  return events
    .filter((event) => event.messageId)
    .map((event) => ({
      messageId: event.messageId!,
      source: event.sourceKind === 'tool_result' || event.category === 'tool_result'
        ? 'tool'
        : event.sourceKind === 'system_anchor' || event.category === 'system_anchor'
          ? 'system'
          : event.sourceKind === 'attachment' || event.category === 'attachment'
            ? 'user'
            : event.sourceDetail?.startsWith('user_')
              ? 'user'
              : event.sourceDetail?.startsWith('assistant_')
                ? 'assistant'
                : event.sourceDetail?.startsWith('system_')
                  ? 'system'
                  : event.sourceKind === 'dependency_carry_over' || event.category === 'dependency_carry_over'
                    ? 'assistant'
                    : 'assistant',
      reason: event.reason || event.sourceDetail || event.category || 'runtime event',
      modifications: event.action === 'compressed'
        ? mapOperationToModifications((event.sourceDetail?.split(':')[1] as CompressionCommit['operation']) || 'truncate')
        : event.action === 'excluded'
          ? ['excluded']
          : event.action === 'retained'
            ? ['retained']
            : event.action === 'pinned'
              ? ['pinned']
              : [],
      category: event.category,
      agentId: event.agentId,
      layer: event.layer,
      timestamp: event.timestamp,
    }));
}

function getMessageProvenanceSource(message: Message): ContextProvenanceSource {
  if (message.role === 'system') return 'system';
  if (message.role === 'user') return 'user';
  if (message.role === 'assistant') return 'assistant';
  return 'tool';
}

function buildContextProvenanceEntry(
  message: Message,
  contextItem: ContextItemView,
  commitEntry?: ContextProvenanceEntry,
  agentId?: string,
  annotation?: SubagentContextAnnotation,
  events?: ReadonlyArray<ContextEventRecord>,
): ContextProvenanceEntry {
  const primaryEvent = getPrimaryRuntimeEvent(events);
  const modifications = new Set<ContextModificationType>(commitEntry?.modifications ?? []);
  const primaryEventSource: ContextProvenanceSource | undefined = primaryEvent?.sourceKind === 'tool_result'
    || primaryEvent?.category === 'tool_result'
    ? 'tool'
    : primaryEvent?.sourceKind === 'system_anchor'
      || primaryEvent?.category === 'system_anchor'
      ? 'system'
      : primaryEvent?.sourceKind === 'attachment'
        || primaryEvent?.category === 'attachment'
        ? 'user'
        : primaryEvent?.sourceKind === 'dependency_carry_over'
          || primaryEvent?.category === 'dependency_carry_over'
          ? 'assistant'
          : undefined;
  if (contextItem.selection === 'pinned') modifications.add('pinned');
  if (contextItem.selection === 'excluded') modifications.add('excluded');
  if (contextItem.selection === 'retained') modifications.add('retained');
  for (const event of events ?? []) {
    if (event.action === 'compressed' && event.sourceDetail) {
      const operation = event.sourceDetail.split(':')[1] as CompressionCommit['operation'] | undefined;
      for (const modification of mapOperationToModifications(operation || 'truncate')) {
        modifications.add(modification);
      }
    }
  }

  return {
    messageId: message.id,
    source: commitEntry?.source ?? primaryEventSource ?? getMessageProvenanceSource(message),
    reason: [
      contextItem.provenance.reasons.join(' · '),
      resolveSourceDetail(message, annotation, events) ? `detail: ${resolveSourceDetail(message, annotation, events)}` : '',
      primaryEvent?.layer ? `layer: ${primaryEvent.layer}` : annotation?.layer ? `layer: ${annotation.layer}` : '',
    ].filter(Boolean).join(' · '),
    modifications: Array.from(modifications),
    category: contextItem.provenance.categories?.[0] ?? 'recent_turn',
    agentId,
    layer: commitEntry?.layer,
    timestamp: message.timestamp ?? commitEntry?.timestamp ?? Date.now(),
  };
}

function getSourceMessages(
  sessionId: string,
  requestedAgentId: string | undefined,
  sessionMessages: Message[],
): {
  messages: Message[];
  scope: 'session' | 'agent';
  maxTokens?: number;
  compressionState?: CompressionState;
  annotations?: Record<string, SubagentContextAnnotation>;
} {
  if (!requestedAgentId) {
    return { messages: sessionMessages, scope: 'session' };
  }

  const record = getSubagentContextStore().get(sessionId, requestedAgentId);
  if (!record) {
    return { messages: sessionMessages, scope: 'session' };
  }

  return {
    messages: record.messages,
    scope: 'agent',
    maxTokens: record.maxTokens,
    compressionState: record.compressionState,
    annotations: record.annotations,
  };
}

function applyInterventionsToView(
  transcript: ProjectableMessage[],
  interventions: ContextInterventionSnapshot,
): ProjectableMessage[] {
  return applyInterventionsToMessages(transcript, interventions);
}


export async function buildContextViewFromSession(
  request: ContextViewRequest | undefined,
  dependencies: ContextViewDependencies,
): Promise<ContextViewResponse> {
  const appService = dependencies.getAppService();
  const requestedSessionId = request?.sessionId;
  const requestedAgentId = request?.agentId;
  const resolvedSessionId = requestedSessionId?.trim() || appService?.getCurrentSessionId() || null;

  if (!resolvedSessionId) {
    const defaultHealth = createEmptyHealthState();
    return buildEmptyResponse(defaultHealth.maxTokens);
  }

  const healthService = getContextHealthService();
  const contextHealth = healthService.get(resolvedSessionId) || createEmptyHealthState();

  let sessionMessages: Message[] = [];
  try {
    sessionMessages = (await appService?.getMessages(resolvedSessionId)) || [];
  } catch (error) {
    logger.warn('Failed to load session messages for context view', {
      sessionId: resolvedSessionId,
      error,
    });
    sessionMessages = [];
  }

  if (sessionMessages.length === 0 && appService?.getCurrentSessionId?.() !== resolvedSessionId) {
    getSubagentContextStore().clearSession(resolvedSessionId);
    getContextEventLedger().clearSession(resolvedSessionId);
  }

  const source = getSourceMessages(resolvedSessionId, requestedAgentId, sessionMessages);
  const messages = source.messages;

  const transcript = normalizeMessages(messages);
  const maxTokens = source.maxTokens
    || contextHealth.maxTokens
    || createEmptyHealthState().maxTokens;
  let compressionState = new CompressionState();

  if (source.compressionState) {
    compressionState = source.compressionState;
  } else if (source.scope === 'session') {
    try {
      const serializedState = appService?.getSerializedCompressionState(resolvedSessionId);
      if (serializedState) {
        compressionState = CompressionState.deserialize(serializedState);
      }
    } catch (error) {
      logger.warn('Failed to load serialized compression state for context view', {
        sessionId: resolvedSessionId,
        error,
      });
    }
  }

  const effectiveAgentId = requestedAgentId?.trim() || undefined;
  const runtimeEvents = getContextEventLedger().list(resolvedSessionId, effectiveAgentId);
  const rawInterventions = interventionState.getSnapshot(resolvedSessionId, effectiveAgentId);
  const compressionProvenance = buildProvenanceEntries(compressionState.getCommitLog(), effectiveAgentId);
  const eventProvenance = buildProvenanceEntriesFromEvents(runtimeEvents);
  const interventions = interventionState.getEffectiveSnapshot(resolvedSessionId, effectiveAgentId);
  const messageMap = new Map(messages.map((message) => [message.id, message]));
  const eventMap = new Map<string, ContextEventRecord[]>();
  for (const event of runtimeEvents) {
    if (!event.messageId) continue;
    const existing = eventMap.get(event.messageId) || [];
    existing.push(event);
    eventMap.set(event.messageId, existing);
  }
  const provenanceMap = new Map<string, ContextProvenanceEntry>();
  eventProvenance.forEach((entry) => {
    provenanceMap.set(entry.messageId, entry);
  });
  compressionProvenance.forEach((entry) => {
    if (!provenanceMap.has(entry.messageId)) {
      provenanceMap.set(entry.messageId, entry);
    }
  });
  const manualTranscript = applyInterventionsToView(transcript, interventions);
  const adjustedView = getContextView(manualTranscript, compressionState, maxTokens);
  const selectionEntries = buildSelectionEntries(interventions);
  const previewIds = new Set(adjustedView.apiViewPreview.map((item) => item.id));
  const interventionIds = [
    ...interventions.pinned,
    ...interventions.excluded,
    ...interventions.retained,
  ];
  interventionIds.forEach((itemId) => previewIds.add(itemId));
  const contextItems: ContextItemView[] = Array.from(previewIds)
    .map((itemId) => {
      const message = messageMap.get(itemId);
      if (!message) return null;
      const preview = adjustedView.apiViewPreview.find((item) => item.id === itemId) ?? buildPreview({
        id: message.id,
        role: message.role,
        content: message.content || '',
      });
      const selection = getSelectionMode(itemId, interventions);
      return buildContextItem(
        message,
        preview,
        selection !== 'excluded',
        selection,
        provenanceMap.get(itemId),
        mergeAnnotation(source.annotations?.[itemId], getPrimaryRuntimeEvent(eventMap.get(itemId))),
        eventMap.get(itemId),
      );
    })
    .filter((value): value is ContextItemView => Boolean(value))
    .slice(0, 12);
  const selections: ContextSelectionState = {
    sessionId: resolvedSessionId,
    agentId: effectiveAgentId,
    entries: selectionEntries,
  };
  const interventionItems = contextItems.flatMap((item) => {
    const message = messageMap.get(item.id);
    return message ? [buildInterventionItem(message, item, mergeAnnotation(source.annotations?.[item.id], getPrimaryRuntimeEvent(eventMap.get(item.id))), eventMap.get(item.id))] : [];
  });
  const provenanceEntries = contextItems.flatMap((item) => {
    const message = messageMap.get(item.id);
    return message
      ? [buildProvenanceListEntry(message, item, provenanceMap.get(item.id), effectiveAgentId, mergeAnnotation(source.annotations?.[item.id], getPrimaryRuntimeEvent(eventMap.get(item.id))), eventMap.get(item.id))]
      : [];
  });
  const provenance = contextItems.flatMap((item) => {
    const message = messageMap.get(item.id);
    return message
      ? [buildContextProvenanceEntry(message, item, provenanceMap.get(item.id), effectiveAgentId, mergeAnnotation(source.annotations?.[item.id], getPrimaryRuntimeEvent(eventMap.get(item.id))), eventMap.get(item.id))]
      : [];
  });

  return {
    ...adjustedView,
    sessionId: resolvedSessionId,
    agentId: effectiveAgentId,
    maxTokens,
    usagePercent: source.scope === 'agent'
      ? adjustedView.usagePercent
      : contextHealth.currentTokens > 0
        ? contextHealth.usagePercent
        : adjustedView.usagePercent,
    provenance,
    interventions,
    rawInterventions,
    effectiveInterventions: interventions,
    contextItems,
    selections,
    interventionItems,
    provenanceEntries,
  };
}

// ----------------------------------------------------------------------------
// IPC handler registration
// ----------------------------------------------------------------------------

export function registerContextHandlers(dependencies: ContextViewDependencies): void {
  ipcMain.handle(IPC_CHANNELS.CONTEXT_GET_VIEW, async (_event, request?: ContextViewRequest) => {
    try {
      logger.info(`Context view requested for session: ${request?.sessionId}`);
      return await buildContextViewFromSession(request, dependencies);
    } catch (error) {
      logger.error('Failed to get context view:', error);
      return null;
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_INTERVENTION_GET,
    (_event, request: ContextInterventionRequest) => {
      return interventionState.getEffectiveSnapshot(request?.sessionId, request?.agentId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_INTERVENTION_SET,
    (_event, request: ContextInterventionSetRequest) => {
      if (!request?.messageId || !request?.action) {
        throw new Error('messageId and action are required');
      }
      return interventionState.applyIntervention(
        request.sessionId,
        request.agentId,
        request.messageId,
        request.action,
        request.enabled,
      );
    },
  );

  logger.info('Context handlers registered');
}

export type {
  ContextViewRequest,
  ContextViewResponse,
  ContextProvenanceEntry,
  ContextInterventionSnapshot,
  ContextInterventionRequest,
  ContextInterventionSetRequest,
};
