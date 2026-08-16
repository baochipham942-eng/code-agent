// ============================================================================
// TurnTraceRecorder — 一个 run 内「决策 → dispatch → compaction」的结构化 trace
// ============================================================================
//
// G20：此前 loop decision 只 logger.debug 就丢了，没有统一的「一个 turn 内
// 决策→执行→观察」结构化记录。本模块提供一个 always-on、本地、可 grep/回放的
// trace：in-memory 累加，增量 append 到 per-session JSONL（不碰 SQLite，无 migration）。
//
// 设计目标：让"为什么这个 turn 这么走"可被复现，反过来用数据验证 G1/G7/G11/G12
// 这类争议（决策死区、DAG 是否死代码、压缩路径是否协调）是真 Gap 还是误判。
// ============================================================================

import path from 'path';
import { appendFileSync, mkdirSync } from 'fs';
import { getPath } from '../../platform/appPaths';
import { createLogger } from '../../services/infra/logger';
import type { EvidenceRef } from '../../../shared/contract/evidence';
import type { VerificationSkippedCheck } from '../verification';

const logger = createLogger('TurnTrace');

export type TraceEventType =
  | 'inference'
  | 'loop_decision'
  | 'tool_dispatch'
  | 'compaction'
  | 'verification'
  | 'goal_verdict'
  | 'goal_evidence_gate'
  | 'deliverables_declaration'
  | 'request_manifest'
  | 'turn_outcome'
  | 'compensation_registered'
  | 'capability_lifecycle';

export type RequestManifestMessageRef =
  | { kind: 'ledger_message'; messageId: string }
  | { kind: 'system_prompt'; contentHash: string }
  | {
      kind: 'content';
      contentHash: string;
      reason: 'dynamic_tail' | 'runtime_injection' | 'post_assembly_rewrite' | 'system_prompt_fallback';
      /**
       * P2 block-addressed form. Each cache entry is an exact canonical JSON
       * fragment; concatenating the ordered blocks must hash to contentHash.
       * Absent on P0/P1 manifests, whose contentHash addresses the full JSON.
       */
      blocks?: Array<{ contentHash: string; bytes: number }>;
      /** P2 attachment form: structure JSON in content_cache, bytes on disk. */
      structureHash?: string;
      attachmentBlobs?: RequestManifestAttachmentBlobRef[];
    };

export interface RequestManifestAttachmentBlobRef {
  version: 1;
  filePath: string;
  sha256: string;
  bytes: number;
}

export interface TraceEventDataMap {
  inference: {
    responseType: string;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    finishReason: string | null;
    truncated: boolean;
  };
  loop_decision: {
    action: string;
    execution: string;
    reason: string;
    stopReason: string;
    consecutiveErrors: number;
    contextRatio: number;
  };
  tool_dispatch: {
    toolName: string;
    success: boolean;
    durationMs: number;
    error: string | null;
    fromCache: boolean;
  };
  compaction: {
    layersTriggered: string[];
    totalTokens: number;
    commitCount: number;
    autocompactNeeded: boolean;
  };
  verification: {
    status: string;
    failureType: string | null;
    evidenceRefs: EvidenceRef[];
    skippedChecks: VerificationSkippedCheck[];
    workspaceSideEffects: string[] | null;
    commands: Array<{
      id: string;
      command: string;
      cwd: string;
      required: boolean;
      exitCode: number | null;
      durationMs: number;
      timedOut: boolean;
      pass: boolean;
    }>;
  };
  goal_verdict: {
    gate: 1 | 2;
    verdict: string;
    attempt: number;
    maxAttempts: number;
    detail: string;
  };
  goal_evidence_gate: {
    verdict: string;
    reason: string;
    evidenceRefs: EvidenceRef[];
  };
  deliverables_declaration:
    | { status: 'rejected'; reason: string }
    | {
        status: 'declared' | 'overridden';
        finalArtifacts: string[];
        scratchDir: string | null;
        previous: {
          finalArtifacts: string[];
          scratchDir: string | null;
          declaredAtMs: number;
        } | null;
      };
  request_manifest: {
    requestId: string;
    messageRefs: RequestManifestMessageRef[];
    toolSchemaHash: string;
    toolNames: string[];
    requested: {
      provider: string;
      model: string;
      temperature: number | null;
      maxTokens: number | null;
      reasoningEffort: string | null;
      thinkingBudget: number | null;
    };
    actualProvider: string | null;
    actualModel: string | null;
    appVersion: string;
    adapterDefaults: {
      engine: 'aisdk' | 'legacy';
      temperature: { value: number | null; source: string } | null;
      maxTokens: { value: number | null; source: string } | null;
    };
    compactionReplacements: Array<{
      replacedMessageIds: string[];
      replacementContentHash: string;
    }>;
    degraded: boolean;
  };
  turn_outcome: {
    terminal: import('./runTerminalStatus').RunTerminalStatus;
    verdict: 'verified' | 'self_claimed' | 'n_a';
    evidenceRefs: EvidenceRef[];
    source: 'generic' | 'goal_gates' | 'voice';
  };
  /** P3 slot only. Registration wiring is intentionally out of scope for P0A. */
  compensation_registered: {
    compensationId: string;
    action: string;
    target: string;
    order: number;
  };
  /** P2 slot only. Capability load/unload wiring is intentionally out of scope for P0A. */
  capability_lifecycle: {
    capabilityKey: string;
    action: 'loaded' | 'unloaded' | 'rolled_back' | 'failed';
    detail?: string;
  };
}

type TraceEventFor<T extends TraceEventType> = {
  ts: number;
  sessionId: string;
  turnIndex: number;
  type: T;
  data: TraceEventDataMap[T];
};

export type TraceEvent = {
  [T in TraceEventType]: TraceEventFor<T>;
}[TraceEventType];

/**
 * 一个 run 内的结构化 turn trace。每个 AgentLoop 实例持有一个。
 * record() 只入内存；flush() 增量落盘，fire-and-forget 安全（失败只 warn）。
 */
export class TurnTraceRecorder {
  private events: TraceEvent[] = [];
  private flushedCount = 0;
  private currentTurn = 0;
  private readonly filePath: string;

  constructor(
    private readonly sessionId: string,
    traceDir = path.join(getPath('userData'), 'traces'),
  ) {
    this.filePath = path.join(traceDir, `${sessionId}.jsonl`);
  }

  /** 切换当前 turn index，后续 record 的事件归属此 turn */
  setTurn(turnIndex: number): void {
    this.currentTurn = turnIndex;
  }

  /** 记一条 trace 事件（仅入内存） */
  record<T extends TraceEventType>(type: T, data: TraceEventDataMap[T]): void {
    this.events.push({
      ts: Date.now(),
      sessionId: this.sessionId,
      turnIndex: this.currentTurn,
      type,
      data,
    } as TraceEvent);
  }

  /** 当前已记录的全部事件（测试 / 进程内消费用） */
  getEvents(): readonly TraceEvent[] {
    return this.events;
  }

  /** 增量 append 未落盘的事件到 per-session JSONL。失败只 warn，不抛。 */
  flush(): boolean {
    const pending = this.events.slice(this.flushedCount);
    if (pending.length === 0) return true;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      const lines = pending.map((e) => JSON.stringify(e)).join('\n') + '\n';
      appendFileSync(this.filePath, lines, 'utf-8');
      this.flushedCount = this.events.length;
      return true;
    } catch (err) {
      for (const event of pending) {
        if (event.type === 'request_manifest') event.data.degraded = true;
      }
      logger.warn('flush failed', err);
      return false;
    }
  }
}
