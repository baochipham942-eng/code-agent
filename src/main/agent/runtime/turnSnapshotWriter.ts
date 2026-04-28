// ============================================================================
// Turn Snapshot Writer — 每个 agent turn 落一行调试快照到 turn_snapshots 表
// 给设置页 / debug session / debug context 子命令消费
// ============================================================================

import { getDatabase } from '../../services/core/databaseService';
import { createLogger } from '../../services/infra/logger';
import type { Message } from '../../../shared/contract';

const logger = createLogger('TurnSnapshotWriter');

interface SnapshotSink {
  insertTurnSnapshot: (input: {
    sessionId: string;
    turnId?: string | null;
    turnIndex: number;
    contextChunks?: unknown;
    tokenBreakdown?: unknown;
    createdAt?: number;
  }) => { id: string; createdAt: number; byteSize: number };
}

function getSnapshotSink(): SnapshotSink | null {
  if (process.env.CODE_AGENT_CLI_MODE === 'true') {
    try {
      // 动态 require 避免 main → cli 的反向静态依赖
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const cliDbMod = require('../../../cli/database') as {
        getCLIDatabase?: () => { isInitialized: boolean } & SnapshotSink;
      };
      const cliDb = cliDbMod.getCLIDatabase?.();
      if (cliDb?.isInitialized) return cliDb;
    } catch {
      // CLI bundle 不可用时静默 no-op
    }
    return null;
  }
  const db = getDatabase();
  return db?.isReady ? (db as unknown as SnapshotSink) : null;
}

export interface TurnSnapshotInput {
  sessionId: string;
  turnId?: string | null;
  turnIndex: number;
  systemPrompt?: string;
  messages?: Message[];
  inputTokens?: number;
  outputTokens?: number;
  inferenceDurationMs?: number;
}

// 6 层上下文的已知 XML-like 标签（对齐 Light Memory 架构）
const KNOWN_LAYER_TAGS = [
  'session_metadata',
  'memory_index',
  'memory_system',
  'recent_conversations',
  'rag_context',
  'workspace_activity',
  'plan_context',
] as const;

interface ParsedLayer {
  name: string;
  size: number;
  snippet: string;
}

/**
 * 把 system prompt 拆成已知的 6 层（identity + XML 标签块）
 * 没匹配到标签的部分归入 'identity'（身份/指令头）
 */
function parseSystemPromptLayers(prompt: string): ParsedLayer[] {
  if (!prompt) return [];
  const layers: ParsedLayer[] = [];
  let residual = prompt;

  for (const tag of KNOWN_LAYER_TAGS) {
    const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
    const match = regex.exec(prompt);
    if (!match) continue;
    const content = match[1] ?? '';
    layers.push({
      name: tag,
      size: content.length,
      snippet: content.trim().slice(0, 200).replace(/\s+/g, ' '),
    });
    residual = residual.replace(match[0], '');
  }

  const identityText = residual.trim();
  if (identityText) {
    layers.unshift({
      name: 'identity',
      size: identityText.length,
      snippet: identityText.slice(0, 200).replace(/\s+/g, ' '),
    });
  }

  return layers;
}

/**
 * 写一条 turn snapshot。错误不阻塞 agent loop（debug 可观测性是非关键路径）。
 */
export function writeTurnSnapshot(input: TurnSnapshotInput): void {
  try {
    const sink = getSnapshotSink();
    if (!sink) return;

    const systemPromptSize = input.systemPrompt
      ? Buffer.byteLength(input.systemPrompt, 'utf8')
      : 0;

    const layers = parseSystemPromptLayers(input.systemPrompt ?? '');

    // 最近 20 条消息的轻量摘要（Layer 5 — Current Session）
    const recentMessages = (input.messages ?? []).slice(-20).map((m) => ({
      id: m.id,
      role: m.role,
      timestamp: m.timestamp,
      contentLength: typeof m.content === 'string' ? m.content.length : 0,
      hasToolCalls: Boolean(m.toolCalls?.length),
      hasToolResults: Boolean(m.toolResults?.length),
    }));

    sink.insertTurnSnapshot({
      sessionId: input.sessionId,
      turnId: input.turnId ?? null,
      turnIndex: input.turnIndex,
      contextChunks: {
        systemPromptSize,
        messageCount: input.messages?.length ?? 0,
        layers,
        recentMessages,
      },
      tokenBreakdown: {
        inputTokens: input.inputTokens ?? 0,
        outputTokens: input.outputTokens ?? 0,
        inferenceDurationMs: input.inferenceDurationMs ?? 0,
      },
    });
  } catch (err) {
    logger.warn('[TurnSnapshotWriter] failed to write snapshot', err);
  }
}
