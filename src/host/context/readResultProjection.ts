import type { Message } from '../../shared/contract';
import type { ToolCall, ToolResult } from '../../shared/contract/tool';
import { TOOL_RESULT_SPILL } from '../../shared/constants';

// ponytail: this currently dedupes only an exactly matching requested range (`path#start-end`).
// A coverage-aware upgrade should compare each request with prior `shownRange` intervals;
// narrower or partially overlapping reads stay visible for now (a conservative miss, not a false dedupe).
/** The small, model-facing receipt used when a complete Read result is already in context. */
const READ_RECEIPT_PREFIX = '[Read already shown';
const READ_TOOL_NAMES = new Set(['read', 'read_file']);
const TRUNCATION_MARKER = /\[(?:\d+\s+lines?\s+)?truncated(?:[,\]])|\b\d+\s+lines?\s+truncated\b/i;
const ARCHIVED_OUTPUT_MARKERS = ['[TOOL_RESULT_ARCHIVED]', TOOL_RESULT_SPILL.NOTICE_MARKER];
const READ_DIGEST_RE = /^Read version digest:\s*([a-f0-9]+)\b/im;

type ReadCall = Pick<ToolCall, 'id' | 'name' | 'arguments'>;

export interface ReadProjectionEntry {
  role: string;
  content: string;
  toolCallId?: string;
  toolCalls?: ReadCall[];
  toolError?: boolean;
  toolResultMetadata?: Record<string, unknown>;
}

interface ReadProjectionState {
  shown: Map<string, string>;
}

interface ReadScope {
  key: string;
  label: string;
  digest?: string;
}

interface FlattenedReadEnvelope {
  prefix: string;
  toolError: boolean;
  digest?: string;
}

function createReadProjectionState(): ReadProjectionState {
  return { shown: new Map() };
}

function isReadCall(call: ReadCall | undefined): boolean {
  return Boolean(call && READ_TOOL_NAMES.has(call.name.toLowerCase()));
}

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readScope(call: ReadCall, metadata?: Record<string, unknown>, output?: string): ReadScope | undefined {
  if (!isReadCall(call)) return undefined;
  const args = call.arguments || {};
  const rawPath = args.file_path ?? args.path;
  if (typeof rawPath !== 'string' || !rawPath.trim()) return undefined;

  const shownRange = metadata?.shownRange;
  const start = typeof (shownRange as { startLine?: unknown } | undefined)?.startLine === 'number'
    ? (shownRange as { startLine: number }).startLine
    : asFiniteNumber(args.offset, 1);
  const end = typeof (shownRange as { endLine?: unknown } | undefined)?.endLine === 'number'
    ? (shownRange as { endLine: number }).endLine
    : start + Math.max(0, asFiniteNumber(args.limit, 2000)) - 1;
  const total = typeof (shownRange as { totalLines?: unknown } | undefined)?.totalLines === 'number'
    ? (shownRange as { totalLines: number }).totalLines
    : undefined;
  const digest = typeof metadata?.digest === 'string'
    ? metadata.digest
    : READ_DIGEST_RE.exec(output || '')?.[1];
  const range = `${start}-${end}${total === undefined ? '' : `/${total}`}`;
  return {
    key: `${rawPath.trim()}#${range}`,
    label: `${rawPath.trim()}#L${start}-L${end}`,
    ...(digest ? { digest } : {}),
  };
}

/**
 * Native subagent tool results are flattened into a user message
 * (`Tool results:\nTool <name>: Success|Failed\n...` or `Error: ...`).
 * Inspect the status line only so file contents cannot spoof success/failure.
 */
function inspectFlattenedRead(content: string): FlattenedReadEnvelope {
  const digest = READ_DIGEST_RE.exec(content)?.[1];
  const match = content.match(/^(Tool results:\n)?(Tool [^\n]+|Error:[^\n]*)(\n|$)/);
  const statusLine = match?.[2] ?? '';
  const toolError = statusLine.startsWith('Error:')
    || /^Tool \S+:\s*(?:Failed\b|Error\b|Blocked by plan approval:)/.test(statusLine);
  return {
    prefix: match?.[0] ?? '',
    toolError,
    ...(digest ? { digest } : {}),
  };
}

function isCompleteReadOutput(content: string): boolean {
  if (!content.trim() || content.includes('[truncated]')) return false;
  if (TRUNCATION_MARKER.test(content)) return false;
  if (content.includes(READ_RECEIPT_PREFIX)) return false;
  if (ARCHIVED_OUTPUT_MARKERS.some((marker) => content.includes(marker))) return false;
  return true;
}

function contentFingerprint(content: string): string {
  // A digest is normally present in native Read output. This fallback keeps
  // provider-generated/legacy Read results safe without importing crypto into
  // every context assembly path. Preserve internal whitespace so an indent-only
  // edit is not collapsed into the earlier result.
  return content.trim();
}

function projectReadContent(
  state: ReadProjectionState,
  call: ReadCall | undefined,
  content: string,
  metadata?: Record<string, unknown>,
  toolError = false,
): string {
  const scope = call ? readScope(call, metadata, content) : undefined;
  if (!scope || toolError || inspectFlattenedRead(content).toolError || !isCompleteReadOutput(content)) {
    return content;
  }

  const fingerprint = scope.digest ?? contentFingerprint(content);
  const previous = state.shown.get(scope.key);
  if (previous === fingerprint) {
    return `${READ_RECEIPT_PREFIX}: ${scope.label}; digest=${scope.digest ?? 'unchanged'}. The full content is in the earlier Read result.]`;
  }

  // A changed digest is a new source of truth. Keep it visible and make later
  // reads of this new version eligible for projection.
  state.shown.set(scope.key, fingerprint);
  return content;
}

/**
 * Project structured host messages for a model request without mutating the
 * persisted messages or the tool return values consumed by programmatic callers.
 */
export function projectReadResultsForModel(messages: Message[]): Message[] {
  const state = createReadProjectionState();
  const callsById = new Map<string, ToolCall>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) callsById.set(call.id, call);
    }
  }

  return messages.map((message) => {
    if (message.role !== 'tool' || !message.toolResults?.length) return message;
    const toolResults = message.toolResults.map((result: ToolResult) => {
      const call = callsById.get(result.toolCallId);
      if (!call || !result.output) return result;
      const content = projectReadContent(state, call, result.output, result.metadata, !result.success);
      return content === result.output ? result : { ...result, output: content };
    });
    if (toolResults.every((result, index) => result === message.toolResults?.[index])) return message;
    return { ...message, toolResults };
  });
}

/** Project transcript entries (the main context assembly shape). */
export function projectReadTranscriptEntries<T extends ReadProjectionEntry>(entries: T[]): T[] {
  const state = createReadProjectionState();
  const callsByToolCallId = new Map<string, ReadCall>();
  for (const entry of entries) {
    if (entry.role !== 'assistant' || !entry.toolCalls) continue;
    for (const call of entry.toolCalls) {
      callsByToolCallId.set(call.id, call);
    }
  }
  return entries.map((entry) => {
    if (entry.role !== 'tool' || !entry.toolCallId) return entry;
    const call = callsByToolCallId.get(entry.toolCallId);
    if (!call) return entry;
    const content = projectReadContent(state, call, entry.content, entry.toolResultMetadata, entry.toolError === true);
    return content === entry.content ? entry : { ...entry, content };
  });
}

/** Project the flattened assistant/user pairs used by native subagents. */
export function projectReadSubagentMessages<T extends { role: string; content: unknown; toolCalls?: ReadCall[] }>(messages: T[]): T[] {
  const state = createReadProjectionState();
  const projected = messages.map((message) => ({ ...message }));
  for (let index = 0; index < projected.length - 1; index += 1) {
    const assistant = projected[index];
    const next = projected[index + 1];
    if (assistant.role !== 'assistant' || !Array.isArray(assistant.toolCalls) || assistant.toolCalls.length !== 1) continue;
    if (next.role !== 'user' || typeof next.content !== 'string') continue;
    const call = assistant.toolCalls[0];
    if (!isReadCall(call)) continue;
    const envelope = inspectFlattenedRead(next.content);
    const metadata = envelope.digest ? { digest: envelope.digest } : undefined;
    const content = projectReadContent(state, call, next.content, metadata, envelope.toolError);
    if (content === next.content) continue;
    const wrapped = envelope.prefix && !content.startsWith(envelope.prefix)
      ? `${envelope.prefix}${content}`
      : content;
    projected[index + 1] = { ...next, content: wrapped } as T;
  }
  return projected;
}
