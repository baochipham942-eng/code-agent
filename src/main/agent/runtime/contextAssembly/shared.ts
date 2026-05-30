import { readdirSync, readFileSync, statSync } from 'fs';
import type { Message, ToolCall, ToolResult } from '../../../../shared/contract';
import type { ContextInterventionSnapshot } from '../../../../shared/contract/contextView';
import type {
  AgentLoopConfig,
  ModelMessage,
  ModelResponse,
} from '../../../agent/loopTypes';
import type { ContextEventRecord } from '../../../context/contextEventLedger';
import type { ProjectableMessage } from '../../../context/projectionEngine';
import { createLogger } from '../../../services/infra/logger';
import type { RuntimeContext } from '../runtimeContext';
import type { RunFinalizer } from '../runFinalizer';

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
export const MAX_SYSTEM_PROMPT_TOKENS = parseInt(process.env.CODE_AGENT_MAX_SYSTEM_PROMPT_TOKENS || '6000', 10);
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

export interface ContextAssemblyCtx {
  runtime: RuntimeContext;
  runFinalizer: RunFinalizer;
  recordTokenUsage(inputTokens: number, outputTokens: number): void;
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
