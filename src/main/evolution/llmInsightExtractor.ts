// ============================================================================
// LLM Insight Extractor - LLM 驱动的洞察提取器
// Gen 8: Self-Evolution - 从成功案例智能学习
// ============================================================================

import { ModelRouter } from '../model/modelRouter';
import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';
import type { ExecutionTrace, ToolCallWithResult } from './traceRecorder';

const logger = createLogger('LLMInsightExtractor');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type InsightType = 'strategy' | 'tool_sequence' | 'workflow' | 'knowledge' | 'skill';

export interface InsightCandidate {
  type: InsightType;
  name: string;
  content: string | object;
  sourceTraces: string[];
  confidence: number;
  suggestedLayer: number;  // 建议注入层级 (3=高置信度, 4=低置信度, 5=实验性)
  reasoning?: string;
  risks?: string[];
}

export interface Insight {
  id: string;
  type: InsightType;
  name: string;
  content: string;
  sourceTraces: string[];
  confidence: number;
  validationStatus: 'pending' | 'validated' | 'rejected';
  usageCount: number;
  successRate: number;
  injectionLayer: number;
  decayFactor: number;
  lastUsed?: number;
  projectPath?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TraceCluster {
  taskType: string;
  traces: ExecutionTrace[];
  commonTools: string[];
  successRate: number;
}

export interface ToolPattern {
  sequence: string[];
  occurrences: number;
  successRate: number;
  avgDuration: number;
}

export interface InferredPreference {
  key: string;
  value: string;
  confidence: number;
  source: string;
}

// 数据库行类型
type SQLiteRow = Record<string, unknown>;

// ----------------------------------------------------------------------------
// LLM Insight Extractor Service
// ----------------------------------------------------------------------------

export class LLMInsightExtractor {
  private modelRouter: ModelRouter | null = null;

  constructor(modelRouter?: ModelRouter) {
    this.modelRouter = modelRouter || null;
  }

  /**
   * 设置模型路由器（延迟初始化）
   */
  setModelRouter(router: ModelRouter): void {
    this.modelRouter = router;
  }

  /**
   * 从成功轨迹提取洞察
   */
  async extractFromSuccessfulTraces(traces: ExecutionTrace[]): Promise<InsightCandidate[]> {
    if (traces.length === 0) {
      return [];
    }

    const insights: InsightCandidate[] = [];

    // 1. 聚类分析
    const clusters = await this.clusterByTaskType(traces);

    // 2. 从每个聚类提取策略
    for (const cluster of clusters) {
      if (cluster.traces.length >= 2) {
        const strategy = await this.generateStrategy(cluster);
        if (strategy) {
          insights.push(strategy);
        }
      }
    }

    // 3. 挖掘工具序列模式
    const toolPatterns = this.mineToolSequencePatterns(traces);
    for (const pattern of toolPatterns) {
      if (pattern.occurrences >= 2 && pattern.successRate >= 0.8) {
        insights.push({
          type: 'tool_sequence',
          name: `工具序列: ${pattern.sequence.slice(0, 3).join(' → ')}...`,
          content: {
            sequence: pattern.sequence,
            avgDuration: pattern.avgDuration,
          },
          sourceTraces: traces.slice(0, 5).map(t => t.id),
          confidence: Math.min(0.5 + pattern.occurrences * 0.1, 0.9),
          suggestedLayer: pattern.successRate >= 0.9 ? 3 : 4,
        });
      }
    }

    // 4. 对于单个高质量轨迹，尝试生成 Skill
    for (const trace of traces) {
      if (trace.outcomeConfidence && trace.outcomeConfidence >= 0.9) {
        const skill = await this.generateSkill(trace);
        if (skill) {
          insights.push(skill);
        }
      }
    }

    logger.info('[LLMInsightExtractor] Extracted insights', {
      traceCount: traces.length,
      insightCount: insights.length,
    });

    return insights;
  }

  /**
   * 任务类型聚类
   */
  private async clusterByTaskType(traces: ExecutionTrace[]): Promise<TraceCluster[]> {
    // 简单的关键词聚类（未来可以用 LLM 改进）
    const clusters = new Map<string, TraceCluster>();

    for (const trace of traces) {
      const taskType = this.inferTaskType(trace.taskDescription);
      const tools = [...new Set(trace.toolCalls.map(tc => tc.name))];

      if (!clusters.has(taskType)) {
        clusters.set(taskType, {
          taskType,
          traces: [],
          commonTools: [],
          successRate: 0,
        });
      }

      const cluster = clusters.get(taskType)!;
      cluster.traces.push(trace);

      // 更新常用工具
      for (const tool of tools) {
        if (!cluster.commonTools.includes(tool)) {
          cluster.commonTools.push(tool);
        }
      }
    }

    // 计算成功率
    for (const cluster of clusters.values()) {
      const successCount = cluster.traces.filter(t => t.outcome === 'success').length;
      cluster.successRate = successCount / cluster.traces.length;
    }

    return Array.from(clusters.values());
  }

  /**
   * 推断任务类型
   */
  private inferTaskType(description: string): string {
    const lowerDesc = description.toLowerCase();

    // 简单的关键词匹配
    if (lowerDesc.includes('fix') || lowerDesc.includes('bug') || lowerDesc.includes('修复')) {
      return 'bug_fix';
    }
    if (lowerDesc.includes('add') || lowerDesc.includes('implement') || lowerDesc.includes('添加') || lowerDesc.includes('实现')) {
      return 'feature_add';
    }
    if (lowerDesc.includes('refactor') || lowerDesc.includes('重构')) {
      return 'refactoring';
    }
    if (lowerDesc.includes('test') || lowerDesc.includes('测试')) {
      return 'testing';
    }
    if (lowerDesc.includes('doc') || lowerDesc.includes('文档')) {
      return 'documentation';
    }
    if (lowerDesc.includes('search') || lowerDesc.includes('find') || lowerDesc.includes('查找')) {
      return 'code_search';
    }

    return 'general';
  }

  /**
   * 工具序列模式挖掘
   */
  private mineToolSequencePatterns(traces: ExecutionTrace[]): ToolPattern[] {
    const sequenceCounts = new Map<string, { count: number; successCount: number; durations: number[] }>();

    for (const trace of traces) {
      const sequence = trace.toolCalls.map(tc => tc.name);
      if (sequence.length < 2) continue;

      // 提取所有长度为 2-5 的子序列
      for (let len = 2; len <= Math.min(5, sequence.length); len++) {
        for (let i = 0; i <= sequence.length - len; i++) {
          const subseq = sequence.slice(i, i + len);
          const key = subseq.join('|');

          if (!sequenceCounts.has(key)) {
            sequenceCounts.set(key, { count: 0, successCount: 0, durations: [] });
          }

          const stats = sequenceCounts.get(key)!;
          stats.count++;
          if (trace.outcome === 'success') {
            stats.successCount++;
          }

          // 计算子序列的总耗时
          const subDuration = trace.toolCalls
            .slice(i, i + len)
            .reduce((sum, tc) => sum + tc.durationMs, 0);
          stats.durations.push(subDuration);
        }
      }
    }

    // 转换为 ToolPattern 并过滤
    const patterns: ToolPattern[] = [];
    for (const [key, stats] of sequenceCounts) {
      if (stats.count >= 2) {
        const avgDuration = stats.durations.reduce((a, b) => a + b, 0) / stats.durations.length;
        patterns.push({
          sequence: key.split('|'),
          occurrences: stats.count,
          successRate: stats.successCount / stats.count,
          avgDuration,
        });
      }
    }

    // 按出现次数排序
    return patterns.sort((a, b) => b.occurrences - a.occurrences);
  }

  /**
   * 生成 Strategy（使用 LLM）
   */
  private async generateStrategy(cluster: TraceCluster): Promise<InsightCandidate | null> {
    if (!this.modelRouter) {
      // 无 LLM 时使用规则生成
      return this.generateStrategyWithoutLLM(cluster);
    }

    try {
      const prompt = this.buildStrategyPrompt(cluster);
      const response = await this.modelRouter.chat({
        provider: 'deepseek',
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 1000,
      });

      // 解析 LLM 响应
      const content = response.content || '';
      const parsed = this.parseStrategyResponse(content);

      if (!parsed) {
        return this.generateStrategyWithoutLLM(cluster);
      }

      return {
        type: 'strategy',
        name: parsed.name || `${cluster.taskType} 策略`,
        content: parsed.content,
        sourceTraces: cluster.traces.map(t => t.id),
        confidence: parsed.confidence || 0.7,
        suggestedLayer: parsed.confidence >= 0.8 ? 3 : 4,
        reasoning: parsed.reasoning,
        risks: parsed.risks,
      };
    } catch (error) {
      logger.error('[LLMInsightExtractor] Failed to generate strategy with LLM:', error);
      return this.generateStrategyWithoutLLM(cluster);
    }
  }

  /**
   * 构建策略提取 Prompt
   */
  private buildStrategyPrompt(cluster: TraceCluster): string {
    const traceDescriptions = cluster.traces
      .slice(0, 5)
      .map((t, i) => {
        const toolSummary = t.toolCalls
          .slice(0, 10)
          .map(tc => `${tc.name}${tc.result.success ? '✓' : '✗'}`)
          .join(' → ');
        return `${i + 1}. 任务: "${t.taskDescription.substring(0, 100)}"
   工具链: ${toolSummary}
   结果: ${t.outcome}`;
      })
      .join('\n');

    return `分析以下成功的任务执行案例，提取可复用的策略。

## 任务类型: ${cluster.taskType}
## 常用工具: ${cluster.commonTools.join(', ')}
## 成功率: ${(cluster.successRate * 100).toFixed(0)}%

## 执行案例:
${traceDescriptions}

请以 JSON 格式输出策略，包含以下字段:
{
  "name": "策略名称（简短）",
  "content": "策略内容（详细描述何时使用、如何执行）",
  "confidence": 0.0-1.0 的置信度,
  "reasoning": "为什么这个策略有效",
  "risks": ["可能的风险或限制"]
}

只输出 JSON，不要其他内容。`;
  }

  /**
   * 解析策略响应
   */
  private parseStrategyResponse(content: string): {
    name: string;
    content: string;
    confidence: number;
    reasoning?: string;
    risks?: string[];
  } | null {
    try {
      // 提取 JSON
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.name || !parsed.content) return null;

      return {
        name: parsed.name,
        content: parsed.content,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.7,
        reasoning: parsed.reasoning,
        risks: Array.isArray(parsed.risks) ? parsed.risks : undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * 无 LLM 时的策略生成
   */
  private generateStrategyWithoutLLM(cluster: TraceCluster): InsightCandidate {
    const toolSequence = cluster.commonTools.slice(0, 5).join(' → ');

    return {
      type: 'strategy',
      name: `${cluster.taskType} 策略`,
      content: `对于 ${cluster.taskType} 类型的任务，推荐使用以下工具序列: ${toolSequence}。
这个模式在 ${cluster.traces.length} 次执行中成功率为 ${(cluster.successRate * 100).toFixed(0)}%。`,
      sourceTraces: cluster.traces.map(t => t.id),
      confidence: cluster.successRate * 0.8,
      suggestedLayer: cluster.successRate >= 0.9 ? 3 : 4,
    };
  }

  /**
   * 生成 Skill（SKILL.md 格式）
   */
  private async generateSkill(trace: ExecutionTrace): Promise<InsightCandidate | null> {
    // 只为复杂任务生成 Skill
    if (trace.toolCalls.length < 3) {
      return null;
    }

    const taskType = this.inferTaskType(trace.taskDescription);
    const toolSequence = trace.toolCalls.map(tc => tc.name);

    // 生成 SKILL.md 格式内容
    const skillContent = `---
name: auto_${taskType}_${Date.now()}
description: 自动学习的 ${taskType} 技能
allowed_tools:
${toolSequence.map(t => `  - ${t}`).join('\n')}
---

# ${taskType} 技能

## 触发条件
当用户请求类似以下内容时触发:
- ${trace.taskDescription.substring(0, 100)}

## 执行步骤
${toolSequence.map((t, i) => `${i + 1}. 使用 \`${t}\` 工具`).join('\n')}

## 注意事项
- 此技能从成功执行中自动学习
- 需要人工验证后才能启用
`;

    return {
      type: 'skill',
      name: `auto_${taskType}_skill`,
      content: skillContent,
      sourceTraces: [trace.id],
      confidence: trace.outcomeConfidence || 0.7,
      suggestedLayer: 5, // Skill 始终放在实验性层级
    };
  }

  /**
   * 推断用户偏好
   */
  async inferPreferences(traces: ExecutionTrace[]): Promise<InferredPreference[]> {
    const preferences: InferredPreference[] = [];

    // 分析工具使用模式
    const toolUsage = new Map<string, number>();
    for (const trace of traces) {
      for (const tc of trace.toolCalls) {
        toolUsage.set(tc.name, (toolUsage.get(tc.name) || 0) + 1);
      }
    }

    // 找出最常用的工具
    const sortedTools = Array.from(toolUsage.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    if (sortedTools.length > 0) {
      preferences.push({
        key: 'preferred_tools',
        value: sortedTools.map(([name]) => name).join(','),
        confidence: 0.7,
        source: 'usage_pattern',
      });
    }

    // 分析代码风格偏好（从 write_file/edit_file 的内容推断）
    // TODO: 实现更复杂的代码风格分析

    return preferences;
  }

  // --------------------------------------------------------------------------
  // Insight Persistence
  // --------------------------------------------------------------------------

  /**
   * 保存洞察到数据库
   */
  async saveInsight(candidate: InsightCandidate, projectPath?: string): Promise<Insight> {
    const db = getDatabase();
    const dbInstance = db.getDb();
    if (!dbInstance) {
      throw new Error('Database not initialized');
    }

    const now = Date.now();
    const id = `insight_${now}_${Math.random().toString(36).substr(2, 9)}`;

    const content = typeof candidate.content === 'string'
      ? candidate.content
      : JSON.stringify(candidate.content);

    dbInstance.prepare(`
      INSERT INTO insights (
        id, type, name, content, source_traces, confidence,
        validation_status, usage_count, success_rate, injection_layer,
        decay_factor, project_path, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, 1.0, ?, ?, ?)
    `).run(
      id,
      candidate.type,
      candidate.name,
      content,
      JSON.stringify(candidate.sourceTraces),
      candidate.confidence,
      candidate.suggestedLayer,
      projectPath || null,
      now,
      now
    );

    logger.info('[LLMInsightExtractor] Insight saved', {
      id,
      type: candidate.type,
      name: candidate.name,
    });

    return {
      id,
      type: candidate.type,
      name: candidate.name,
      content,
      sourceTraces: candidate.sourceTraces,
      confidence: candidate.confidence,
      validationStatus: 'pending',
      usageCount: 0,
      successRate: 0,
      injectionLayer: candidate.suggestedLayer,
      decayFactor: 1.0,
      projectPath,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * 获取洞察
   */
  static getInsight(id: string): Insight | null {
    const db = getDatabase();
    const dbInstance = db.getDb();
    if (!dbInstance) return null;

    const row = dbInstance.prepare(`SELECT * FROM insights WHERE id = ?`).get(id) as SQLiteRow | undefined;
    if (!row) return null;

    return LLMInsightExtractor.rowToInsight(row);
  }

  /**
   * 获取指定类型的洞察
   */
  static getInsightsByType(type: InsightType, options: {
    minConfidence?: number;
    validatedOnly?: boolean;
    projectPath?: string;
    limit?: number;
  } = {}): Insight[] {
    const db = getDatabase();
    const dbInstance = db.getDb();
    if (!dbInstance) return [];

    const conditions: string[] = ['type = ?'];
    const params: unknown[] = [type];

    if (options.minConfidence !== undefined) {
      conditions.push('confidence >= ?');
      params.push(options.minConfidence);
    }

    if (options.validatedOnly) {
      conditions.push("validation_status = 'validated'");
    }

    if (options.projectPath) {
      conditions.push('(project_path = ? OR project_path IS NULL)');
      params.push(options.projectPath);
    }

    const limit = options.limit || 100;
    params.push(limit);

    const sql = `
      SELECT * FROM insights
      WHERE ${conditions.join(' AND ')}
      ORDER BY confidence DESC, updated_at DESC
      LIMIT ?
    `;

    const rows = dbInstance.prepare(sql).all(...params) as SQLiteRow[];
    return rows.map(LLMInsightExtractor.rowToInsight);
  }

  /**
   * 更新洞察
   */
  static updateInsight(id: string, updates: Partial<Insight>): boolean {
    const db = getDatabase();
    const dbInstance = db.getDb();
    if (!dbInstance) return false;

    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [Date.now()];

    if (updates.validationStatus !== undefined) {
      sets.push('validation_status = ?');
      params.push(updates.validationStatus);
    }
    if (updates.usageCount !== undefined) {
      sets.push('usage_count = ?');
      params.push(updates.usageCount);
    }
    if (updates.successRate !== undefined) {
      sets.push('success_rate = ?');
      params.push(updates.successRate);
    }
    if (updates.decayFactor !== undefined) {
      sets.push('decay_factor = ?');
      params.push(updates.decayFactor);
    }
    if (updates.lastUsed !== undefined) {
      sets.push('last_used = ?');
      params.push(updates.lastUsed);
    }

    params.push(id);

    const result = dbInstance.prepare(`
      UPDATE insights SET ${sets.join(', ')} WHERE id = ?
    `).run(...params);

    return result.changes > 0;
  }

  /**
   * 行数据转 Insight
   */
  private static rowToInsight(row: SQLiteRow): Insight {
    return {
      id: row.id as string,
      type: row.type as InsightType,
      name: row.name as string,
      content: row.content as string,
      sourceTraces: JSON.parse((row.source_traces as string) || '[]'),
      confidence: row.confidence as number,
      validationStatus: row.validation_status as 'pending' | 'validated' | 'rejected',
      usageCount: (row.usage_count as number) || 0,
      successRate: (row.success_rate as number) || 0,
      injectionLayer: (row.injection_layer as number) || 4,
      decayFactor: (row.decay_factor as number) || 1.0,
      lastUsed: row.last_used as number | undefined,
      projectPath: row.project_path as string | undefined,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let llmInsightExtractorInstance: LLMInsightExtractor | null = null;

export function getLLMInsightExtractor(): LLMInsightExtractor {
  if (!llmInsightExtractorInstance) {
    llmInsightExtractorInstance = new LLMInsightExtractor();
  }
  return llmInsightExtractorInstance;
}

// 导出用于测试
export { LLMInsightExtractor as LLMInsightExtractorClass };
