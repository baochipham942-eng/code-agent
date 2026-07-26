// ============================================================================
// Prompt Stack Summary
// ============================================================================
// Produces a metadata-only view from the persisted Context Ledger. Prompt text
// is deliberately not accepted here: provenance must come from assembly-time
// records, never from marker parsing.
// ============================================================================

import { CONTEXT_LEDGER } from '../../../shared/constants';
import { PROMPT_VERSION } from '../../../shared/constants/agent';
import type {
  PromptStackLayerSummary,
  PromptStackSummary,
  PromptStackSummaryRequest,
} from '../../../shared/contract/promptStack';
import {
  getContextEventLedger,
  type ContextEventRecord,
} from '../../context/contextEventLedger';

function selectInvocationId(
  events: ReadonlyArray<ContextEventRecord>,
  requestedInvocationId?: string,
): string | undefined {
  if (requestedInvocationId) return requestedInvocationId;
  const latest = events
    .filter((event) => event.invocationId && (
      event.sourceKind === CONTEXT_LEDGER.SOURCE_KIND.PROMPT_LAYER
      || event.sourceKind === CONTEXT_LEDGER.SOURCE_KIND.TOOL_SCHEMA_SNAPSHOT
      || event.sourceKind === CONTEXT_LEDGER.SOURCE_KIND.MODEL_BINDING
    ))
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  return latest?.invocationId;
}

function summarizeLayers(events: ReadonlyArray<ContextEventRecord>): PromptStackLayerSummary[] {
  return events
    .filter((event) => (
      event.sourceKind === CONTEXT_LEDGER.SOURCE_KIND.PROMPT_LAYER
      && event.promptLayerOutcome
      && event.layer
    ))
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
    .map((event) => ({
      id: event.layer!,
      label: event.sourceDetail || event.layer!,
      present: event.promptLayerOutcome === CONTEXT_LEDGER.PROMPT_LAYER_OUTCOME.INCLUDED,
      chars: event.chars ?? 0,
      tokens: event.tokens ?? 0,
      outcome: event.promptLayerOutcome!,
      note: event.reason,
    }));
}

export function summarizePromptStack(
  events: ReadonlyArray<ContextEventRecord>,
  request: Partial<PromptStackSummaryRequest> = {},
): PromptStackSummary {
  const scopedEvents = events.filter((event) => {
    if (request.sessionId && event.sessionId !== request.sessionId) return false;
    if (!request.agentId) return !event.agentId;
    return event.agentId === request.agentId || !event.agentId;
  });
  const invocationId = selectInvocationId(scopedEvents, request.invocationId);
  const invocationEvents = invocationId
    ? scopedEvents.filter((event) => event.invocationId === invocationId)
    : [];
  const layers = summarizeLayers(invocationEvents);
  const recordedAt = invocationEvents.reduce(
    (latest, event) => Math.max(latest, event.timestamp),
    0,
  ) || undefined;
  const toolEvent = invocationEvents.find(
    (event) => event.sourceKind === CONTEXT_LEDGER.SOURCE_KIND.TOOL_SCHEMA_SNAPSHOT,
  );
  const modelEvent = invocationEvents.find(
    (event) => event.sourceKind === CONTEXT_LEDGER.SOURCE_KIND.MODEL_BINDING,
  );
  const checkpointEvent = recordedAt
    ? scopedEvents
      .filter((event) => (
        event.sourceKind === 'compression_survivor'
        && event.timestamp <= recordedAt
      ))
      .sort((a, b) => b.timestamp - a.timestamp)[0]
    : undefined;
  const warnings: string[] = [];
  if (!invocationId) warnings.push('No model invocation record found for this session.');
  if (invocationId && layers.length === 0) warnings.push('No prompt layer records found for this invocation.');
  if (invocationId && !toolEvent) warnings.push('No active tool snapshot found for this invocation.');
  if (invocationId && !modelEvent) warnings.push('No model binding found for this invocation.');

  return {
    sessionId: request.sessionId,
    agentId: request.agentId,
    invocationId,
    recordedAt,
    promptVersion: PROMPT_VERSION,
    totalChars: layers
      .filter((layer) => layer.present)
      .reduce((total, layer) => total + layer.chars, 0),
    totalTokens: layers
      .filter((layer) => layer.present)
      .reduce((total, layer) => total + layer.tokens, 0),
    layers,
    ...(toolEvent?.schemaHash ? {
      activeTools: {
        names: toolEvent.toolNames ?? [],
        count: toolEvent.toolNames?.length ?? 0,
        schemaHash: toolEvent.schemaHash,
      },
    } : {}),
    ...(modelEvent?.model && modelEvent.provider ? {
      modelBinding: { model: modelEvent.model, provider: modelEvent.provider },
    } : {}),
    ...(checkpointEvent ? {
      compactionCheckpoint: {
        messageId: checkpointEvent.messageId,
        timestamp: checkpointEvent.timestamp,
        layer: checkpointEvent.layer,
        operation: checkpointEvent.sourceDetail?.split(':')[1],
      },
    } : {}),
    warnings,
  };
}

export function getCurrentPromptStackSummary(
  request?: PromptStackSummaryRequest,
): PromptStackSummary {
  if (!request?.sessionId) return summarizePromptStack([], request);
  const events = getContextEventLedger().list(request.sessionId, request.agentId);
  return summarizePromptStack(events, request);
}
