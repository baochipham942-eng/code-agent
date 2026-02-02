// ============================================================================
// Degradation Strategy - 工具降级策略
// ============================================================================
// 当主要工具失败时，自动切换到替代工具
// ============================================================================

import { createLogger } from '../../services/infra/logger';
import { DetailedErrorType, type ErrorClassification } from '../../errors/errorClassifier';

const logger = createLogger('DegradationStrategy');

/**
 * 降级映射规则
 */
export interface DegradationRule {
  /** 主工具名称 */
  primaryTool: string;
  /** 替代工具名称 */
  alternativeTool: string;
  /** 触发降级的条件 */
  conditions: DetailedErrorType[];
  /** 参数转换函数 */
  transformParams?: (params: Record<string, unknown>) => Record<string, unknown>;
  /** 是否保留原始行为 */
  preserveBehavior: boolean;
  /** 降级说明 */
  description: string;
}

/**
 * 降级执行结果
 */
export interface DegradationResult {
  /** 是否执行了降级 */
  degraded: boolean;
  /** 原工具 */
  originalTool: string;
  /** 替代工具 */
  alternativeTool?: string;
  /** 转换后的参数 */
  transformedParams?: Record<string, unknown>;
  /** 原因 */
  reason: string;
}

/**
 * 预定义的降级规则
 */
export const DEGRADATION_RULES: DegradationRule[] = [
  // web_search 降级到 web_fetch
  {
    primaryTool: 'web_search',
    alternativeTool: 'web_fetch',
    conditions: [DetailedErrorType.RATE_LIMIT_API, DetailedErrorType.NETWORK_TIMEOUT],
    transformParams: (params) => ({
      url: `https://www.google.com/search?q=${encodeURIComponent(String(params.query))}`,
      prompt: `提取搜索结果中的关键信息，原始查询: ${params.query}`,
    }),
    preserveBehavior: false,
    description: '搜索 API 受限时，通过 web_fetch 获取搜索页面',
  },

  // edit_file 降级到 write_file（状态错误时）
  {
    primaryTool: 'edit_file',
    alternativeTool: 'write_file',
    conditions: [DetailedErrorType.LOGIC_STATE],
    transformParams: (params) => ({
      path: params.path,
      content: params.new_string, // 注意：需要先读取文件内容再替换
    }),
    preserveBehavior: false,
    description: '编辑文件状态不一致时，使用完整写入',
  },

  // task 降级到直接执行
  {
    primaryTool: 'task',
    alternativeTool: 'bash',
    conditions: [DetailedErrorType.RESOURCE_EXHAUSTED, DetailedErrorType.NETWORK_TIMEOUT],
    transformParams: (params) => ({
      command: `echo "任务降级执行: ${params.prompt}"`,
    }),
    preserveBehavior: false,
    description: '子代理资源不足时，降级为直接执行',
  },

  // mcp 工具降级到本地替代
  {
    primaryTool: 'mcp',
    alternativeTool: 'bash',
    conditions: [DetailedErrorType.NETWORK_CONNECTION, DetailedErrorType.NETWORK_TIMEOUT],
    preserveBehavior: false,
    description: 'MCP 服务不可用时，尝试本地命令替代',
  },

  // read_file 降级到 bash cat
  {
    primaryTool: 'read_file',
    alternativeTool: 'bash',
    conditions: [DetailedErrorType.PERMISSION_FILE],
    transformParams: (params) => ({
      command: `cat "${params.path}" 2>/dev/null || echo "文件无法访问"`,
    }),
    preserveBehavior: true,
    description: '文件读取权限问题时，尝试通过 bash 读取',
  },

  // glob 降级到 bash find
  {
    primaryTool: 'glob',
    alternativeTool: 'bash',
    conditions: [DetailedErrorType.TOOL_EXECUTION_FAILED],
    transformParams: (params) => ({
      command: `find . -name "${params.pattern}" -type f 2>/dev/null | head -50`,
    }),
    preserveBehavior: true,
    description: 'glob 工具失败时，使用 find 命令',
  },

  // grep 降级到 bash grep
  {
    primaryTool: 'grep',
    alternativeTool: 'bash',
    conditions: [DetailedErrorType.TOOL_EXECUTION_FAILED],
    transformParams: (params) => ({
      command: `grep -r "${params.pattern}" ${params.path || '.'} 2>/dev/null | head -100`,
    }),
    preserveBehavior: true,
    description: 'grep 工具失败时，使用系统 grep',
  },
];

/**
 * 降级策略管理器
 */
export class DegradationStrategy {
  private rules: Map<string, DegradationRule[]> = new Map();
  private degradationHistory: Array<{
    timestamp: number;
    tool: string;
    reason: string;
    success: boolean;
  }> = [];

  constructor(customRules?: DegradationRule[]) {
    // 初始化规则映射
    for (const rule of [...DEGRADATION_RULES, ...(customRules || [])]) {
      const existing = this.rules.get(rule.primaryTool) || [];
      existing.push(rule);
      this.rules.set(rule.primaryTool, existing);
    }
  }

  /**
   * 检查是否可以降级
   */
  canDegrade(toolName: string, classification: ErrorClassification): boolean {
    const rules = this.rules.get(toolName);
    if (!rules) return false;

    return rules.some((rule) =>
      rule.conditions.includes(classification.type)
    );
  }

  /**
   * 获取降级方案
   */
  getDegradation(
    toolName: string,
    params: Record<string, unknown>,
    classification: ErrorClassification
  ): DegradationResult {
    const rules = this.rules.get(toolName);
    if (!rules) {
      return {
        degraded: false,
        originalTool: toolName,
        reason: '没有可用的降级规则',
      };
    }

    // 找到匹配的规则
    const matchingRule = rules.find((rule) =>
      rule.conditions.includes(classification.type)
    );

    if (!matchingRule) {
      return {
        degraded: false,
        originalTool: toolName,
        reason: `错误类型 ${classification.type} 没有匹配的降级规则`,
      };
    }

    // 转换参数
    const transformedParams = matchingRule.transformParams
      ? matchingRule.transformParams(params)
      : params;

    logger.info(`降级执行: ${toolName} -> ${matchingRule.alternativeTool}`, {
      reason: matchingRule.description,
      errorType: classification.type,
    });

    return {
      degraded: true,
      originalTool: toolName,
      alternativeTool: matchingRule.alternativeTool,
      transformedParams,
      reason: matchingRule.description,
    };
  }

  /**
   * 记录降级历史
   */
  recordDegradation(
    tool: string,
    reason: string,
    success: boolean
  ): void {
    this.degradationHistory.push({
      timestamp: Date.now(),
      tool,
      reason,
      success,
    });

    // 保持历史记录在合理范围内
    if (this.degradationHistory.length > 100) {
      this.degradationHistory = this.degradationHistory.slice(-50);
    }
  }

  /**
   * 获取降级统计
   */
  getStats(): {
    total: number;
    successful: number;
    byTool: Record<string, { total: number; successful: number }>;
  } {
    const byTool: Record<string, { total: number; successful: number }> = {};

    for (const record of this.degradationHistory) {
      if (!byTool[record.tool]) {
        byTool[record.tool] = { total: 0, successful: 0 };
      }
      byTool[record.tool].total++;
      if (record.success) {
        byTool[record.tool].successful++;
      }
    }

    const total = this.degradationHistory.length;
    const successful = this.degradationHistory.filter((r) => r.success).length;

    return { total, successful, byTool };
  }

  /**
   * 添加自定义降级规则
   */
  addRule(rule: DegradationRule): void {
    const existing = this.rules.get(rule.primaryTool) || [];
    existing.push(rule);
    this.rules.set(rule.primaryTool, existing);
  }

  /**
   * 获取工具的所有降级选项
   */
  getDegradationOptions(toolName: string): DegradationRule[] {
    return this.rules.get(toolName) || [];
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let strategyInstance: DegradationStrategy | null = null;

export function getDegradationStrategy(): DegradationStrategy {
  if (!strategyInstance) {
    strategyInstance = new DegradationStrategy();
  }
  return strategyInstance;
}

export function createDegradationStrategy(
  customRules?: DegradationRule[]
): DegradationStrategy {
  return new DegradationStrategy(customRules);
}
