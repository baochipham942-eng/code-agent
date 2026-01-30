import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { BaseReporter } from './base.js';
import { TestReport, TestResult } from '../types.js';

export class JsonReporter extends BaseReporter {
  async generate(report: TestReport): Promise<string> {
    await mkdir(this.options.outputDir!, { recursive: true });

    const filename = `report-${report.timestamp.replace(/[:.]/g, '-')}.json`;
    const filepath = join(this.options.outputDir!, filename);

    const fullReport = {
      ...report,
      meta: {
        generatedAt: new Date().toISOString(),
        version: '1.0.0',
      },
      analysis: this.generateAnalysis(report),
    };

    await writeFile(filepath, JSON.stringify(fullReport, null, 2));

    const summaryPath = join(this.options.outputDir!, 'summary.json');
    await writeFile(
      summaryPath,
      JSON.stringify(
        {
          timestamp: report.timestamp,
          duration: report.duration,
          summary: report.summary,
          passRate:
            ((report.summary.passed / report.summary.total) * 100).toFixed(1) +
            '%',
          failedTests: report.results
            .filter((r) => r.status === 'failed')
            .map((r) => ({
              id: r.testCase.id,
              name: r.testCase.name,
              failedValidations: [
                ...r.validations.filter((v) => !v.passed).map((v) => v.message),
                ...(r.processValidations
                  ?.filter((v) => !v.passed)
                  .map((v) => v.message) || []),
              ],
            })),
        },
        null,
        2
      )
    );

    console.log(`📄 JSON report saved to: ${filepath}`);
    return filepath;
  }

  private generateAnalysis(report: TestReport) {
    const results = report.results;

    return {
      toolUsage: this.analyzeToolUsage(results),
      agentUsage: this.analyzeAgentUsage(results),
      commonFailures: this.analyzeCommonFailures(results),
      efficiency: this.analyzeEfficiency(results),
      recommendations: this.generateRecommendations(results),
    };
  }

  private analyzeToolUsage(results: TestResult[]) {
    const usage: Record<string, { count: number; avgDuration: number }> = {};

    for (const r of results) {
      if (!r.trace) continue;
      for (const tc of r.trace.toolCalls) {
        if (!usage[tc.name]) usage[tc.name] = { count: 0, avgDuration: 0 };
        usage[tc.name].count++;
        usage[tc.name].avgDuration += tc.duration;
      }
    }

    for (const tool of Object.keys(usage)) {
      usage[tool].avgDuration = Math.round(
        usage[tool].avgDuration / usage[tool].count
      );
    }

    return usage;
  }

  private analyzeAgentUsage(results: TestResult[]) {
    const usage: Record<string, number> = {};
    let directExecution = 0;
    let delegated = 0;

    for (const r of results) {
      if (!r.trace) continue;

      if (r.trace.agentDispatches.length === 0) {
        directExecution++;
      } else {
        delegated++;
        for (const ad of r.trace.agentDispatches) {
          usage[ad.agentType] = (usage[ad.agentType] || 0) + 1;
        }
      }
    }

    return { directExecution, delegated, byType: usage };
  }

  private analyzeCommonFailures(results: TestResult[]) {
    const failures: Record<string, number> = {};

    for (const r of results.filter((r) => r.status === 'failed')) {
      for (const v of r.validations.filter((v) => !v.passed)) {
        const key = `[Result] ${v.validation.type}`;
        failures[key] = (failures[key] || 0) + 1;
      }

      for (const v of (r.processValidations || []).filter((v) => !v.passed)) {
        const key = `[Process] ${v.validation.type}`;
        failures[key] = (failures[key] || 0) + 1;
      }
    }

    return Object.entries(failures)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
  }

  private analyzeEfficiency(results: TestResult[]) {
    const passed = results.filter((r) => r.status === 'passed');
    if (passed.length === 0) return null;

    return {
      avgDuration: Math.round(
        passed.reduce((s, r) => s + r.metrics.duration, 0) / passed.length
      ),
      avgToolCalls: (
        passed.reduce((s, r) => s + (r.trace?.totalToolCalls || 0), 0) /
        passed.length
      ).toFixed(1),
      avgAgentDispatches: (
        passed.reduce((s, r) => s + (r.trace?.totalAgentDispatches || 0), 0) /
        passed.length
      ).toFixed(1),
    };
  }

  private generateRecommendations(results: TestResult[]): string[] {
    const recommendations: string[] = [];

    const processFailures = results.flatMap(
      (r) => (r.processValidations || []).filter((v) => !v.passed)
    );

    const blindEditCount = processFailures.filter(
      (v) => v.validation.type === 'no-blind-edit'
    ).length;
    if (blindEditCount > 2) {
      recommendations.push(
        `Agent 经常在未读取文件的情况下进行编辑 (${blindEditCount} 次)，建议强化 "先读后改" 的行为`
      );
    }

    const redundantReadCount = processFailures.filter(
      (v) => v.validation.type === 'no-redundant-reads'
    ).length;
    if (redundantReadCount > 2) {
      recommendations.push(
        `存在冗余文件读取 (${redundantReadCount} 次)，建议优化上下文缓存机制`
      );
    }

    const wrongAgentCount = processFailures.filter(
      (v) =>
        v.validation.type === 'agent-not-dispatched' ||
        v.validation.type === 'agent-dispatched'
    ).length;
    if (wrongAgentCount > 2) {
      recommendations.push(
        `Agent 分派决策有误 (${wrongAgentCount} 次)，建议调整任务复杂度判断逻辑`
      );
    }

    return recommendations;
  }
}
