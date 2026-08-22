// ============================================================================
// SessionInspector 投影模型 —— 账本事件 → 两层视图 + 组装面板（纯函数，无 React）
// ----------------------------------------------------------------------------
// 账本合同（TraceEventDataMap，前后端唯一合同）的消费侧。这里只做投影：
// 不推断账本里没有的事实，缺什么就如实标「未记录 / 不可回放」。
//
// 关键口径：账本 turnIndex 是一次 run 内的循环迭代号（每轮用户输入从 1 重启），
// 不是跨 run 的轮号。turn_outcome 印章在 run 收尾时落下、每个 run 恰好一枚，
// 因此「一轮」= 相邻两枚印章之间（含尾部）的事件段；末尾没有印章的段 = 进行中。
// ============================================================================

import type { TraceLedgerEvent, TraceSessionRead } from '../../../services/traceLedgerClient';
import { projectEvidenceInvalidationSequence } from '@shared/contract/evidenceInvalidation';

// ── 开放包络的安全读取 ────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

// ── 印章（turn_outcome）──────────────────────────────────────────────────

type TurnOutcomeVerdict = 'verified' | 'self_claimed' | 'n_a';

type TurnTerminal =
  | 'completed'
  | 'cancelled'
  | 'interrupted'
  | 'failed'
  | 'goal_met'
  | 'aborted';

export interface TurnOutcomeStamp {
  ts: number | null;
  terminal: TurnTerminal | null;
  verdict: TurnOutcomeVerdict | null;
  evidenceCount: number;
  source: string | null;
}

export function readTurnOutcome(event: TraceLedgerEvent): TurnOutcomeStamp | null {
  if (event.type !== 'turn_outcome' || !isRecord(event.data)) return null;
  const data = event.data;
  const invalidated = typeof event.evidenceInvalidatedAt === 'number';
  const verdict = invalidated ? 'self_claimed' : str(data.verdict);
  return {
    ts: num(event.ts),
    terminal: str(data.terminal) as TurnTerminal | null,
    verdict: verdict === 'verified' || verdict === 'self_claimed' || verdict === 'n_a' ? verdict : null,
    evidenceCount: invalidated ? 0 : Array.isArray(data.evidenceRefs) ? data.evidenceRefs.length : 0,
    source: str(data.source),
  };
}

// ── 轮（turn segment）：相邻印章之间的事件段 ─────────────────────────────

interface ToolDispatchRow {
  toolName: string;
  success: boolean;
  durationMs: number | null;
  error: string | null;
  fromCache: boolean;
  /** 人话活动桶（层1 明细行/活行用；归类规则集中在 classifyToolActivity） */
  bucket: ToolActivityBucket;
}

interface LoopDecisionRow {
  action: string | null;
  reason: string | null;
  stopReason: string | null;
}

interface InferenceRow {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  durationMs: number | null;
  finishReason: string | null;
  truncated: boolean;
}

/**
 * 层2 per-call 推理调用卡（N-LEDGER-UX1 D 项）：一轮内每次模型调用一卡。
 * 归属规则纯按事件顺序：inference 事件开一张新卡，其后到下一条 inference
 * 之前的 tool_dispatch 挂在该卡下；模型取该 inference 之前最近一份
 * request_manifest 的 actualModel/requestedModel（账本没有更细的关联字段，
 * 缺 manifest 时如实显示「未记录」）。首条 inference 之前的工具进 orphan 桶。
 */
interface InferenceCallRow {
  seq: number;
  ts: number | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  durationMs: number | null;
  finishReason: string | null;
  truncated: boolean;
  tools: ToolDispatchRow[];
}

export interface RequestManifestView {
  requestId: string | null;
  degraded: boolean;
  requestedModel: string | null;
  actualModel: string | null;
  requestedProvider: string | null;
  engine: string | null;
  appVersion: string | null;
  toolNames: string[];
  toolSchemaHash: string | null;
  temperature: number | null;
  maxTokens: number | null;
  reasoningEffort: string | null;
  messageRefs: Array<{
    kind: 'ledger_message' | 'system_prompt' | 'content' | 'unknown';
    reason: string | null;
    hashPreview: string | null;
    bytes: number | null;
  }>;
  compactionReplacementCount: number;
}

type ToolActivityBucket = 'read' | 'write' | 'command' | 'browser' | 'other';

export interface TurnSegment {
  /** 1-based 轮号（按事件流顺序） */
  index: number;
  /** 段内事件（含收尾印章本身） */
  events: TraceLedgerEvent[];
  stamp: TurnOutcomeStamp | null;
  inProgress: boolean;
  toolDispatches: ToolDispatchRow[];
  decisions: LoopDecisionRow[];
  inferences: InferenceRow[];
  manifests: RequestManifestView[];
  verificationCount: number;
  verificationSkippedCount: number;
  compactionCount: number;
  tokens: { input: number; output: number; cacheRead: number };
  toolCounts: Record<ToolActivityBucket, number>;
  failedToolCount: number;
  /** B 项（甲口径）：单轮 token > 本会话其余轮均值 × 3 且绝对值 > 20k */
  tokenAnomaly: boolean;
  /** C 项：最新一条工具调用的活动桶（活行「正在做…」用），无工具调用为 null */
  lastToolBucket: ToolActivityBucket | null;
  /** D 项：轮内 per-call 推理调用分卡（空数组 = 账本无 inference 细分，层2 降级轮级汇总） */
  inferenceCalls: InferenceCallRow[];
  /** D 项：首条 inference 之前的工具调用（挂不到任何卡下，层2 单独列出） */
  orphanToolDispatches: ToolDispatchRow[];
  startedAt: number | null;
  endedAt: number | null;
}

// ── 工具名 → 人话活动桶（层1 用；名字只做模式归类，不逐名硬编码）─────────

function classifyToolActivity(toolName: string): ToolActivityBucket {
  const name = toolName.toLowerCase();
  if (/bash|shell|exec|command|terminal|process/.test(name)) return 'command';
  if (/browser|click|navigate|playwright|computer/.test(name)) return 'browser';
  if (/write|edit|create|delete|apply|patch|move|rename|mkdir|notebook/.test(name)) return 'write';
  if (/read|search|grep|glob|find|fetch|list|get|query|lookup|inspect|view/.test(name)) return 'read';
  return 'other';
}

function readToolDispatch(event: TraceLedgerEvent): ToolDispatchRow | null {
  if (event.type !== 'tool_dispatch' || !isRecord(event.data)) return null;
  const data = event.data;
  const toolName = str(data.toolName) ?? '?';
  return {
    toolName,
    success: data.success === true,
    durationMs: num(data.durationMs),
    error: str(data.error),
    fromCache: data.fromCache === true,
    bucket: classifyToolActivity(toolName),
  };
}

function readLoopDecision(event: TraceLedgerEvent): LoopDecisionRow | null {
  if (event.type !== 'loop_decision' || !isRecord(event.data)) return null;
  const data = event.data;
  return {
    action: str(data.action),
    reason: str(data.reason),
    stopReason: str(data.stopReason),
  };
}

function readInference(event: TraceLedgerEvent): InferenceRow | null {
  if (event.type !== 'inference' || !isRecord(event.data)) return null;
  const data = event.data;
  return {
    inputTokens: num(data.inputTokens) ?? 0,
    outputTokens: num(data.outputTokens) ?? 0,
    cacheReadTokens: num(data.cacheReadTokens) ?? 0,
    durationMs: num(data.durationMs),
    finishReason: str(data.finishReason),
    truncated: data.truncated === true,
  };
}

function readManifest(event: TraceLedgerEvent): RequestManifestView | null {
  if (event.type !== 'request_manifest' || !isRecord(event.data)) return null;
  const data = event.data;
  const requested = isRecord(data.requested) ? data.requested : {};
  const adapterDefaults = isRecord(data.adapterDefaults) ? data.adapterDefaults : {};
  const messageRefs = Array.isArray(data.messageRefs) ? data.messageRefs : [];
  return {
    requestId: str(data.requestId),
    degraded: data.degraded === true,
    requestedModel: str(requested.model),
    actualModel: str(data.actualModel),
    requestedProvider: str(requested.provider),
    engine: str(adapterDefaults.engine),
    appVersion: str(data.appVersion),
    toolNames: strArray(data.toolNames),
    toolSchemaHash: str(data.toolSchemaHash),
    temperature: num(requested.temperature),
    maxTokens: num(requested.maxTokens),
    reasoningEffort: str(requested.reasoningEffort),
    messageRefs: messageRefs.map((ref) => {
      if (!isRecord(ref)) {
        return { kind: 'unknown' as const, reason: null, hashPreview: null, bytes: null };
      }
      const kind = ref.kind === 'ledger_message' || ref.kind === 'system_prompt' ? ref.kind : ref.kind === 'content' ? 'content' as const : 'unknown' as const;
      const hash = str(ref.contentHash);
      const blocks: unknown[] | null = Array.isArray(ref.blocks) ? (ref.blocks as unknown[]) : null;
      const blockBytes = blocks
        ? blocks.reduce<number>((sum, block) => sum + (isRecord(block) ? num(block.bytes) ?? 0 : 0), 0)
        : null;
      return {
        kind,
        reason: str(ref.reason),
        hashPreview: hash ? hash.slice(0, 12) : null,
        bytes: blockBytes,
      };
    }),
    compactionReplacementCount: Array.isArray(data.compactionReplacements)
      ? data.compactionReplacements.length
      : 0,
  };
}

function readVerificationSkippedCount(event: TraceLedgerEvent): number | null {
  if (event.type !== 'verification' || !isRecord(event.data)) return null;
  return Array.isArray(event.data.skippedChecks) ? event.data.skippedChecks.length : 0;
}

/** 把事件流切分成轮：每枚 turn_outcome 收一轮；末尾无印章的段是进行中。 */
export function segmentTurns(events: readonly TraceLedgerEvent[]): TurnSegment[] {
  const projectedEvents = projectEvidenceInvalidationSequence(events);
  const segments: TraceLedgerEvent[][] = [];
  let current: TraceLedgerEvent[] = [];
  for (const event of projectedEvents) {
    current.push(event);
    if (event.type === 'turn_outcome') {
      segments.push(current);
      current = [];
    }
  }
  if (current.length > 0) segments.push(current);
  const turns = segments.map((segmentEvents, index) => buildSegment(index + 1, segmentEvents));
  markTokenAnomalies(turns);
  return turns;
}

// B 项异常判据（甲口径，已拍板）：单轮 token（input+output）同时满足
// 「> 本会话其余有消耗轮的均值 × 3」与「> 20k」才报；缓存命中率不单独提示。
const TOKEN_ANOMALY_MEAN_RATIO = 3;
const TOKEN_ANOMALY_ABSOLUTE_MIN = 20_000;

function markTokenAnomalies(turns: TurnSegment[]): void {
  const totals = turns.map((turn) => turn.tokens.input + turn.tokens.output);
  turns.forEach((turn, index) => {
    const total = totals[index];
    const others = totals.filter((value, otherIndex) => otherIndex !== index && value > 0);
    if (total <= 0 || others.length === 0) return;
    const mean = others.reduce((sum, value) => sum + value, 0) / others.length;
    turn.tokenAnomaly =
      total > mean * TOKEN_ANOMALY_MEAN_RATIO && total > TOKEN_ANOMALY_ABSOLUTE_MIN;
  });
}

/** D 项：按事件顺序把 inference/tool_dispatch 组成 per-call 卡（纯投影，不推断账本外事实）。 */
function buildInferenceCalls(
  events: readonly TraceLedgerEvent[],
): { calls: InferenceCallRow[]; orphans: ToolDispatchRow[] } {
  const calls: InferenceCallRow[] = [];
  const orphans: ToolDispatchRow[] = [];
  let currentModel: string | null = null;
  for (const event of events) {
    const manifest = readManifest(event);
    if (manifest) {
      currentModel = manifest.actualModel ?? manifest.requestedModel;
      continue;
    }
    const inference = readInference(event);
    if (inference) {
      calls.push({
        seq: calls.length + 1,
        ts: num(event.ts),
        model: currentModel,
        ...inference,
        tools: [],
      });
      continue;
    }
    const dispatch = readToolDispatch(event);
    if (dispatch) {
      const currentCall = calls[calls.length - 1];
      if (currentCall) currentCall.tools.push(dispatch);
      else orphans.push(dispatch);
    }
  }
  return { calls, orphans };
}

function buildSegment(index: number, events: TraceLedgerEvent[]): TurnSegment {
  const stamps = events.map(readTurnOutcome).filter((stamp): stamp is TurnOutcomeStamp => stamp !== null);
  const toolDispatches = events.map(readToolDispatch).filter((row): row is ToolDispatchRow => row !== null);
  const decisions = events.map(readLoopDecision).filter((row): row is LoopDecisionRow => row !== null);
  const inferences = events.map(readInference).filter((row): row is InferenceRow => row !== null);
  const manifests = events.map(readManifest).filter((row): row is RequestManifestView => row !== null);
  const verificationEvents = events.map(readVerificationSkippedCount).filter((count): count is number => count !== null);

  const toolCounts: Record<ToolActivityBucket, number> = { read: 0, write: 0, command: 0, browser: 0, other: 0 };
  let failedToolCount = 0;
  for (const dispatch of toolDispatches) {
    toolCounts[dispatch.bucket] += 1;
    if (!dispatch.success) failedToolCount += 1;
  }

  const tokens = inferences.reduce(
    (sum, row) => ({
      input: sum.input + row.inputTokens,
      output: sum.output + row.outputTokens,
      cacheRead: sum.cacheRead + row.cacheReadTokens,
    }),
    { input: 0, output: 0, cacheRead: 0 },
  );

  const { calls: inferenceCalls, orphans: orphanToolDispatches } = buildInferenceCalls(events);
  const timestamps = events.map((event) => num(event.ts)).filter((ts): ts is number => ts !== null);

  return {
    index,
    events,
    stamp: stamps[stamps.length - 1] ?? null,
    inProgress: stamps.length === 0,
    toolDispatches,
    decisions,
    inferences,
    manifests,
    verificationCount: verificationEvents.length,
    verificationSkippedCount: verificationEvents.reduce((sum, count) => sum + count, 0),
    compactionCount: events.filter((event) => event.type === 'compaction').length,
    tokens,
    toolCounts,
    failedToolCount,
    tokenAnomaly: false,
    lastToolBucket: toolDispatches.length > 0
      ? toolDispatches[toolDispatches.length - 1].bucket
      : null,
    inferenceCalls,
    orphanToolDispatches,
    startedAt: timestamps.length > 0 ? Math.min(...timestamps) : null,
    endedAt: timestamps.length > 0 ? Math.max(...timestamps) : null,
  };
}

// ── 「本会话实际组装」面板：manifest + 账本事件投影 ───────────────────────

export interface AssemblyModel {
  hasManifest: boolean;
  degraded: boolean;
  model: string | null;
  engine: string | null;
  appVersion: string | null;
  toolNames: string[];
  toolSchemaHash: string | null;
  promptSegments: {
    systemPrompt: number;
    ledgerMessage: number;
    dynamicTail: number;
    runtimeInjection: number;
    postAssemblyRewrite: number;
  };
  compactionCount: number;
  verificationCount: number;
  verificationSkippedCount: number;
}

/** 取最新一份 manifest 作为「本会话实际组装」的真源；其余维度从账本事件聚合。 */
export function buildAssemblyModel(events: readonly TraceLedgerEvent[]): AssemblyModel {
  const manifests = events.map(readManifest).filter((row): row is RequestManifestView => row !== null);
  const latest = manifests[manifests.length - 1] ?? null;
  const promptSegments = {
    systemPrompt: 0,
    ledgerMessage: 0,
    dynamicTail: 0,
    runtimeInjection: 0,
    postAssemblyRewrite: 0,
  };
  if (latest) {
    for (const ref of latest.messageRefs) {
      if (ref.kind === 'system_prompt') promptSegments.systemPrompt += 1;
      else if (ref.kind === 'ledger_message') promptSegments.ledgerMessage += 1;
      else if (ref.reason === 'dynamic_tail') promptSegments.dynamicTail += 1;
      else if (ref.reason === 'runtime_injection') promptSegments.runtimeInjection += 1;
      else if (ref.kind === 'content') promptSegments.postAssemblyRewrite += 1;
    }
  }
  const verificationEvents = events.map(readVerificationSkippedCount).filter((count): count is number => count !== null);
  return {
    hasManifest: latest !== null,
    degraded: latest?.degraded ?? false,
    model: latest ? latest.actualModel ?? latest.requestedModel : null,
    engine: latest?.engine ?? null,
    appVersion: latest?.appVersion ?? null,
    toolNames: latest?.toolNames ?? [],
    toolSchemaHash: latest?.toolSchemaHash ?? null,
    promptSegments,
    compactionCount: events.filter((event) => event.type === 'compaction').length,
    verificationCount: verificationEvents.length,
    verificationSkippedCount: verificationEvents.reduce((sum, count) => sum + count, 0),
  };
}

// ── tail 增量合并（活会话跟随；游标是字节偏移，天然不重复）──────────────

export function applyTail(previous: TraceSessionRead, tail: TraceSessionRead): TraceSessionRead {
  if (tail.sessionId !== previous.sessionId) return tail;
  // 游标没有前进说明服务端视角没有新内容（或文件被重建），以服务端读数为准但不重复追加。
  if (tail.cursor === previous.cursor && tail.events.length === 0) {
    return { ...previous, state: tail.state, skippedLines: previous.skippedLines + tail.skippedLines };
  }
  return {
    sessionId: previous.sessionId,
    state: tail.state,
    events: [...previous.events, ...tail.events],
    skippedLines: previous.skippedLines + tail.skippedLines,
    cursor: Math.max(previous.cursor, tail.cursor),
  };
}

// ── token 人话格式化（层1/层2 共用）─────────────────────────────────────

export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(Math.round(tokens));
}
