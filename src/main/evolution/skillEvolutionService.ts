// ============================================================================
// Skill Evolution Service - Skill 自创建服务
// Gen 8: Self-Evolution - 从成功案例生成 Skill
// ============================================================================

import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';
import type { InsightCandidate, Insight } from './llmInsightExtractor';
import { getLLMInsightExtractor } from './llmInsightExtractor';

const logger = createLogger('SkillEvolutionService');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface ParsedSkill {
  name: string;
  description: string;
  allowedTools: string[];
  content: string;
  triggers?: string[];
  steps?: string[];
}

export interface SkillProposal {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'duplicate';
  skill: ParsedSkill;
  sourceTraces: string[];
  confidence: number;
  requiresUserApproval: boolean;
  reason?: string;
  createdAt: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// 数据库行类型
type SQLiteRow = Record<string, unknown>;

// ----------------------------------------------------------------------------
// Skill Evolution Service
// ----------------------------------------------------------------------------

export class SkillEvolutionService {
  private skillsDir: string;
  private pendingProposals: Map<string, SkillProposal> = new Map();

  constructor() {
    const userDataPath = app?.getPath?.('userData') || process.cwd();
    this.skillsDir = path.join(userDataPath, 'skills', 'learned');
  }

  /**
   * 从 InsightCandidate 创建 Skill 提案
   */
  async proposeSkill(candidate: InsightCandidate): Promise<SkillProposal> {
    const id = `proposal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // 解析 Skill 内容
    const parsed = this.parseSkillContent(candidate.content);
    if (!parsed) {
      return {
        id,
        status: 'rejected',
        skill: { name: '', description: '', allowedTools: [], content: '' },
        sourceTraces: candidate.sourceTraces,
        confidence: candidate.confidence,
        requiresUserApproval: false,
        reason: '无法解析 Skill 内容',
        createdAt: Date.now(),
      };
    }

    // 验证格式
    const validation = this.validateSkillFormat(parsed);
    if (!validation.valid) {
      return {
        id,
        status: 'rejected',
        skill: parsed,
        sourceTraces: candidate.sourceTraces,
        confidence: candidate.confidence,
        requiresUserApproval: false,
        reason: `格式验证失败: ${validation.errors.join(', ')}`,
        createdAt: Date.now(),
      };
    }

    // 检查重复
    const similar = await this.findSimilarSkill(parsed.name, parsed.description);
    if (similar) {
      return {
        id,
        status: 'duplicate',
        skill: parsed,
        sourceTraces: candidate.sourceTraces,
        confidence: candidate.confidence,
        requiresUserApproval: false,
        reason: `与现有技能 "${similar.name}" 相似`,
        createdAt: Date.now(),
      };
    }

    // 创建提案
    const proposal: SkillProposal = {
      id,
      status: 'pending',
      skill: parsed,
      sourceTraces: candidate.sourceTraces,
      confidence: candidate.confidence,
      requiresUserApproval: candidate.confidence < 0.9, // 低置信度需要人工审批
      createdAt: Date.now(),
    };

    // 保存到内存
    this.pendingProposals.set(id, proposal);

    // 持久化提案
    await this.persistProposal(proposal);

    logger.info('[SkillEvolutionService] Skill proposal created', {
      id,
      name: parsed.name,
      confidence: candidate.confidence,
      requiresApproval: proposal.requiresUserApproval,
    });

    return proposal;
  }

  /**
   * 解析 Skill 内容（SKILL.md 格式）
   */
  private parseSkillContent(content: string | object): ParsedSkill | null {
    const rawContent = typeof content === 'string' ? content : JSON.stringify(content);

    try {
      // 解析 frontmatter
      const frontmatterMatch = rawContent.match(/^---\n([\s\S]*?)\n---/);
      if (!frontmatterMatch) {
        logger.warn('[SkillEvolutionService] No frontmatter found');
        return null;
      }

      const frontmatter = frontmatterMatch[1];
      const body = rawContent.slice(frontmatterMatch[0].length).trim();

      // 解析 YAML frontmatter（简单解析）
      const nameMatch = frontmatter.match(/name:\s*(.+)/);
      const descMatch = frontmatter.match(/description:\s*(.+)/);
      const toolsMatch = frontmatter.match(/allowed_tools:\n((?:\s+-\s*.+\n?)*)/);

      if (!nameMatch || !descMatch) {
        logger.warn('[SkillEvolutionService] Missing required frontmatter fields');
        return null;
      }

      const name = nameMatch[1].trim();
      const description = descMatch[1].trim();
      const allowedTools: string[] = [];

      if (toolsMatch) {
        const toolLines = toolsMatch[1].split('\n');
        for (const line of toolLines) {
          const toolMatch = line.match(/^\s+-\s*(.+)/);
          if (toolMatch) {
            allowedTools.push(toolMatch[1].trim());
          }
        }
      }

      // 提取触发条件和步骤
      const triggers: string[] = [];
      const steps: string[] = [];

      const triggerSection = body.match(/## 触发条件\n([\s\S]*?)(?=\n## |$)/);
      if (triggerSection) {
        const triggerLines = triggerSection[1].split('\n');
        for (const line of triggerLines) {
          if (line.startsWith('- ')) {
            triggers.push(line.slice(2).trim());
          }
        }
      }

      const stepSection = body.match(/## 执行步骤\n([\s\S]*?)(?=\n## |$)/);
      if (stepSection) {
        const stepLines = stepSection[1].split('\n');
        for (const line of stepLines) {
          const stepMatch = line.match(/^\d+\.\s*(.+)/);
          if (stepMatch) {
            steps.push(stepMatch[1].trim());
          }
        }
      }

      return {
        name,
        description,
        allowedTools,
        content: rawContent,
        triggers,
        steps,
      };
    } catch (error) {
      logger.error('[SkillEvolutionService] Failed to parse skill content:', error);
      return null;
    }
  }

  /**
   * 验证 Skill 格式
   */
  private validateSkillFormat(parsed: ParsedSkill): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 必填字段
    if (!parsed.name) {
      errors.push('缺少 name 字段');
    } else if (!/^[a-z][a-z0-9_]*$/.test(parsed.name)) {
      errors.push('name 必须是小写字母开头，只能包含小写字母、数字和下划线');
    }

    if (!parsed.description) {
      errors.push('缺少 description 字段');
    }

    if (parsed.allowedTools.length === 0) {
      warnings.push('没有指定 allowed_tools');
    }

    // 检查工具是否有效
    const validTools = [
      'bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep',
      'web_fetch', 'web_search', 'mcp', 'task', 'todo_write', 'ask_user_question',
    ];
    for (const tool of parsed.allowedTools) {
      if (!validTools.includes(tool)) {
        warnings.push(`未知工具: ${tool}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * 检查重复技能
   */
  private async findSimilarSkill(name: string, description: string): Promise<ParsedSkill | null> {
    // 检查已安装的技能
    try {
      await fs.promises.mkdir(this.skillsDir, { recursive: true });
      const files = await fs.promises.readdir(this.skillsDir);

      for (const file of files) {
        if (!file.endsWith('.md')) continue;

        const content = await fs.promises.readFile(path.join(this.skillsDir, file), 'utf-8');
        const parsed = this.parseSkillContent(content);

        if (parsed) {
          // 名称完全匹配
          if (parsed.name.toLowerCase() === name.toLowerCase()) {
            return parsed;
          }

          // 描述相似度检测
          const similarity = this.calculateSimilarity(parsed.description, description);
          if (similarity > 0.8) {
            return parsed;
          }
        }
      }
    } catch (error) {
      logger.error('[SkillEvolutionService] Failed to check similar skills:', error);
    }

    return null;
  }

  /**
   * 计算文本相似度
   */
  private calculateSimilarity(text1: string, text2: string): number {
    const words1 = new Set(text1.toLowerCase().split(/\s+/));
    const words2 = new Set(text2.toLowerCase().split(/\s+/));

    const intersection = [...words1].filter(w => words2.has(w));
    const union = new Set([...words1, ...words2]);

    return intersection.length / union.size;
  }

  /**
   * 审批并安装技能
   */
  async approveAndInstall(proposalId: string): Promise<{ success: boolean; path?: string; error?: string }> {
    const proposal = this.pendingProposals.get(proposalId) || await this.loadProposal(proposalId);

    if (!proposal) {
      return { success: false, error: '提案不存在' };
    }

    if (proposal.status !== 'pending') {
      return { success: false, error: `提案状态不正确: ${proposal.status}` };
    }

    try {
      // 确保目录存在
      await fs.promises.mkdir(this.skillsDir, { recursive: true });

      // 写入文件
      const filename = `${proposal.skill.name}.md`;
      const filepath = path.join(this.skillsDir, filename);

      await fs.promises.writeFile(filepath, proposal.skill.content, 'utf-8');

      // 更新提案状态
      proposal.status = 'approved';
      await this.updateProposalStatus(proposalId, 'approved');

      // 同时保存为 Insight
      const extractor = getLLMInsightExtractor();
      await extractor.saveInsight({
        type: 'skill',
        name: proposal.skill.name,
        content: proposal.skill.content,
        sourceTraces: proposal.sourceTraces,
        confidence: proposal.confidence,
        suggestedLayer: 3, // 已审批的技能进入高置信度层
      });

      logger.info('[SkillEvolutionService] Skill installed', {
        proposalId,
        name: proposal.skill.name,
        path: filepath,
      });

      return { success: true, path: filepath };
    } catch (error) {
      logger.error('[SkillEvolutionService] Failed to install skill:', error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * 拒绝技能提案
   */
  async rejectProposal(proposalId: string, reason?: string): Promise<void> {
    const proposal = this.pendingProposals.get(proposalId);
    if (proposal) {
      proposal.status = 'rejected';
      proposal.reason = reason;
    }

    await this.updateProposalStatus(proposalId, 'rejected', reason);

    logger.info('[SkillEvolutionService] Skill proposal rejected', {
      proposalId,
      reason,
    });
  }

  /**
   * 获取所有待审批的提案
   */
  async getPendingProposals(): Promise<SkillProposal[]> {
    const db = getDatabase();
    const dbInstance = db.getDb();
    if (!dbInstance) return [];

    const rows = dbInstance.prepare(`
      SELECT * FROM skill_proposals WHERE status = 'pending' ORDER BY created_at DESC
    `).all() as SQLiteRow[];

    return rows.map(this.rowToProposal);
  }

  /**
   * 监控技能效果
   */
  async trackSkillEffectiveness(skillName: string, success: boolean): Promise<void> {
    const db = getDatabase();
    const dbInstance = db.getDb();
    if (!dbInstance) return;

    try {
      // 更新 insights 表中对应的 Skill 记录
      const row = dbInstance.prepare(`
        SELECT id, usage_count, success_rate FROM insights
        WHERE type = 'skill' AND name = ?
      `).get(skillName) as SQLiteRow | undefined;

      if (!row) {
        logger.warn('[SkillEvolutionService] Skill not found in insights:', skillName);
        return;
      }

      const usageCount = ((row.usage_count as number) || 0) + 1;
      const oldSuccessRate = (row.success_rate as number) || 0;
      const oldSuccessCount = Math.round(oldSuccessRate * ((row.usage_count as number) || 0));
      const newSuccessCount = oldSuccessCount + (success ? 1 : 0);
      const newSuccessRate = newSuccessCount / usageCount;

      dbInstance.prepare(`
        UPDATE insights
        SET usage_count = ?, success_rate = ?, last_used = ?, updated_at = ?
        WHERE id = ?
      `).run(usageCount, newSuccessRate, Date.now(), Date.now(), row.id);

      logger.debug('[SkillEvolutionService] Skill effectiveness tracked', {
        skillName,
        usageCount,
        successRate: newSuccessRate,
      });
    } catch (error) {
      logger.error('[SkillEvolutionService] Failed to track skill effectiveness:', error);
    }
  }

  /**
   * 获取技能统计
   */
  async getSkillStats(): Promise<{
    installed: number;
    pending: number;
    totalUsage: number;
    avgSuccessRate: number;
  }> {
    const db = getDatabase();
    const dbInstance = db.getDb();
    if (!dbInstance) {
      return { installed: 0, pending: 0, totalUsage: 0, avgSuccessRate: 0 };
    }

    // 统计已安装的技能
    let installed = 0;
    try {
      const files = await fs.promises.readdir(this.skillsDir);
      installed = files.filter(f => f.endsWith('.md')).length;
    } catch {
      // 目录不存在
    }

    // 统计待审批的提案
    const pendingRow = dbInstance.prepare(`
      SELECT COUNT(*) as count FROM skill_proposals WHERE status = 'pending'
    `).get() as SQLiteRow;
    const pending = (pendingRow?.count as number) || 0;

    // 统计使用情况
    const usageRow = dbInstance.prepare(`
      SELECT SUM(usage_count) as total_usage, AVG(success_rate) as avg_rate
      FROM insights WHERE type = 'skill'
    `).get() as SQLiteRow;

    return {
      installed,
      pending,
      totalUsage: (usageRow?.total_usage as number) || 0,
      avgSuccessRate: (usageRow?.avg_rate as number) || 0,
    };
  }

  // --------------------------------------------------------------------------
  // Persistence
  // --------------------------------------------------------------------------

  /**
   * 持久化提案
   */
  private async persistProposal(proposal: SkillProposal): Promise<void> {
    const db = getDatabase();
    const dbInstance = db.getDb();
    if (!dbInstance) return;

    try {
      dbInstance.prepare(`
        INSERT INTO skill_proposals (
          id, status, skill_content, source_traces, confidence,
          requires_approval, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        proposal.id,
        proposal.status,
        JSON.stringify(proposal.skill),
        JSON.stringify(proposal.sourceTraces),
        proposal.confidence,
        proposal.requiresUserApproval ? 1 : 0,
        proposal.reason || null,
        proposal.createdAt
      );
    } catch (error) {
      logger.error('[SkillEvolutionService] Failed to persist proposal:', error);
    }
  }

  /**
   * 加载提案
   */
  private async loadProposal(proposalId: string): Promise<SkillProposal | null> {
    const db = getDatabase();
    const dbInstance = db.getDb();
    if (!dbInstance) return null;

    const row = dbInstance.prepare(`
      SELECT * FROM skill_proposals WHERE id = ?
    `).get(proposalId) as SQLiteRow | undefined;

    if (!row) return null;
    return this.rowToProposal(row);
  }

  /**
   * 更新提案状态
   */
  private async updateProposalStatus(
    proposalId: string,
    status: 'pending' | 'approved' | 'rejected' | 'duplicate',
    reason?: string
  ): Promise<void> {
    const db = getDatabase();
    const dbInstance = db.getDb();
    if (!dbInstance) return;

    dbInstance.prepare(`
      UPDATE skill_proposals SET status = ?, reason = ? WHERE id = ?
    `).run(status, reason || null, proposalId);
  }

  /**
   * 行数据转 SkillProposal
   */
  private rowToProposal(row: SQLiteRow): SkillProposal {
    return {
      id: row.id as string,
      status: row.status as 'pending' | 'approved' | 'rejected' | 'duplicate',
      skill: JSON.parse(row.skill_content as string),
      sourceTraces: JSON.parse((row.source_traces as string) || '[]'),
      confidence: row.confidence as number,
      requiresUserApproval: !!(row.requires_approval as number),
      reason: row.reason as string | undefined,
      createdAt: row.created_at as number,
    };
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let skillEvolutionServiceInstance: SkillEvolutionService | null = null;

export function getSkillEvolutionService(): SkillEvolutionService {
  if (!skillEvolutionServiceInstance) {
    skillEvolutionServiceInstance = new SkillEvolutionService();
  }
  return skillEvolutionServiceInstance;
}

// 导出用于测试
export { SkillEvolutionService as SkillEvolutionServiceClass };
