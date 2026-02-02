// ============================================================================
// Decomposition Strategy - 任务分解策略
// ============================================================================
// 将大任务分解为小任务，处理超时或资源限制的情况
// ============================================================================

import { createLogger } from '../../services/infra/logger';
import { DetailedErrorType, type ErrorClassification } from '../../errors/errorClassifier';

const logger = createLogger('DecompositionStrategy');

/**
 * 分解规则
 */
export interface DecompositionRule {
  /** 工具名称 */
  toolName: string;
  /** 触发条件 */
  conditions: DetailedErrorType[];
  /** 分解函数 */
  decompose: (params: Record<string, unknown>) => DecomposedTask[];
  /** 最大分解数 */
  maxChunks: number;
  /** 描述 */
  description: string;
}

/**
 * 分解后的子任务
 */
export interface DecomposedTask {
  /** 子任务 ID */
  id: string;
  /** 工具名称 */
  toolName: string;
  /** 参数 */
  params: Record<string, unknown>;
  /** 顺序（用于依赖排序） */
  order: number;
  /** 是否可并行 */
  canParallel: boolean;
  /** 描述 */
  description: string;
}

/**
 * 分解结果
 */
export interface DecompositionResult {
  /** 是否进行了分解 */
  decomposed: boolean;
  /** 原任务 */
  originalTask: {
    toolName: string;
    params: Record<string, unknown>;
  };
  /** 分解后的子任务 */
  subtasks: DecomposedTask[];
  /** 原因 */
  reason: string;
  /** 预计节省的资源 */
  estimatedSavings?: string;
}

/**
 * 文件内容分块
 */
function chunkContent(content: string, maxChunkSize: number): string[] {
  const chunks: string[] = [];
  const lines = content.split('\n');
  let currentChunk: string[] = [];
  let currentSize = 0;

  for (const line of lines) {
    if (currentSize + line.length > maxChunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.join('\n'));
      currentChunk = [];
      currentSize = 0;
    }
    currentChunk.push(line);
    currentSize += line.length + 1;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join('\n'));
  }

  return chunks;
}

/**
 * 预定义的分解规则
 */
export const DECOMPOSITION_RULES: DecompositionRule[] = [
  // 大文件写入分解
  {
    toolName: 'write_file',
    conditions: [DetailedErrorType.NETWORK_TIMEOUT, DetailedErrorType.RESOURCE_EXHAUSTED],
    decompose: (params) => {
      const content = String(params.content || '');
      const maxChunkSize = 50000; // 50KB per chunk
      const chunks = chunkContent(content, maxChunkSize);

      if (chunks.length <= 1) {
        return [{
          id: 'write_single',
          toolName: 'write_file',
          params,
          order: 0,
          canParallel: false,
          description: '单次写入',
        }];
      }

      return chunks.map((chunk, index) => ({
        id: `write_chunk_${index}`,
        toolName: index === 0 ? 'write_file' : 'bash',
        params: index === 0
          ? { ...params, content: chunk }
          : { command: `cat >> "${params.path}" << 'EOF'\n${chunk}\nEOF` },
        order: index,
        canParallel: false,
        description: `写入块 ${index + 1}/${chunks.length}`,
      }));
    },
    maxChunks: 10,
    description: '大文件分块写入',
  },

  // 大范围编辑分解
  {
    toolName: 'edit_file',
    conditions: [DetailedErrorType.LOGIC_STATE, DetailedErrorType.TOOL_EXECUTION_FAILED],
    decompose: (params) => {
      // 如果编辑范围太大，分解为读取-修改-写入
      return [
        {
          id: 'edit_read',
          toolName: 'read_file',
          params: { path: params.path },
          order: 0,
          canParallel: false,
          description: '读取原文件',
        },
        {
          id: 'edit_write',
          toolName: 'write_file',
          params: {
            path: params.path,
            // 实际内容需要在执行时根据读取结果生成
            content: '__PLACEHOLDER__',
          },
          order: 1,
          canParallel: false,
          description: '写入修改后的文件',
        },
      ];
    },
    maxChunks: 2,
    description: '编辑操作分解为读取和写入',
  },

  // 批量文件搜索分解
  {
    toolName: 'grep',
    conditions: [DetailedErrorType.NETWORK_TIMEOUT, DetailedErrorType.RESOURCE_EXHAUSTED],
    decompose: (params) => {
      const path = String(params.path || '.');
      // 分解为多个子目录搜索
      const commonDirs = ['src', 'lib', 'test', 'docs', 'config'];

      return commonDirs.map((dir, index) => ({
        id: `grep_${dir}`,
        toolName: 'grep',
        params: { ...params, path: `${path}/${dir}` },
        order: index,
        canParallel: true,
        description: `搜索 ${dir} 目录`,
      }));
    },
    maxChunks: 5,
    description: '大范围搜索分解为子目录搜索',
  },

  // task 超时分解
  {
    toolName: 'task',
    conditions: [DetailedErrorType.NETWORK_TIMEOUT, DetailedErrorType.RESOURCE_EXHAUSTED],
    decompose: (params) => {
      const prompt = String(params.prompt || '');
      // 尝试将复杂任务分解
      const steps = prompt.split(/\d+\.\s+/).filter(Boolean);

      if (steps.length <= 1) {
        return [{
          id: 'task_single',
          toolName: 'task',
          params: { ...params, maxTurns: 5 }, // 减少迭代次数
          order: 0,
          canParallel: false,
          description: '简化执行',
        }];
      }

      return steps.map((step, index) => ({
        id: `task_step_${index}`,
        toolName: 'task',
        params: {
          ...params,
          prompt: step.trim(),
          maxTurns: 3,
        },
        order: index,
        canParallel: false,
        description: `步骤 ${index + 1}: ${step.slice(0, 50)}...`,
      }));
    },
    maxChunks: 5,
    description: '复杂任务分解为步骤',
  },
];

/**
 * 分解策略管理器
 */
export class DecompositionStrategy {
  private rules: Map<string, DecompositionRule> = new Map();
  private decompositionHistory: Array<{
    timestamp: number;
    tool: string;
    originalSize: number;
    chunks: number;
    success: boolean;
  }> = [];

  constructor(customRules?: DecompositionRule[]) {
    for (const rule of [...DECOMPOSITION_RULES, ...(customRules || [])]) {
      this.rules.set(rule.toolName, rule);
    }
  }

  /**
   * 检查是否可以分解
   */
  canDecompose(toolName: string, classification: ErrorClassification): boolean {
    const rule = this.rules.get(toolName);
    if (!rule) return false;

    return rule.conditions.includes(classification.type);
  }

  /**
   * 执行分解
   */
  decompose(
    toolName: string,
    params: Record<string, unknown>,
    classification: ErrorClassification
  ): DecompositionResult {
    const rule = this.rules.get(toolName);

    if (!rule || !rule.conditions.includes(classification.type)) {
      return {
        decomposed: false,
        originalTask: { toolName, params },
        subtasks: [],
        reason: '没有匹配的分解规则',
      };
    }

    try {
      const subtasks = rule.decompose(params);

      // 限制最大分解数
      const limitedSubtasks = subtasks.slice(0, rule.maxChunks);

      logger.info(`任务分解: ${toolName} -> ${limitedSubtasks.length} 个子任务`, {
        rule: rule.description,
        errorType: classification.type,
      });

      return {
        decomposed: true,
        originalTask: { toolName, params },
        subtasks: limitedSubtasks,
        reason: rule.description,
        estimatedSavings: `分解为 ${limitedSubtasks.length} 个小任务`,
      };
    } catch (error) {
      logger.error('任务分解失败:', error);
      return {
        decomposed: false,
        originalTask: { toolName, params },
        subtasks: [],
        reason: `分解失败: ${error instanceof Error ? error.message : '未知错误'}`,
      };
    }
  }

  /**
   * 记录分解历史
   */
  recordDecomposition(
    tool: string,
    originalSize: number,
    chunks: number,
    success: boolean
  ): void {
    this.decompositionHistory.push({
      timestamp: Date.now(),
      tool,
      originalSize,
      chunks,
      success,
    });

    if (this.decompositionHistory.length > 100) {
      this.decompositionHistory = this.decompositionHistory.slice(-50);
    }
  }

  /**
   * 获取分解统计
   */
  getStats(): {
    total: number;
    successful: number;
    avgChunks: number;
    byTool: Record<string, { total: number; successful: number }>;
  } {
    const byTool: Record<string, { total: number; successful: number }> = {};
    let totalChunks = 0;

    for (const record of this.decompositionHistory) {
      if (!byTool[record.tool]) {
        byTool[record.tool] = { total: 0, successful: 0 };
      }
      byTool[record.tool].total++;
      if (record.success) {
        byTool[record.tool].successful++;
      }
      totalChunks += record.chunks;
    }

    const total = this.decompositionHistory.length;
    const successful = this.decompositionHistory.filter((r) => r.success).length;
    const avgChunks = total > 0 ? totalChunks / total : 0;

    return { total, successful, avgChunks, byTool };
  }

  /**
   * 添加自定义分解规则
   */
  addRule(rule: DecompositionRule): void {
    this.rules.set(rule.toolName, rule);
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let strategyInstance: DecompositionStrategy | null = null;

export function getDecompositionStrategy(): DecompositionStrategy {
  if (!strategyInstance) {
    strategyInstance = new DecompositionStrategy();
  }
  return strategyInstance;
}

export function createDecompositionStrategy(
  customRules?: DecompositionRule[]
): DecompositionStrategy {
  return new DecompositionStrategy(customRules);
}
