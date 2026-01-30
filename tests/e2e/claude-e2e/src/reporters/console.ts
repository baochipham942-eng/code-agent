import { BaseReporter, ReporterOptions } from './base.js';
import { TestReport, TestResult } from '../types.js';

export class ConsoleReporter extends BaseReporter {
  constructor(options: ReporterOptions = {}) {
    super(options);
  }

  onStart(total: number): void {
    console.log('\n' + '═'.repeat(60));
    console.log('🚀 Claude Agent E2E Tests');
    console.log('═'.repeat(60));
    console.log(`📋 Total test cases: ${total}\n`);
  }

  onTestStart(testCase: {
    id: string;
    name: string;
    complexity: string;
  }): void {
    process.stdout.write(
      `  [${testCase.complexity}] ${testCase.id}: ${testCase.name} ... `
    );
  }

  onTestEnd(result: TestResult): void {
    const status = this.getStatusEmoji(result.status);
    const duration = this.formatDuration(result.metrics.duration);

    console.log(`${status} (${duration})`);

    if (result.status === 'failed' && this.options.verbose) {
      this.printFailureDetails(result);
    }
  }

  private printFailureDetails(result: TestResult): void {
    console.log('    ┌─ Failures:');

    for (const v of result.validations.filter((v) => !v.passed)) {
      console.log(
        `    │  ❌ [Result] ${v.validation.type}: ${v.message || 'Failed'}`
      );
    }

    if (result.processValidations) {
      for (const v of result.processValidations.filter((v) => !v.passed)) {
        console.log(
          `    │  ❌ [Process] ${v.validation.type}: ${v.message || 'Failed'}`
        );
        if (v.details?.actualToolCalls) {
          console.log(
            `    │     Actual: ${v.details.actualToolCalls.join(' → ')}`
          );
        }
        if (v.details?.inefficiencies) {
          console.log(
            `    │     Issues: ${v.details.inefficiencies.join(', ')}`
          );
        }
      }
    }

    if (result.workDir) {
      console.log(`    │  📁 Work dir preserved: ${result.workDir}`);
    }

    console.log('    └─');
  }

  async generate(report: TestReport): Promise<string> {
    const { summary, byCategory, byComplexity } = report;

    console.log('\n' + '═'.repeat(60));
    console.log('📊 Test Results Summary');
    console.log('═'.repeat(60));

    console.log(`
  Total:    ${summary.total}
  ✅ Passed:  ${summary.passed} (${this.getPassRate(summary.passed, summary.total)})
  ❌ Failed:  ${summary.failed}
  ⏭️  Skipped: ${summary.skipped}
  ⏱️  Timeout: ${summary.timeout}
  💥 Error:   ${summary.error}

  ⏱️  Duration: ${this.formatDuration(report.duration)}
`);

    console.log('─'.repeat(40));
    console.log('📈 By Complexity:');
    for (const [level, stats] of Object.entries(byComplexity)) {
      const bar = this.renderProgressBar(stats.passed, stats.total, 20);
      console.log(`  ${level}: ${bar} ${stats.passed}/${stats.total}`);
    }

    console.log('\n📈 By Category:');
    for (const [cat, stats] of Object.entries(byCategory)) {
      const bar = this.renderProgressBar(stats.passed, stats.total, 20);
      console.log(`  ${cat.padEnd(15)}: ${bar} ${stats.passed}/${stats.total}`);
    }

    console.log('\n📈 Process Validation Summary:');
    const processStats = this.aggregateProcessStats(report.results);
    for (const [type, stats] of Object.entries(processStats)) {
      if (stats.total > 0) {
        const bar = this.renderProgressBar(stats.passed, stats.total, 15);
        console.log(
          `  ${type.padEnd(20)}: ${bar} ${stats.passed}/${stats.total}`
        );
      }
    }

    console.log('\n' + '═'.repeat(60));

    const failed = report.results.filter((r) => r.status === 'failed');
    if (failed.length > 0) {
      console.log('\n❌ Failed Tests:');
      for (const r of failed) {
        console.log(`  - ${r.testCase.id}: ${r.testCase.name}`);
      }
    }

    return '';
  }

  private renderProgressBar(value: number, total: number, width: number): string {
    if (total === 0) return '░'.repeat(width);
    const filled = Math.round((value / total) * width);
    return '█'.repeat(filled) + '░'.repeat(width - filled);
  }

  private aggregateProcessStats(
    results: TestResult[]
  ): Record<string, { passed: number; total: number }> {
    const stats: Record<string, { passed: number; total: number }> = {};

    for (const result of results) {
      if (!result.processValidations) continue;

      for (const pv of result.processValidations) {
        const type = pv.validation.type;
        if (!stats[type]) stats[type] = { passed: 0, total: 0 };
        stats[type].total++;
        if (pv.passed) stats[type].passed++;
      }
    }

    return stats;
  }
}
