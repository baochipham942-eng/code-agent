// ============================================================================
// Langfuse Service - AI observability and tracing
// https://langfuse.com
// ============================================================================

import { Langfuse, LangfuseTraceClient, LangfuseSpanClient, LangfuseGenerationClient } from 'langfuse';
import { createLogger } from './logger';
import type { Disposable } from '../serviceRegistry';
import { getServiceRegistry } from '../serviceRegistry';
import { redactSecrets } from '../../security/secretRedaction';
import { getActiveRunTraceContext } from '../../telemetry/runTraceContext';

const logger = createLogger('Langfuse');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  baseUrl?: string; // 默认 https://cloud.langfuse.com, 可自托管
  enabled?: boolean;
}

export interface TraceMetadata {
  sessionId: string;
  userId?: string;
  modelProvider: string;
  modelName: string;
  workingDirectory?: string;
  // 版本指纹：让云端 trace 能按版本归因（哪版构建/提示词/工具集）
  agentVersion?: string;
  promptVersion?: string;
  toolSchemaVersion?: string;
  runId?: string;
  attempt?: number;
  ownerEpoch?: number;
}

export interface LlmCallInput {
  model: string;
  modelParameters?: Record<string, unknown>;
  input: unknown;
  output?: unknown;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  startTime?: Date;
  endTime?: Date;
  statusMessage?: string;
  level?: 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR';
}

export interface SpanInput {
  name: string;
  input?: unknown;
  output?: unknown;
  startTime?: Date;
  endTime?: Date;
  level?: 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR';
  statusMessage?: string;
  metadata?: Record<string, unknown>;
}

// ----------------------------------------------------------------------------
// Langfuse Service
// ----------------------------------------------------------------------------

export class LangfuseService implements Disposable {
  private client: Langfuse | null = null;
  private enabled: boolean = false;
  private disposed = false;
  private activeTraces: Map<string, LangfuseTraceClient> = new Map();
  private activeSpans: Map<string, LangfuseSpanClient> = new Map();
  private activeLlmCalls: Map<string, LangfuseGenerationClient> = new Map();

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  /**
   * 初始化 Langfuse 客户端
   */
  init(config: LangfuseConfig): void {
    if (!config.publicKey || !config.secretKey) {
      logger.info(' Missing API keys, tracing disabled');
      this.enabled = false;
      return;
    }

    try {
      this.client = new Langfuse({
        publicKey: config.publicKey,
        secretKey: config.secretKey,
        baseUrl: config.baseUrl || 'https://cloud.langfuse.com',
        flushAt: 5, // 每 5 个事件刷新一次
        flushInterval: 3000, // 或每 3 秒
      });

      this.enabled = config.enabled !== false;
      logger.debug(` Initialized, enabled: ${this.enabled}`);
    } catch (error) {
      logger.error(' Failed to initialize:', error);
      this.enabled = false;
    }
  }

  /**
   * 检查是否启用
   */
  isEnabled(): boolean {
    return this.enabled && this.client !== null;
  }

  /**
   * 关闭客户端，确保所有数据发送完成
   */
  async shutdown(): Promise<void> {
    if (this.client) {
      await this.client.shutdownAsync();
      logger.info(' Shutdown complete');
    }
  }

  /**
   * 手动刷新
   */
  async flush(): Promise<void> {
    if (this.client) {
      await this.client.flushAsync();
    }
  }

  // --------------------------------------------------------------------------
  /**
   * Disposable implementation for ServiceRegistry
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.cleanupAll();
      await this.shutdown();
    } catch (error) {
      logger.error(' Failed to dispose:', error);
    }
  }

  // --------------------------------------------------------------------------
  // Trace Management (对应一次用户请求)
  // --------------------------------------------------------------------------

  /**
   * 开始一个新的 Trace
   * @param traceId 唯一 ID (通常用 sessionId + timestamp)
   * @param metadata 元数据
   * @param userMessage 用户输入
   */
  startTrace(traceId: string, metadata: TraceMetadata, userMessage: string): void {
    if (!this.isEnabled()) return;

    try {
      const activeRunTrace = getActiveRunTraceContext();
      const effectiveTraceId = activeRunTrace?.traceId ?? traceId;
      const trace = this.client!.trace({
        id: effectiveTraceId,
        name: 'Agent Run',
        sessionId: metadata.sessionId,
        userId: metadata.userId,
        input: userMessage ? { length: userMessage.length, redacted: true } : undefined,
        metadata: {
          modelProvider: metadata.modelProvider,
          modelName: metadata.modelName,
          workingDirectory: activeRunTrace ? undefined : metadata.workingDirectory,
          agentVersion: metadata.agentVersion,
          promptVersion: metadata.promptVersion,
          toolSchemaVersion: metadata.toolSchemaVersion,
          runId: metadata.runId,
          attempt: metadata.attempt,
          ownerEpoch: metadata.ownerEpoch,
          processInstanceId: activeRunTrace?.processInstanceId,
          workspaceFingerprint: activeRunTrace?.workspaceFingerprint,
        },
        tags: [metadata.modelProvider],
      });

      this.activeTraces.set(effectiveTraceId, trace);
      logger.debug(` Trace started: ${effectiveTraceId}`);
    } catch (error) {
      logger.error(' Failed to start trace:', error);
    }
  }

  /**
   * 结束 Trace
   */
  endTrace(traceId: string, output?: string, _level?: 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR'): void {
    if (!this.isEnabled()) return;

    const trace = this.activeTraces.get(traceId);
    if (trace) {
      try {
        // Note: level is not directly supported on trace.update()
        trace.update({
          output: this.toSafeObservation(output),
        });
        this.activeTraces.delete(traceId);
        logger.debug(` Trace ended: ${traceId}`);
      } catch (error) {
        logger.error(' Failed to end trace:', error);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Span Management (对应 Agent Loop 迭代 / 工具调用)
  // --------------------------------------------------------------------------

  /**
   * 开始一个 Span (在 Trace 下)
   */
  startSpan(traceId: string, spanId: string, input: SpanInput): void {
    if (!this.isEnabled()) return;

    const trace = this.activeTraces.get(traceId);
    if (!trace) {
      logger.warn(` No active trace for span: ${traceId}`);
      return;
    }

    try {
      // Convert metadata to Langfuse-compatible format
      const langfuseMetadata = input.metadata ? this.toJsonRecord(input.metadata) : undefined;

      const span = trace.span({
        id: spanId,
        name: input.name,
        input: this.toSafeObservation(input.input),
        startTime: input.startTime || new Date(),
        metadata: langfuseMetadata,
        level: input.level,
      });

      this.activeSpans.set(spanId, span);
      logger.debug(` Span started: ${input.name} (${spanId})`);
    } catch (error) {
      logger.error(' Failed to start span:', error);
    }
  }

  /**
   * 结束 Span
   */
  endSpan(spanId: string, output?: unknown, level?: 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR', statusMessage?: string): void {
    if (!this.isEnabled()) return;

    const span = this.activeSpans.get(spanId);
    if (span) {
      try {
        // Note: end() doesn't accept endTime or level - use update() for level first if needed
        if (level) {
          span.update({ level, statusMessage });
        }
        span.end({
          output: this.toSafeObservation(output),
          statusMessage,
        });
        this.activeSpans.delete(spanId);
        logger.debug(` Span ended: ${spanId}`);
      } catch (error) {
        logger.error(' Failed to end span:', error);
      }
    }
  }

  /**
   * 在 Span 下创建子 Span (用于工具调用等)
   */
  startNestedSpan(parentSpanId: string, spanId: string, input: SpanInput): void {
    if (!this.isEnabled()) return;

    const parentSpan = this.activeSpans.get(parentSpanId);
    if (!parentSpan) {
      logger.warn(` No active parent span: ${parentSpanId}`);
      return;
    }

    try {
      // Convert metadata to Langfuse-compatible format
      const langfuseMetadata = input.metadata ? this.toJsonRecord(input.metadata) : undefined;

      const span = parentSpan.span({
        id: spanId,
        name: input.name,
        input: this.toSafeObservation(input.input),
        startTime: input.startTime || new Date(),
        metadata: langfuseMetadata,
        level: input.level,
      });

      this.activeSpans.set(spanId, span);
      logger.debug(` Nested span started: ${input.name} (${spanId})`);
    } catch (error) {
      logger.error(' Failed to start nested span:', error);
    }
  }

  // --------------------------------------------------------------------------
  // LLM call management (Langfuse generation events)
  // --------------------------------------------------------------------------

  /**
   * 记录 LLM 调用开始
   */
  startGeneration(
    traceId: string,
    llmCallId: string,
    name: string,
    input: LlmCallInput
  ): void {
    if (!this.isEnabled()) return;

    const trace = this.activeTraces.get(traceId);
    if (!trace) {
      logger.warn(` No active trace for generation: ${traceId}`);
      return;
    }

    try {
      // Convert modelParameters to Langfuse-compatible format
      const langfuseModelParams = input.modelParameters ? this.toJsonRecord(input.modelParameters) : undefined;

      const generation = trace.generation({
        id: llmCallId,
        name,
        model: input.model,
        modelParameters: langfuseModelParams,
        input: this.toSafeObservation(input.input),
        startTime: input.startTime || new Date(),
      });

      this.activeLlmCalls.set(llmCallId, generation);
      logger.debug(` LLM call started: ${name} (${llmCallId})`);
    } catch (error) {
      logger.error(' Failed to start generation:', error);
    }
  }

  /**
   * 记录 LLM 调用结束
   */
  endGeneration(
    llmCallId: string,
    output: unknown,
    usage?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    },
    level?: 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR',
    statusMessage?: string
  ): void {
    if (!this.isEnabled()) return;

    const generation = this.activeLlmCalls.get(llmCallId);
    if (generation) {
      try {
        // Note: end() doesn't accept endTime or level - use update() for level first if needed
        if (level) {
          generation.update({ level, statusMessage });
        }
        generation.end({
          output: this.toSafeObservation(output),
          usage: usage ? {
            input: usage.promptTokens,
            output: usage.completionTokens,
            total: usage.totalTokens,
          } : undefined,
          statusMessage,
        });
        this.activeLlmCalls.delete(llmCallId);
        logger.debug(` LLM call ended: ${llmCallId}`);
      } catch (error) {
        logger.error(' Failed to end generation:', error);
      }
    }
  }

  /**
   * 在 Span 下记录 LLM 调用
   */
  startGenerationInSpan(
    spanId: string,
    llmCallId: string,
    name: string,
    input: LlmCallInput
  ): void {
    if (!this.isEnabled()) return;

    const span = this.activeSpans.get(spanId);
    if (!span) {
      logger.warn(` No active span for generation: ${spanId}`);
      return;
    }

    try {
      // Convert modelParameters to Langfuse-compatible format
      const langfuseModelParams = input.modelParameters ? this.toJsonRecord(input.modelParameters) : undefined;

      const generation = span.generation({
        id: llmCallId,
        name,
        model: input.model,
        modelParameters: langfuseModelParams,
        input: this.toSafeObservation(input.input),
        startTime: input.startTime || new Date(),
      });

      this.activeLlmCalls.set(llmCallId, generation);
      logger.debug(` LLM call in span started: ${name} (${llmCallId})`);
    } catch (error) {
      logger.error(' Failed to start generation in span:', error);
    }
  }

  // --------------------------------------------------------------------------
  // Event Logging
  // --------------------------------------------------------------------------

  /**
   * 记录事件 (用于记录重要节点但不需要 span)
   */
  logEvent(traceId: string, name: string, input?: unknown, output?: unknown, level?: 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR'): void {
    if (!this.isEnabled()) return;

    const trace = this.activeTraces.get(traceId);
    if (!trace) return;

    try {
      trace.event({
        name,
        input: this.toSafeObservation(input),
        output: this.toSafeObservation(output),
        level,
      });
    } catch (error) {
      logger.error(' Failed to log event:', error);
    }
  }

  // --------------------------------------------------------------------------
  // Score / Feedback
  // --------------------------------------------------------------------------

  /**
   * 记录评分 (用户反馈或自动评估)
   */
  score(traceId: string, name: string, value: number, comment?: string): void {
    if (!this.isEnabled()) return;

    try {
      this.client!.score({
        traceId,
        name,
        value,
        comment,
      });
      logger.debug(` Score recorded: ${name} = ${value}`);
    } catch (error) {
      logger.error(' Failed to record score:', error);
    }
  }

  // --------------------------------------------------------------------------
  // Helper Methods
  // --------------------------------------------------------------------------

  /**
   * 获取活跃 trace ID 列表
   */
  getActiveTraceIds(): string[] {
    return Array.from(this.activeTraces.keys());
  }

  /**
   * 清理所有活跃的追踪对象 (用于应用关闭前)
   */
  async cleanupAll(): Promise<void> {
    // 结束所有活跃的 LLM 调用
    for (const [_id, gen] of this.activeLlmCalls) {
      try {
        gen.update({ level: 'WARNING', statusMessage: 'Cleanup: session ended' });
        gen.end({ output: 'Cleanup: session ended' });
      } catch {
        // Ignore
      }
    }
    this.activeLlmCalls.clear();

    // 结束所有活跃的 spans
    for (const [_id, span] of this.activeSpans) {
      try {
        span.update({ level: 'WARNING', statusMessage: 'Cleanup: session ended' });
        span.end({ output: 'Cleanup: session ended' });
      } catch {
        // Ignore
      }
    }
    this.activeSpans.clear();

    // 结束所有活跃的 traces
    for (const [_id, trace] of this.activeTraces) {
      try {
        trace.update({ output: 'Cleanup: session ended' });
      } catch {
        // Ignore
      }
    }
    this.activeTraces.clear();

    await this.flush();
  }

  // --------------------------------------------------------------------------
  // Helper Methods
  // --------------------------------------------------------------------------

  /**
   * Convert Record<string, unknown> to Langfuse-compatible JSON record
   */
  private toJsonRecord(obj: Record<string, unknown>): { [key: string]: string | number | boolean | string[] | null } {
    const result: { [key: string]: string | number | boolean | string[] | null } = {};
    for (const [key, value] of Object.entries(obj)) {
      if (/(authorization|cookie|api[-_]?key|token|secret|credential|password)/i.test(key)) {
        result[key] = '[REDACTED]';
        continue;
      }
      if (value === null || value === undefined) {
        result[key] = null;
      } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        result[key] = typeof value === 'string' ? redactSecrets(value) : value;
      } else if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
        result[key] = (value as string[]).map((item) => redactSecrets(item));
      } else {
        result[key] = '[REDACTED_COMPLEX_VALUE]';
      }
    }
    return result;
  }

  private toSafeObservation(value: unknown): unknown {
    if (value === undefined || value === null) return value;
    if (typeof value === 'string') {
      return { type: 'string', length: value.length, redacted: true };
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return { type: 'array', length: value.length, redacted: true };
    if (typeof value !== 'object') return { type: typeof value, redacted: true };
    const allowed = new Set([
      'type', 'success', 'duration', 'durationMs', 'contentLength', 'outputLength',
      'toolCallCount', 'messageCount', 'toolCount', 'synthetic', 'model', 'provider',
    ]);
    const safe: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (allowed.has(key) && ['string', 'number', 'boolean'].includes(typeof child)) {
        safe[key] = typeof child === 'string' ? redactSecrets(child) : child;
      } else if (key === 'error' && typeof child === 'string') {
        safe.error = redactSecrets(child).slice(0, 256);
      }
    }
    return { ...safe, redacted: true };
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let langfuseService: LangfuseService | null = null;

export function getLangfuseService(): LangfuseService {
  if (!langfuseService) {
    langfuseService = new LangfuseService();
    getServiceRegistry().register('LangfuseService', langfuseService);
  }
  return langfuseService;
}

export function initLangfuse(config: LangfuseConfig): LangfuseService {
  const service = getLangfuseService();
  service.init(config);
  return service;
}
