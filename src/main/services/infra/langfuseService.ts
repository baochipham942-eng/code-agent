// ============================================================================
// Langfuse Service - AI observability and tracing
// https://langfuse.com
// ============================================================================

import { Langfuse, LangfuseTraceClient, LangfuseSpanClient, LangfuseGenerationClient } from 'langfuse';
import { createLogger } from './logger';

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
  generationId: string; // Gen1-Gen8
  modelProvider: string;
  modelName: string;
  workingDirectory?: string;
}

export interface GenerationInput {
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

class LangfuseService {
  private client: Langfuse | null = null;
  private enabled: boolean = false;
  private activeTraces: Map<string, LangfuseTraceClient> = new Map();
  private activeSpans: Map<string, LangfuseSpanClient> = new Map();
  private activeGenerations: Map<string, LangfuseGenerationClient> = new Map();

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
      const trace = this.client!.trace({
        id: traceId,
        name: `Agent Run - ${metadata.generationId}`,
        sessionId: metadata.sessionId,
        userId: metadata.userId,
        input: userMessage,
        metadata: {
          generationId: metadata.generationId,
          modelProvider: metadata.modelProvider,
          modelName: metadata.modelName,
          workingDirectory: metadata.workingDirectory,
        },
        tags: [metadata.generationId, metadata.modelProvider],
      });

      this.activeTraces.set(traceId, trace);
      logger.debug(` Trace started: ${traceId}`);
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
          output,
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
        input: input.input,
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
          output,
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
        input: input.input,
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
  // Generation Management (对应 LLM 调用)
  // --------------------------------------------------------------------------

  /**
   * 记录 LLM 调用开始
   */
  startGeneration(
    traceId: string,
    generationId: string,
    name: string,
    input: GenerationInput
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
        id: generationId,
        name,
        model: input.model,
        modelParameters: langfuseModelParams,
        input: input.input,
        startTime: input.startTime || new Date(),
      });

      this.activeGenerations.set(generationId, generation);
      logger.debug(` Generation started: ${name} (${generationId})`);
    } catch (error) {
      logger.error(' Failed to start generation:', error);
    }
  }

  /**
   * 记录 LLM 调用结束
   */
  endGeneration(
    generationId: string,
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

    const generation = this.activeGenerations.get(generationId);
    if (generation) {
      try {
        // Note: end() doesn't accept endTime or level - use update() for level first if needed
        if (level) {
          generation.update({ level, statusMessage });
        }
        generation.end({
          output,
          usage: usage ? {
            input: usage.promptTokens,
            output: usage.completionTokens,
            total: usage.totalTokens,
          } : undefined,
          statusMessage,
        });
        this.activeGenerations.delete(generationId);
        logger.debug(` Generation ended: ${generationId}`);
      } catch (error) {
        logger.error(' Failed to end generation:', error);
      }
    }
  }

  /**
   * 在 Span 下记录 Generation (用于迭代中的 LLM 调用)
   */
  startGenerationInSpan(
    spanId: string,
    generationId: string,
    name: string,
    input: GenerationInput
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
        id: generationId,
        name,
        model: input.model,
        modelParameters: langfuseModelParams,
        input: input.input,
        startTime: input.startTime || new Date(),
      });

      this.activeGenerations.set(generationId, generation);
      logger.debug(` Generation in span started: ${name} (${generationId})`);
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
        input,
        output,
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
    // 结束所有活跃的 generations
    for (const [_id, gen] of this.activeGenerations) {
      try {
        gen.update({ level: 'WARNING', statusMessage: 'Cleanup: session ended' });
        gen.end({ output: 'Cleanup: session ended' });
      } catch {
        // Ignore
      }
    }
    this.activeGenerations.clear();

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
      if (value === null || value === undefined) {
        result[key] = null;
      } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        result[key] = value;
      } else if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
        result[key] = value as string[];
      } else {
        // Convert complex objects to JSON string
        result[key] = JSON.stringify(value);
      }
    }
    return result;
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let langfuseService: LangfuseService | null = null;

export function getLangfuseService(): LangfuseService {
  if (!langfuseService) {
    langfuseService = new LangfuseService();
  }
  return langfuseService;
}

export function initLangfuse(config: LangfuseConfig): LangfuseService {
  const service = getLangfuseService();
  service.init(config);
  return service;
}
