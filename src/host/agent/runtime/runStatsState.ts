import type { ModelDecision } from '../../../shared/contract/modelDecision';

/**
 * ADR-038 批3d: run 级统计与 tracing 域切片。
 * 字段私有、读走 getter、写走显式方法。
 */
export class RunStatsState {
  private _traceId = '';
  private _lastModelTraceSpanId?: string;
  private _runStartTime = 0;
  private _totalInputTokens = 0;
  private _totalOutputTokens = 0;
  private _totalTokensUsed = 0;
  private _totalToolCallCount = 0;
  private _pendingRuntimeDiagnostics: string[] = [];
  private _turnModelDecision?: ModelDecision;

  get traceId(): string { return this._traceId; }
  get lastModelTraceSpanId(): string | undefined { return this._lastModelTraceSpanId; }
  get runStartTime(): number { return this._runStartTime; }
  get totalInputTokens(): number { return this._totalInputTokens; }
  get totalOutputTokens(): number { return this._totalOutputTokens; }
  get totalTokensUsed(): number { return this._totalTokensUsed; }
  get totalToolCallCount(): number { return this._totalToolCallCount; }
  get pendingRuntimeDiagnostics(): string[] { return this._pendingRuntimeDiagnostics; }
  get turnModelDecision(): ModelDecision | undefined { return this._turnModelDecision; }

  setTraceId(traceId: string): void {
    this._traceId = traceId;
  }

  setLastModelTraceSpan(spanId: string | undefined): void {
    this._lastModelTraceSpanId = spanId;
  }

  /** run 起始重置（保持原 initializeRun 语义：input/output 累计值不在此清零） */
  beginRun(): void {
    this._runStartTime = Date.now();
    this._totalTokensUsed = 0;
    this._totalToolCallCount = 0;
  }

  addTokenUsage(inputTokens: number, outputTokens: number): void {
    this._totalInputTokens += inputTokens;
    this._totalOutputTokens += outputTokens;
    this._totalTokensUsed += inputTokens + outputTokens;
  }

  addToolCalls(count: number): void {
    this._totalToolCallCount += count;
  }

  queueDiagnostic(message: string): void {
    this._pendingRuntimeDiagnostics.push(message);
  }

  /** 取走并清空待发诊断（原 splice(0) 语义） */
  drainDiagnostics(): string[] {
    return this._pendingRuntimeDiagnostics.splice(0);
  }

  setTurnModelDecision(decision: ModelDecision | undefined): void {
    this._turnModelDecision = decision;
  }

  /** @internal 测试专用：按种子构造任意初始状态，生产代码禁止调用 */
  static forTest(seed?: {
    traceId?: string;
    lastModelTraceSpanId?: string;
    runStartTime?: number;
    totalInputTokens?: number;
    totalOutputTokens?: number;
    totalTokensUsed?: number;
    totalToolCallCount?: number;
    pendingRuntimeDiagnostics?: string[];
    turnModelDecision?: ModelDecision;
  }): RunStatsState {
    const state = new RunStatsState();
    if (!seed) return state;
    if (seed.traceId !== undefined) state._traceId = seed.traceId;
    if (seed.lastModelTraceSpanId !== undefined) state._lastModelTraceSpanId = seed.lastModelTraceSpanId;
    if (seed.runStartTime !== undefined) state._runStartTime = seed.runStartTime;
    if (seed.totalInputTokens !== undefined) state._totalInputTokens = seed.totalInputTokens;
    if (seed.totalOutputTokens !== undefined) state._totalOutputTokens = seed.totalOutputTokens;
    if (seed.totalTokensUsed !== undefined) state._totalTokensUsed = seed.totalTokensUsed;
    if (seed.totalToolCallCount !== undefined) state._totalToolCallCount = seed.totalToolCallCount;
    if (seed.pendingRuntimeDiagnostics !== undefined) state._pendingRuntimeDiagnostics = seed.pendingRuntimeDiagnostics;
    if (seed.turnModelDecision !== undefined) state._turnModelDecision = seed.turnModelDecision;
    return state;
  }
}
