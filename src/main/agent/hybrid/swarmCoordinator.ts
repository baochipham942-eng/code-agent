// ============================================================================
// Swarm 协调器 - 收集汇报、检测冲突、聚合结果
// ============================================================================

import { createLogger } from '../../services/infra/logger';
import type { AgentReport, AgentRuntime } from './swarmTypes';

const logger = createLogger('AgentSwarm');

/**
 * Swarm 协调器
 *
 * 负责：
 * 1. 收集所有 Agent 的汇报
 * 2. 检测冲突
 * 3. 聚合结果
 */
export class SwarmCoordinator {
  private reports: AgentReport[] = [];
  private conflicts: Array<{ agentA: string; agentB: string; resource: string }> = [];

  /**
   * 接收汇报
   */
  receive(report: AgentReport): void {
    this.reports.push(report);

    // 检测冲突
    if (report.type === 'conflict' && report.data.conflictWith) {
      this.conflicts.push({
        agentA: report.agentId,
        agentB: report.data.conflictWith,
        resource: report.data.resourceNeeded || 'unknown',
      });
    }

    logger.debug('Coordinator received report', {
      agentId: report.agentId,
      type: report.type,
      status: report.data.status,
    });
  }

  /**
   * 获取冲突列表
   */
  getConflicts() {
    return this.conflicts;
  }

  /**
   * 聚合结果
   */
  aggregate(runtimes: AgentRuntime[]): string {
    const outputs: string[] = [];

    // 按完成顺序排序
    const sorted = [...runtimes]
      .filter(r => r.status === 'completed' && r.output)
      .sort((a, b) => (a.endTime || 0) - (b.endTime || 0));

    for (const runtime of sorted) {
      outputs.push(`## ${runtime.agent.name}\n\n${runtime.output}`);
    }

    // 添加失败信息
    const failed = runtimes.filter(r => r.status === 'failed');
    if (failed.length > 0) {
      outputs.push('\n## Failed Agents\n');
      for (const runtime of failed) {
        outputs.push(`- ${runtime.agent.name}: ${runtime.error || 'Unknown error'}`);
      }
    }

    return outputs.join('\n\n');
  }

  /**
   * 重置
   */
  reset(): void {
    this.reports = [];
    this.conflicts = [];
  }
}
