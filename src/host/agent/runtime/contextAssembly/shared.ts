import { readdirSync, readFileSync, statSync } from 'fs';
import type { Message, ToolCall, ToolResult } from '../../../../shared/contract';
import type { ContextInterventionSnapshot } from '../../../../shared/contract/contextView';
import type { ModelDecisionEventData } from '../../../../shared/contract/modelDecision';
import type {
  AgentLoopConfig,
  ModelMessage,
  ModelResponse,
} from '../../../agent/loopTypes';
import type { ContextEventRecord } from '../../../context/contextEventLedger';
import type { ProjectableMessage } from '../../../context/projectionEngine';
import { createLogger } from '../../../services/infra/logger';
import { SYSTEM_PROMPT_BUDGET, getContextWindow } from '../../../../shared/constants';
import type { RuntimeContext } from '../runtimeContext';
import type { TaskProgressPort } from '../runtimePorts';

const fileCache = new Map<string, { content: string; mtime: number }>();

export function cachedReadFileSync(path: string): string {
  try {
    const stat = statSync(path);
    const cached = fileCache.get(path);
    if (cached?.mtime === stat.mtimeMs) return cached.content;
    const content = readFileSync(path, 'utf-8');
    fileCache.set(path, { content, mtime: stat.mtimeMs });
    return content;
  } catch {
    fileCache.delete(path);
    throw new Error(`Cannot read file: ${path}`);
  }
}

const dirCache = new Map<string, { files: string[]; ts: number }>();

export function cachedReaddirSync(dir: string): string[] {
  const cached = dirCache.get(dir);
  if (cached && Date.now() - cached.ts < 30_000) return cached.files;
  const files = readdirSync(dir);
  dirCache.set(dir, { files, ts: Date.now() });
  return files;
}

export function normalizePersistentSystemContextKey(content: string): string {
  const trimmed = content.trim();
  const artifactRecoveryTarget = /<artifact-repair-recovery>[\s\S]*?inside artifact repair mode for ([^\n.]+(?:\.[A-Za-z0-9]+)?)/i.exec(trimmed)?.[1];
  if (artifactRecoveryTarget) {
    return `artifact-repair-recovery:${artifactRecoveryTarget.trim()}`;
  }
  const artifactAnchorTarget = /<artifact-repair-edit-anchor-failed>[\s\S]*?active for ([^\n.]+(?:\.[A-Za-z0-9]+)?)/i.exec(trimmed)?.[1];
  if (artifactAnchorTarget) {
    return `artifact-repair-edit-anchor-failed:${artifactAnchorTarget.trim()}`;
  }
  return trimmed.replace(/\s+/g, ' ');
}

export const logger = createLogger('AgentLoop');
export const MAX_SYSTEM_PROMPT_TOKENS = parseInt(process.env.CODE_AGENT_MAX_SYSTEM_PROMPT_TOKENS || String(SYSTEM_PROMPT_BUDGET.MIN_TOKENS), 10);

/**
 * GAP-023: system prompt 预算动态化。
 * - 显式 env 覆盖（CODE_AGENT_MAX_SYSTEM_PROMPT_TOKENS）优先——评测/对照实验用
 * - 否则按模型上下文窗口的 WINDOW_RATIO 计算，下限 MIN_TOKENS（小窗口模型不低于历史默认值）
 * 修复重记忆环境下 base prompt 吃满固定 6000 后能力发现块全被静默丢弃的问题。
 */
export function getSystemPromptBudget(model?: string): number {
  if (process.env.CODE_AGENT_MAX_SYSTEM_PROMPT_TOKENS) {
    return MAX_SYSTEM_PROMPT_TOKENS;
  }
  if (model) {
    return Math.max(
      SYSTEM_PROMPT_BUDGET.MIN_TOKENS,
      Math.floor(getContextWindow(model) * SYSTEM_PROMPT_BUDGET.WINDOW_RATIO),
    );
  }
  return MAX_SYSTEM_PROMPT_TOKENS;
}
export const MAX_PERSISTENT_SYSTEM_CONTEXT_TOKENS = 1200;
export const MAX_PERSISTENT_SYSTEM_CONTEXT_ITEMS = 6;
export const MAX_PERSISTENT_SYSTEM_CONTEXT_ITEM_TOKENS = 260;

export interface ContextTranscriptEntry extends ProjectableMessage {
  originMessageId: string;
  timestamp: number;
  turnIndex: number;
  toolCallId?: string;
  toolError?: boolean;
  attachments?: Message['attachments'];
  toolCalls?: Message['toolCalls'];
  thinking?: string;
  preserveObservation?: boolean;
  evidenceKind?: string;
  filePath?: string;
}

export type CurrentAttachment = {
  type: string;
  category?: string;
  name?: string;
  path?: string;
  data?: string;
  mimeType?: string;
};

/** 2b: inference 一次性重试恢复状态（原 RuntimeContext 字段，ADR-038 批2b 下沉） */
export interface InferenceRecoveryState {
  _contextOverflowRetried: boolean;
  _artifactNonStreamingRetried: boolean;
  _artifactRepairCompactWriteRetried: boolean;
  _networkRetried: boolean;
  currentModelDecision?: ModelDecisionEventData;
}

/** 2c: compression 恢复/断路状态（原 RuntimeContext 字段，ADR-038 批2c 下沉） */
export interface CompressionRecoveryState {
  _consecutiveCompacts: number;
  _autoCompactPaused: boolean;
  _summaryFailureStreak: number;
  _summaryCooldownUntil: number;
}

export interface ContextAssemblyCtx {
  runtime: RuntimeContext;
  inferenceRecovery: InferenceRecoveryState;
  compressionRecovery: CompressionRecoveryState;
  taskProgress: TaskProgressPort;
  recordTokenUsage(
    inputTokens: number,
    outputTokens: number,
    cache?: { cacheReadTokens?: number; cacheCreationTokens?: number },
  ): void;
  inference(): Promise<ModelResponse>;
  buildModelMessages(): Promise<ModelMessage[]>;
  buildContextTranscriptEntries(messages: Message[]): ContextTranscriptEntry[];
  mapInterventionsToTranscriptEntries(
    interventions: ContextInterventionSnapshot,
    entries: ContextTranscriptEntry[],
  ): ContextInterventionSnapshot;
  summarizeCollapsedContext(messages: Array<{ role: string; content: string }>): Promise<string>;
  loadResearchSkillPrompt(): string | null;
  injectSystemMessage(content: string, category?: string): void;
  flushHookMessageBuffer(): void;
  pushPersistentSystemContext(content: string): void;
  getBudgetedPersistentSystemContext(): string[];
  trimPersistentSystemContext(): void;
  truncatePersistentSystemContext(content: string, maxTokens: number): string;
  inferBufferedSystemMessageCategory(content: string): string | undefined;
  generateId(): string;
  recordContextEventsForMessage(message: Message): void;
  buildContextEventsForMessage(message: Message): ContextEventRecord[];
  checkAndAutoCompress(): Promise<void>;
  shouldThink(hasErrors: boolean): boolean;
  generateThinkingPrompt(toolCalls: ToolCall[], toolResults: ToolResult[]): string;
  formatArtifactRepairToolResultContent(
    result: { output?: string; error?: string; metadata?: Record<string, unknown> },
    originalContent: string,
  ): string;
}

export type { AgentLoopConfig };
