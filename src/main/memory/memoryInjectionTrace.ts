export type MemoryInjectionBlockType =
  | 'seed-memory'
  | 'memory_index'
  | 'memory_hint'
  | 'recent_conversations'
  | 'failure_journal';

export interface MemoryInjectionTrace {
  id: string;
  blockType: MemoryInjectionBlockType;
  trigger: string;
  chars: number;
  injected: boolean;
  source: string;
  count: number;
  timestamp: number;
  sessionId: string;
}

export interface RecordMemoryInjectionTraceInput {
  blockType: MemoryInjectionBlockType;
  trigger: string;
  chars?: number;
  injected: boolean;
  source: string;
  count?: number;
  sessionId: string;
  timestamp?: number;
}

const MAX_TRACES = 500;
const traces: MemoryInjectionTrace[] = [];

function countNonEmptyLines(content: string | null | undefined): number {
  if (!content) return 0;
  return content.split('\n').filter((line) => line.trim().length > 0).length;
}

export function countTraceEntries(content: string | null | undefined, marker = /^-\s+/): number {
  if (!content) return 0;
  const markerCount = content.split('\n').filter((line) => marker.test(line.trim())).length;
  return markerCount || countNonEmptyLines(content);
}

export function recordMemoryInjectionTrace(input: RecordMemoryInjectionTraceInput): MemoryInjectionTrace {
  const timestamp = input.timestamp ?? Date.now();
  const trace: MemoryInjectionTrace = {
    id: `${input.sessionId}:${input.blockType}:${timestamp}:${traces.length}`,
    blockType: input.blockType,
    trigger: input.trigger,
    chars: Math.max(0, input.chars ?? 0),
    injected: input.injected,
    source: input.source,
    count: Math.max(0, input.count ?? 0),
    timestamp,
    sessionId: input.sessionId,
  };

  traces.push(trace);
  if (traces.length > MAX_TRACES) {
    traces.splice(0, traces.length - MAX_TRACES);
  }
  return trace;
}

export function listMemoryInjectionTraces(options: {
  sessionId?: string | null;
  limit?: number;
} = {}): MemoryInjectionTrace[] {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const sessionId = options.sessionId?.trim();
  return traces
    .filter((trace) => !sessionId || trace.sessionId === sessionId)
    .slice(-limit)
    .reverse();
}

export function clearMemoryInjectionTracesForTest(): void {
  traces.splice(0, traces.length);
}
