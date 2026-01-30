import { TestReport, TestResult } from '../types.js';

export interface ReporterOptions {
  outputDir?: string;
  verbose?: boolean;
}

export abstract class BaseReporter {
  protected options: ReporterOptions;

  constructor(options: ReporterOptions = {}) {
    this.options = {
      outputDir: options.outputDir || './results',
      verbose: options.verbose ?? false,
    };
  }

  abstract generate(report: TestReport): Promise<string>;

  protected formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  }

  protected getStatusEmoji(status: TestResult['status']): string {
    const map = {
      passed: '✅',
      failed: '❌',
      skipped: '⏭️',
      timeout: '⏱️',
      error: '💥',
    };
    return map[status];
  }

  protected getPassRate(passed: number, total: number): string {
    if (total === 0) return '0%';
    return `${((passed / total) * 100).toFixed(1)}%`;
  }
}
