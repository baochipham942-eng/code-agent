import path from 'node:path';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

type TraceLedgerState = 'missing' | 'empty' | 'present';

/**
 * The read side deliberately keeps the event envelope open. Writers may add
 * event types before this process is upgraded, and inspectors still need the
 * original payload instead of a decoder failure.
 */
interface TraceLedgerEvent {
  ts?: unknown;
  sessionId?: unknown;
  turnIndex?: unknown;
  type?: unknown;
  data?: unknown;
  [key: string]: unknown;
}

interface TraceSessionReadResult {
  sessionId: string;
  state: TraceLedgerState;
  events: TraceLedgerEvent[];
  skippedLines: number;
  cursor: number;
}

interface TraceTokenSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

interface TraceSessionSummary {
  sessionId: string;
  state: TraceLedgerState;
  turnOutcomes: TraceLedgerEvent[];
  tokenUsage: TraceTokenSummary;
  turnCount: number;
  skippedLines: number;
}

interface ScanResult {
  state: TraceLedgerState;
  skippedLines: number;
  cursor: number;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT');
}

function isRecord(value: unknown): value is TraceLedgerEvent {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function assertSessionId(sessionId: string): void {
  if (
    sessionId.length === 0
    || sessionId === '.'
    || sessionId === '..'
    || sessionId.includes('/')
    || sessionId.includes('\\')
    || sessionId.includes('\0')
  ) {
    throw new RangeError('Invalid trace session id');
  }
}

export class TraceReadService {
  // TODO(N-LEDGER): rotation and retention belong to the ledger lifecycle phase;
  // this P0 reader intentionally never mutates trace files.
  private readonly traceDirectory: string;

  constructor(userDataDirectory: string) {
    this.traceDirectory = path.join(userDataDirectory, 'traces');
  }

  async readSession(sessionId: string): Promise<TraceSessionReadResult> {
    const events: TraceLedgerEvent[] = [];
    const scan = await this.scanSession(sessionId, 0, (event) => events.push(event));
    return { sessionId, ...scan, events };
  }

  async tailSession(sessionId: string, cursor = 0): Promise<TraceSessionReadResult> {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new RangeError('Trace cursor must be a non-negative safe integer');
    }
    const events: TraceLedgerEvent[] = [];
    const scan = await this.scanSession(sessionId, cursor, (event) => events.push(event));
    return { sessionId, ...scan, events };
  }

  async summarizeSessions(sessionIds: readonly string[]): Promise<TraceSessionSummary[]> {
    const summaries: TraceSessionSummary[] = [];
    for (const sessionId of sessionIds) {
      const turnOutcomes: TraceLedgerEvent[] = [];
      const turns = new Set<number>();
      const tokenUsage: TraceTokenSummary = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
      const scan = await this.scanSession(sessionId, 0, (event) => {
        if (typeof event.turnIndex === 'number' && Number.isSafeInteger(event.turnIndex) && event.turnIndex >= 0) {
          turns.add(event.turnIndex);
        }
        if (event.type === 'turn_outcome') {
          turnOutcomes.push(event);
        }
        if (event.type === 'inference' && isRecord(event.data)) {
          tokenUsage.inputTokens += finiteNonNegative(event.data.inputTokens);
          tokenUsage.outputTokens += finiteNonNegative(event.data.outputTokens);
          tokenUsage.cacheReadTokens += finiteNonNegative(event.data.cacheReadTokens);
        }
      });
      summaries.push({
        sessionId,
        state: scan.state,
        turnOutcomes,
        tokenUsage,
        turnCount: turns.size,
        skippedLines: scan.skippedLines,
      });
    }
    return summaries;
  }

  private async scanSession(
    sessionId: string,
    cursor: number,
    onEvent: (event: TraceLedgerEvent) => void,
  ): Promise<ScanResult> {
    assertSessionId(sessionId);
    const filePath = path.join(this.traceDirectory, `${sessionId}.jsonl`);
    let fileSize: number;
    try {
      fileSize = (await stat(filePath)).size;
    } catch (error) {
      if (isMissingFile(error)) {
        return { state: 'missing', skippedLines: 0, cursor: 0 };
      }
      throw error;
    }

    if (cursor > fileSize) {
      throw new RangeError(`Trace cursor ${cursor} is beyond file size ${fileSize}`);
    }
    const state: TraceLedgerState = fileSize === 0 ? 'empty' : 'present';
    if (cursor === fileSize) {
      return { state, skippedLines: 0, cursor };
    }

    let skippedLines = 0;
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const parseLine = (line: Buffer) => {
      const normalized = line.length > 0 && line[line.length - 1] === 13
        ? line.subarray(0, line.length - 1)
        : line;
      try {
        const parsed: unknown = JSON.parse(normalized.toString('utf8'));
        if (isRecord(parsed)) {
          onEvent(parsed);
        } else {
          skippedLines += 1;
        }
      } catch {
        skippedLines += 1;
      }
    };

    const stream: AsyncIterable<string | Buffer> = createReadStream(filePath, { start: cursor, end: fileSize - 1 });
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      pending = pending.length === 0 ? bytes : Buffer.concat([pending, bytes]);
      let newline = pending.indexOf(10);
      while (newline >= 0) {
        parseLine(pending.subarray(0, newline));
        pending = pending.subarray(newline + 1);
        newline = pending.indexOf(10);
      }
    }
    // A crash may leave the final JSONL record without a newline. It is still
    // a readable record; a syntactically partial record is counted loudly.
    if (pending.length > 0) parseLine(pending);

    return { state, skippedLines, cursor: fileSize };
  }
}
