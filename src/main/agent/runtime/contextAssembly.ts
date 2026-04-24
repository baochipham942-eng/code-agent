// ============================================================================
// ContextAssembly — Message building, inference, system prompt, compression, thinking
// Extracted from AgentLoop
// ============================================================================

// ============================================================================
// Agent Loop - Core event loop for AI agent execution
// Enhanced with Manus-style persistent planning hooks
// ============================================================================

import type { Message, ToolCall, ToolResult, AgentEvent } from '../../../shared/contract';
import { getBudgetService } from '../../services';
import { generateMessageId } from '../../../shared/utils/id';
import { createLogger } from '../../services/infra/logger';
import type {
  AgentLoopConfig,
  ModelResponse,
  ModelMessage,
} from '../../agent/loopTypes';
import type { ProjectableMessage } from '../../context/projectionEngine';
import { readdirSync, readFileSync } from 'fs';
import type { RuntimeContext } from './runtimeContext';
import type { RunFinalizer } from './runFinalizer';
import type { ContextInterventionSnapshot } from '../../../shared/contract/contextView';
import type { ContextEventRecord } from '../../context/contextEventLedger';
import { inference as inferenceImpl } from './contextAssembly/inference';
import {
  buildModelMessages as buildModelMessagesImpl,
  buildContextTranscriptEntries as buildContextTranscriptEntriesImpl,
  mapInterventionsToTranscriptEntries as mapInterventionsToTranscriptEntriesImpl,
  summarizeCollapsedContext as summarizeCollapsedContextImpl,
  stripInternalFormatMimicry as stripInternalFormatMimicryImpl,
  detectTaskPatterns as detectTaskPatternsImpl,
  getCurrentAttachments as getCurrentAttachmentsImpl,
} from './contextAssembly/messageBuild';
import {
  updateContextHealth as updateContextHealthImpl,
  checkAndAutoCompress as checkAndAutoCompressImpl,
} from './contextAssembly/compression';
import {
  injectSystemMessage as injectSystemMessageImpl,
  flushHookMessageBuffer as flushHookMessageBufferImpl,
  pushPersistentSystemContext as pushPersistentSystemContextImpl,
  getBudgetedPersistentSystemContext as getBudgetedPersistentSystemContextImpl,
  trimPersistentSystemContext as trimPersistentSystemContextImpl,
  truncatePersistentSystemContext as truncatePersistentSystemContextImpl,
  inferBufferedSystemMessageCategory as inferBufferedSystemMessageCategoryImpl,
  addAndPersistMessage as addAndPersistMessageImpl,
  recordContextEventsForMessage as recordContextEventsForMessageImpl,
  buildContextEventsForMessage as buildContextEventsForMessageImpl,
} from './contextAssembly/systemContextStack';
import {
  loadResearchSkillPrompt as loadResearchSkillPromptImpl,
  injectResearchModePrompt as injectResearchModePromptImpl,
  buildPlanContextMessage as buildPlanContextMessageImpl,
  shouldThink as shouldThinkImpl,
  generateThinkingPrompt as generateThinkingPromptImpl,
  maybeInjectThinking as maybeInjectThinkingImpl,
} from './contextAssembly/modeInjection';

// Process-level file read cache to avoid redundant readFileSync calls
const fileCache = new Map<string, { content: string; mtime: number }>();
export function cachedReadFileSync(path: string): string {
  try {
    const stat = require('fs').statSync(path);
    const cached = fileCache.get(path);
    if (cached && cached.mtime === stat.mtimeMs) return cached.content;
    const content = readFileSync(path, 'utf-8');
    fileCache.set(path, { content, mtime: stat.mtimeMs });
    return content;
  } catch {
    fileCache.delete(path);
    throw new Error(`Cannot read file: ${path}`);
  }
}

// Directory listing cache (30s TTL)
const dirCache = new Map<string, { files: string[]; ts: number }>();
export function cachedReaddirSync(dir: string): string[] {
  const cached = dirCache.get(dir);
  if (cached && Date.now() - cached.ts < 30_000) return cached.files;
  const files = readdirSync(dir);
  dirCache.set(dir, { files, ts: Date.now() });
  return files;
}

export function normalizePersistentSystemContextKey(content: string): string {
  return content.trim().replace(/\s+/g, ' ');
}

export const logger = createLogger('AgentLoop');
export const MAX_SYSTEM_PROMPT_TOKENS = 4000;
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
}

// Re-export types for backward compatibility
export type { AgentLoopConfig };


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
}

// ----------------------------------------------------------------------------
// Agent Loop
// ----------------------------------------------------------------------------

/**
 * Agent Loop - AI Agent 的核心执行循环
 *
 * 实现 ReAct 模式的推理-行动循环：
 * 1. 调用模型进行推理（inference）
 * 2. 解析响应（文本或工具调用）
 * 3. 执行工具（带权限检查）
 * 4. 将结果反馈给模型
 * 5. 重复直到完成或达到最大迭代次数
 */

export class ContextAssembly {
  runFinalizer!: RunFinalizer;

  constructor(protected ctx: RuntimeContext) {}

  setModules(runFinalizer: RunFinalizer): void {
    this.runFinalizer = runFinalizer;
  }

  // Convenience: emit event through context
  protected onEvent(event: AgentEvent): void {
    this.ctx.onEvent(event);
  }

  recordTokenUsage(inputTokens: number, outputTokens: number): void {
    const budgetService = getBudgetService();
    budgetService.recordUsage({
      inputTokens,
      outputTokens,
      model: this.ctx.modelConfig.model,
      provider: this.ctx.modelConfig.provider,
      timestamp: Date.now(),
    });
  }

  private makeCtx(): ContextAssemblyCtx {
    return {
      runtime: this.ctx,
      runFinalizer: this.runFinalizer,
      recordTokenUsage: this.recordTokenUsage.bind(this),
      inference: this.inference.bind(this),
      buildModelMessages: this.buildModelMessages.bind(this),
      buildContextTranscriptEntries: this.buildContextTranscriptEntries.bind(this),
      mapInterventionsToTranscriptEntries: this.mapInterventionsToTranscriptEntries.bind(this),
      summarizeCollapsedContext: this.summarizeCollapsedContext.bind(this),
      loadResearchSkillPrompt: this.loadResearchSkillPrompt.bind(this),
      injectSystemMessage: this.injectSystemMessage.bind(this),
      flushHookMessageBuffer: this.flushHookMessageBuffer.bind(this),
      pushPersistentSystemContext: this.pushPersistentSystemContext.bind(this),
      getBudgetedPersistentSystemContext: this.getBudgetedPersistentSystemContext.bind(this),
      trimPersistentSystemContext: this.trimPersistentSystemContext.bind(this),
      truncatePersistentSystemContext: this.truncatePersistentSystemContext.bind(this),
      inferBufferedSystemMessageCategory: this.inferBufferedSystemMessageCategory.bind(this),
      generateId: this.generateId.bind(this),
      recordContextEventsForMessage: this.recordContextEventsForMessage.bind(this),
      buildContextEventsForMessage: this.buildContextEventsForMessage.bind(this),
      checkAndAutoCompress: this.checkAndAutoCompress.bind(this),
      shouldThink: this.shouldThink.bind(this),
      generateThinkingPrompt: this.generateThinkingPrompt.bind(this),
    };
  }

  async inference(): Promise<ModelResponse> {
    return inferenceImpl(this.makeCtx());
  }

  async buildModelMessages(): Promise<ModelMessage[]> {
    return buildModelMessagesImpl(this.makeCtx());
  }

  private buildContextTranscriptEntries(messages: Message[]): ContextTranscriptEntry[] {
    return buildContextTranscriptEntriesImpl(this.makeCtx(), messages);
  }

  private mapInterventionsToTranscriptEntries(
    interventions: ContextInterventionSnapshot,
    entries: ContextTranscriptEntry[],
  ): ContextInterventionSnapshot {
    return mapInterventionsToTranscriptEntriesImpl(this.makeCtx(), interventions, entries);
  }

  private summarizeCollapsedContext(
    messages: Array<{ role: string; content: string }>,
  ): Promise<string> {
    return summarizeCollapsedContextImpl(this.makeCtx(), messages);
  }

  stripInternalFormatMimicry(content: string): string {
    return stripInternalFormatMimicryImpl(this.makeCtx(), content);
  }

  _detectTaskPatterns(userMessage: string): string[] {
    return detectTaskPatternsImpl(this.makeCtx(), userMessage);
  }

  loadResearchSkillPrompt(): string | null {
    return loadResearchSkillPromptImpl(this.makeCtx());
  }

  injectResearchModePrompt(userMessage: string): void {
    return injectResearchModePromptImpl(this.makeCtx(), userMessage);
  }

  buildPlanContextMessage(): Promise<string | null> {
    return buildPlanContextMessageImpl(this.makeCtx());
  }

  injectSystemMessage(content: string, category?: string): void {
    return injectSystemMessageImpl(this.makeCtx(), content, category);
  }

  flushHookMessageBuffer(): void {
    return flushHookMessageBufferImpl(this.makeCtx());
  }

  pushPersistentSystemContext(content: string): void {
    return pushPersistentSystemContextImpl(this.makeCtx(), content);
  }

  private getBudgetedPersistentSystemContext(): string[] {
    return getBudgetedPersistentSystemContextImpl(this.makeCtx());
  }

  private trimPersistentSystemContext(): void {
    return trimPersistentSystemContextImpl(this.makeCtx());
  }

  private truncatePersistentSystemContext(content: string, maxTokens: number): string {
    return truncatePersistentSystemContextImpl(this.makeCtx(), content, maxTokens);
  }

  private inferBufferedSystemMessageCategory(content: string): string | undefined {
    return inferBufferedSystemMessageCategoryImpl(this.makeCtx(), content);
  }

  generateId(): string {
    return generateMessageId();
  }

  getCurrentAttachments(): CurrentAttachment[] {
    return getCurrentAttachmentsImpl(this.makeCtx());
  }

  async addAndPersistMessage(message: Message): Promise<void> {
    return addAndPersistMessageImpl(this.makeCtx(), message);
  }

  private recordContextEventsForMessage(message: Message): void {
    return recordContextEventsForMessageImpl(this.makeCtx(), message);
  }

  private buildContextEventsForMessage(message: Message): ContextEventRecord[] {
    return buildContextEventsForMessageImpl(this.makeCtx(), message);
  }

  updateContextHealth(): void {
    return updateContextHealthImpl(this.makeCtx());
  }

  async checkAndAutoCompress(): Promise<void> {
    return checkAndAutoCompressImpl(this.makeCtx());
  }

  shouldThink(hasErrors: boolean): boolean {
    return shouldThinkImpl(this.makeCtx(), hasErrors);
  }

  generateThinkingPrompt(toolCalls: ToolCall[], toolResults: ToolResult[]): string {
    return generateThinkingPromptImpl(this.makeCtx(), toolCalls, toolResults);
  }

  async maybeInjectThinking(toolCalls: ToolCall[], toolResults: ToolResult[]): Promise<void> {
    return maybeInjectThinkingImpl(this.makeCtx(), toolCalls, toolResults);
  }
}
