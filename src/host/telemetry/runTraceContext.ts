import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import {
  ROOT_CONTEXT,
  createContextKey,
  createTraceState,
  trace,
  type Context,
  type TraceState,
} from '@opentelemetry/api';

const RUN_TRACE_CONTEXT_KEY = createContextKey('code-agent.run-trace-context');
const contextStorage = new AsyncLocalStorage<Context>();
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;

export interface RunTraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
  readonly traceState?: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly attempt: number;
  readonly ownerEpoch: number;
  readonly engine: string;
  readonly workspaceFingerprint: string;
  readonly agentId?: string;
  readonly parentRunId?: string;
  readonly processInstanceId: string;
}

export interface CreateRunTraceContextInput {
  runId: string;
  sessionId: string;
  attempt: number;
  ownerEpoch: number;
  engine: string;
  workspace?: string;
  workspaceFingerprint?: string;
  agentId?: string;
  parentRunId?: string;
  processInstanceId: string;
  traceId?: string;
  spanId?: string;
  traceFlags?: number;
  traceState?: string;
}

export interface SerializedRunTraceContext extends RunTraceContext {
  readonly traceparent: string;
  readonly tracestate?: string;
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  return normalized;
}

function requirePositiveInteger(value: number, label: string, allowZero = false): number {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}`);
  }
  return value;
}

function logicalTraceId(runId: string): string {
  return createHash('sha256').update(`code-agent:run-trace:v1:${runId}`).digest('hex').slice(0, 32);
}

function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

export function fingerprintRunWorkspace(workspace: string | undefined): string {
  return createHash('sha256')
    .update(`code-agent:workspace:v1:${workspace?.trim() || 'unknown'}`)
    .digest('hex')
    .slice(0, 24);
}

export function createRunTraceContext(input: CreateRunTraceContextInput): RunTraceContext {
  const runId = requireText(input.runId, 'runId');
  const traceId = (input.traceId ?? logicalTraceId(runId)).toLowerCase();
  const spanId = (input.spanId ?? newSpanId()).toLowerCase();
  if (!TRACE_ID_PATTERN.test(traceId) || /^0+$/.test(traceId)) {
    throw new Error('traceId must be a valid W3C 16-byte lowercase hex identifier');
  }
  if (!SPAN_ID_PATTERN.test(spanId) || /^0+$/.test(spanId)) {
    throw new Error('spanId must be a valid W3C 8-byte lowercase hex identifier');
  }
  const traceFlags = input.traceFlags ?? 1;
  if (traceFlags !== 0 && traceFlags !== 1) {
    throw new Error('traceFlags must be 0 or 1');
  }

  return Object.freeze({
    traceId,
    spanId,
    traceFlags,
    traceState: input.traceState?.trim() || undefined,
    runId,
    sessionId: requireText(input.sessionId, 'sessionId'),
    attempt: requirePositiveInteger(input.attempt, 'attempt'),
    ownerEpoch: requirePositiveInteger(input.ownerEpoch, 'ownerEpoch', true),
    engine: requireText(input.engine, 'engine'),
    workspaceFingerprint: input.workspaceFingerprint?.trim()
      || fingerprintRunWorkspace(input.workspace),
    agentId: input.agentId?.trim() || undefined,
    parentRunId: input.parentRunId?.trim() || undefined,
    processInstanceId: requireText(input.processInstanceId, 'processInstanceId'),
  });
}

export function createChildRunTraceContext(
  parent: RunTraceContext,
  overrides: Partial<Pick<
    RunTraceContext,
    'runId' | 'sessionId' | 'attempt' | 'ownerEpoch' | 'engine' | 'workspaceFingerprint'
    | 'agentId' | 'parentRunId' | 'processInstanceId'
  >> = {},
): RunTraceContext {
  return createRunTraceContext({
    ...parent,
    ...overrides,
    traceId: parent.traceId,
    spanId: newSpanId(),
    traceFlags: parent.traceFlags,
    traceState: parent.traceState,
  });
}

function asOtelContext(runTraceContext: RunTraceContext): Context {
  let otelContext = ROOT_CONTEXT.setValue(RUN_TRACE_CONTEXT_KEY, runTraceContext);
  let traceState: TraceState | undefined;
  if (runTraceContext.traceState) {
    traceState = createTraceState(runTraceContext.traceState);
  }
  otelContext = trace.setSpanContext(otelContext, {
    traceId: runTraceContext.traceId,
    spanId: runTraceContext.spanId,
    traceFlags: runTraceContext.traceFlags,
    traceState,
    isRemote: false,
  });
  return otelContext;
}

export function withRunTraceContext<T>(
  runTraceContext: RunTraceContext,
  callback: () => T,
): T {
  return contextStorage.run(asOtelContext(runTraceContext), callback);
}

export function getActiveRunTraceContext(): RunTraceContext | undefined {
  return contextStorage.getStore()?.getValue(RUN_TRACE_CONTEXT_KEY) as RunTraceContext | undefined;
}

export function bindRunTraceContext<TArgs extends unknown[], TResult>(
  runTraceContext: RunTraceContext,
  callback: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  return (...args) => withRunTraceContext(runTraceContext, () => callback(...args));
}

export function serializeRunTraceContext(runTraceContext: RunTraceContext): SerializedRunTraceContext {
  const flags = runTraceContext.traceFlags.toString(16).padStart(2, '0');
  return Object.freeze({
    ...runTraceContext,
    traceparent: `00-${runTraceContext.traceId}-${runTraceContext.spanId}-${flags}`,
    tracestate: runTraceContext.traceState,
  });
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
}

function readNumber(value: Record<string, unknown>, key: string): number | undefined {
  const candidate = value[key];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
}

export function restoreRunTraceContext(value: unknown): RunTraceContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Serialized RunTraceContext must be an object');
  }
  const record = value as Record<string, unknown>;
  const traceparent = readString(record, 'traceparent');
  const match = traceparent?.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-(0[01])$/);
  const traceId = readString(record, 'traceId') ?? match?.[1];
  const spanId = readString(record, 'spanId') ?? match?.[2];
  const traceFlags = readNumber(record, 'traceFlags') ?? (match ? Number.parseInt(match[3], 16) : undefined);
  if (!traceId || !spanId || traceFlags === undefined) {
    throw new Error('Serialized RunTraceContext is missing W3C trace identity');
  }
  return createRunTraceContext({
    traceId,
    spanId,
    traceFlags,
    traceState: readString(record, 'traceState') ?? readString(record, 'tracestate'),
    runId: requireText(readString(record, 'runId') ?? '', 'runId'),
    sessionId: requireText(readString(record, 'sessionId') ?? '', 'sessionId'),
    attempt: requirePositiveInteger(readNumber(record, 'attempt') ?? -1, 'attempt'),
    ownerEpoch: requirePositiveInteger(readNumber(record, 'ownerEpoch') ?? -1, 'ownerEpoch', true),
    engine: requireText(readString(record, 'engine') ?? '', 'engine'),
    workspaceFingerprint: requireText(
      readString(record, 'workspaceFingerprint') ?? '',
      'workspaceFingerprint',
    ),
    agentId: readString(record, 'agentId'),
    parentRunId: readString(record, 'parentRunId'),
    processInstanceId: requireText(
      readString(record, 'processInstanceId') ?? '',
      'processInstanceId',
    ),
  });
}
