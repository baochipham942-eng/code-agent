// ============================================================================
// Task Orchestrator - 轻量级并行判断器
// ============================================================================
// 设计：用小模型快速判断任务是否适合并行，不做具体分解
// 借鉴 KIMI K2.5 的 Critical Steps（关键路径）概念

import { createLogger } from '../services/infra/logger';

const logger = createLogger('TaskOrchestrator');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * 并行判断结果
 */
export interface ParallelJudgment {
  /** 是否建议并行执行 */
  shouldParallel: boolean;
  /** 判断理由 */
  reason: string;
  /** 关键路径长度估算（串行执行需要的步骤数） */
  criticalPathLength: number;
  /** 可并行的独立维度数 */
  parallelDimensions: number;
  /** 建议的并行维度（不是具体任务，只是方向） */
  suggestedDimensions?: string[];
  /** 预估加速比 */
  estimatedSpeedup?: number;
  /** 置信度 0-1 */
  confidence: number;
}

export interface OrchestratorConfig {
  provider: 'groq' | 'openai' | 'zhipu';
  model: string;
  apiKey?: string;
  /** 关键路径阈值：超过此值建议并行 */
  criticalPathThreshold?: number;
  /** 并行维度阈值：超过此值建议并行 */
  parallelDimensionThreshold?: number;
}

// ----------------------------------------------------------------------------
// Orchestrator Prompt - 简化版，只做判断
// ----------------------------------------------------------------------------

const PARALLEL_JUDGMENT_PROMPT = `你是一个任务分析专家。快速判断用户任务是否适合并行执行。

## 核心概念（借鉴 KIMI K2.5）

**关键路径 (Critical Path)**：如果串行执行，完成任务需要的最少步骤数。
**并行维度 (Parallel Dimensions)**：可以同时独立进行的工作方向数量。

## 判断标准

**适合并行**（shouldParallel: true）：
- 关键路径长度 >= 5（串行需要5步以上）
- 并行维度 >= 2（有2个以上独立方向）
- 任务描述包含多个独立目标（如：安全+性能+质量）
- 需要分析/修改多个不相关的模块

**不适合并行**（shouldParallel: false）：
- 关键路径长度 < 5（简单任务）
- 只有1个维度（任务聚焦单一目标）
- 步骤之间有强依赖关系
- 任务已经很具体

## 输出格式（严格JSON）

{
  "shouldParallel": true/false,
  "reason": "一句话解释",
  "criticalPathLength": 8,
  "parallelDimensions": 3,
  "suggestedDimensions": ["安全审计", "性能分析", "代码质量"],
  "estimatedSpeedup": 2.5,
  "confidence": 0.85
}

## 示例

用户: "修复登录页面的按钮样式"
{"shouldParallel":false,"reason":"单一具体任务，关键路径短","criticalPathLength":2,"parallelDimensions":1,"confidence":0.95}

用户: "对项目进行安全审计、性能优化和代码质量检查"
{"shouldParallel":true,"reason":"三个独立维度可并行","criticalPathLength":15,"parallelDimensions":3,"suggestedDimensions":["安全审计","性能优化","代码质量"],"estimatedSpeedup":2.5,"confidence":0.9}

用户: "重构用户模块，包括数据库迁移、API更新和前端适配"
{"shouldParallel":false,"reason":"步骤间有强依赖，需要串行","criticalPathLength":10,"parallelDimensions":1,"confidence":0.85}

只输出JSON，不要其他内容。`;

// ----------------------------------------------------------------------------
// Task Orchestrator Class
// ----------------------------------------------------------------------------

export class TaskOrchestrator {
  private config: OrchestratorConfig;
  private criticalPathThreshold: number;
  private parallelDimensionThreshold: number;

  constructor(config: OrchestratorConfig) {
    this.config = config;
    this.criticalPathThreshold = config.criticalPathThreshold ?? 5;
    this.parallelDimensionThreshold = config.parallelDimensionThreshold ?? 2;
  }

  /**
   * 快速判断任务是否适合并行
   */
  async judge(userMessage: string): Promise<ParallelJudgment> {
    const startTime = Date.now();
    logger.info('[TaskOrchestrator] Judging task parallelism...');

    try {
      const response = await this.callModel(userMessage);
      const judgment = this.parseResponse(response);

      const elapsed = Date.now() - startTime;
      logger.info('[TaskOrchestrator] Judgment completed', {
        shouldParallel: judgment.shouldParallel,
        criticalPath: judgment.criticalPathLength,
        dimensions: judgment.parallelDimensions,
        confidence: judgment.confidence,
        elapsedMs: elapsed,
      });

      return judgment;
    } catch (error) {
      logger.error('[TaskOrchestrator] Judgment failed', error);
      // 失败时返回保守判断：不并行
      return {
        shouldParallel: false,
        reason: `判断失败: ${error instanceof Error ? error.message : 'Unknown'}`,
        criticalPathLength: 0,
        parallelDimensions: 1,
        confidence: 0,
      };
    }
  }

  /**
   * 生成并行提示（注入到主模型）
   */
  generateParallelHint(judgment: ParallelJudgment): string {
    if (!judgment.shouldParallel || judgment.confidence < 0.7) {
      return ''; // 不建议并行或置信度低，不注入提示
    }

    const dimensions = judgment.suggestedDimensions?.length
      ? `\n可并行维度: ${judgment.suggestedDimensions.join('、')}`
      : '';

    return (
      `<parallel-hint>\n` +
      `此任务适合并行执行（置信度: ${(judgment.confidence * 100).toFixed(0)}%）\n` +
      `关键路径长度: ${judgment.criticalPathLength} 步\n` +
      `并行维度: ${judgment.parallelDimensions} 个${dimensions}\n` +
      `预估加速: ${judgment.estimatedSpeedup?.toFixed(1) || 'N/A'}x\n\n` +
      `建议: 使用 task 工具为每个独立维度派发子代理，并行处理后汇总结果。\n` +
      `</parallel-hint>`
    );
  }

  /**
   * 调用模型
   */
  private async callModel(userMessage: string): Promise<string> {
    const { provider, model, apiKey } = this.config;

    const endpoints: Record<string, string> = {
      groq: 'https://api.groq.com/openai/v1/chat/completions',
      openai: 'https://api.openai.com/v1/chat/completions',
      zhipu: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    };

    const defaultModels: Record<string, string> = {
      groq: 'llama-3.3-70b-versatile',
      openai: 'gpt-4o-mini',
      zhipu: 'glm-4-flash',
    };

    const envKeys: Record<string, string> = {
      groq: 'GROQ_API_KEY',
      openai: 'OPENAI_API_KEY',
      zhipu: 'ZHIPU_API_KEY',
    };

    const endpoint = endpoints[provider];
    const actualModel = model || defaultModels[provider];
    const key = apiKey || process.env[envKeys[provider]];

    if (!key) {
      throw new Error(`${envKeys[provider]} not configured`);
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: actualModel,
        messages: [
          { role: 'system', content: PARALLEL_JUDGMENT_PROMPT },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.1, // 低温度，更确定性的判断
        max_tokens: 500,  // 只需要简短 JSON
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`${provider} API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || '';
  }

  /**
   * 解析响应
   */
  private parseResponse(response: string): ParallelJudgment {
    // 提取 JSON
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }

    const result = JSON.parse(jsonMatch[0]);

    // 验证并设置默认值
    const judgment: ParallelJudgment = {
      shouldParallel: Boolean(result.shouldParallel),
      reason: result.reason || 'No reason provided',
      criticalPathLength: Number(result.criticalPathLength) || 0,
      parallelDimensions: Number(result.parallelDimensions) || 1,
      suggestedDimensions: result.suggestedDimensions,
      estimatedSpeedup: result.estimatedSpeedup,
      confidence: Number(result.confidence) || 0.5,
    };

    // 根据阈值校验判断结果
    if (judgment.shouldParallel) {
      // 如果小模型说应该并行，但指标不达标，降低置信度
      if (
        judgment.criticalPathLength < this.criticalPathThreshold &&
        judgment.parallelDimensions < this.parallelDimensionThreshold
      ) {
        judgment.confidence *= 0.5;
        logger.warn('[TaskOrchestrator] Lowered confidence due to threshold mismatch');
      }
    }

    return judgment;
  }
}

// ----------------------------------------------------------------------------
// Singleton & Factory
// ----------------------------------------------------------------------------

let orchestratorInstance: TaskOrchestrator | null = null;

export function getTaskOrchestrator(config?: OrchestratorConfig): TaskOrchestrator {
  if (!orchestratorInstance && config) {
    orchestratorInstance = new TaskOrchestrator(config);
  }
  if (!orchestratorInstance) {
    // 默认使用 Groq（最快）
    orchestratorInstance = new TaskOrchestrator({
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
    });
  }
  return orchestratorInstance;
}

export function resetTaskOrchestrator(): void {
  orchestratorInstance = null;
}

// ----------------------------------------------------------------------------
// 便捷函数
// ----------------------------------------------------------------------------

/**
 * 快速判断任务是否适合并行（一行调用）
 */
export async function shouldParallelize(
  userMessage: string,
  config?: OrchestratorConfig
): Promise<boolean> {
  const orchestrator = getTaskOrchestrator(config);
  const judgment = await orchestrator.judge(userMessage);
  return judgment.shouldParallel && judgment.confidence >= 0.7;
}
