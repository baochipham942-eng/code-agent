import { EventEmitter } from 'events';
import {
  TestCase,
  TestResult,
  TestContext,
  TestReport,
  Category,
  Complexity,
  ValidationResult,
} from './types.js';
import { runClaude } from './utils/claude-cli.js';
import { createTempProject, TempProject } from './utils/temp-project.js';
import { parseExecutionTrace } from './utils/trace-parser.js';
import { runValidations, runProcessValidations } from './validators/index.js';

export interface RunnerOptions {
  concurrency?: number;
  preserveOnFail?: boolean;
  filter?: {
    categories?: Category[];
    complexities?: Complexity[];
    ids?: string[];
    tags?: string[];
  };
  timeout?: number;
}

export class TestRunner extends EventEmitter {
  private options: Required<RunnerOptions>;

  constructor(options: RunnerOptions = {}) {
    super();
    this.options = {
      concurrency: options.concurrency ?? 1,
      preserveOnFail: options.preserveOnFail ?? true,
      filter: options.filter ?? {},
      timeout: options.timeout ?? 300000,
    };
  }

  async run(testCases: TestCase[]): Promise<TestReport> {
    const filtered = this.filterTestCases(testCases);
    const results: TestResult[] = [];
    const startTime = Date.now();

    this.emit('start', { total: filtered.length });

    const sorted = [...filtered].sort((a, b) =>
      a.complexity.localeCompare(b.complexity)
    );

    for (const testCase of sorted) {
      if (testCase.skip) {
        const skipped = this.createSkippedResult(testCase);
        results.push(skipped);
        this.emit('skip', skipped);
        continue;
      }

      this.emit('testStart', testCase);

      try {
        const result = await this.runWithRetry(testCase);
        results.push(result);
        this.emit('testEnd', result);
      } catch (error) {
        const errorResult = this.createErrorResult(testCase, error);
        results.push(errorResult);
        this.emit('testError', errorResult);
      }
    }

    const report = this.generateReport(results, Date.now() - startTime);
    this.emit('end', report);

    return report;
  }

  /**
   * 带重试和 nudge 机制的测试执行
   */
  private async runWithRetry(testCase: TestCase): Promise<TestResult> {
    const maxAttempts = (testCase.retries ?? 0) + 1;
    let lastResult: TestResult | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        console.log(`    🔄 Retry ${attempt}/${maxAttempts}...`);
      }
      const result = await this.runSingleTest(testCase);
      lastResult = result;

      if (result.status === 'passed') {
        if (attempt > 1) {
          result.metrics = { ...result.metrics, retryAttempt: attempt } as any;
        }
        return result;
      }

      // 检查是否可以使用 nudge 机制
      if (testCase.nudgeOnMissingFile && result.workDir) {
        const missingFiles = this.getMissingFiles(result.validations);
        if (missingFiles.length > 0) {
          console.log(`    💡 Nudge: 提示模型创建 ${missingFiles.join(', ')}`);
          const nudgeResult = await this.runWithNudge(testCase, result.workDir, missingFiles);
          if (nudgeResult.status === 'passed') {
            nudgeResult.metrics = { ...nudgeResult.metrics, nudged: true } as any;
            return nudgeResult;
          }
          lastResult = nudgeResult;
        }
      }

      if (attempt === maxAttempts) {
        return lastResult;
      }

      this.emit('retry', { testCase, attempt, maxAttempts });
    }

    return lastResult!;
  }

  /**
   * 从验证结果中提取缺失的文件
   */
  private getMissingFiles(validations: ValidationResult[]): string[] {
    return validations
      .filter(v => !v.passed && v.validation.type === 'file-exists' && v.validation.target)
      .map(v => v.validation.target!);
  }

  /**
   * 使用 nudge 提示重新运行
   */
  private async runWithNudge(
    testCase: TestCase,
    workDir: string,
    missingFiles: string[]
  ): Promise<TestResult> {
    // 构建更详细的 nudge 提示，包含原始任务上下文
    const fileList = missingFiles.map(f => `- ${f}`).join('\n');
    const nudgePrompt = `你之前的任务执行不完整。

原始任务：
${testCase.prompt}

缺失的文件：
${fileList}

请立即使用 write_file 创建以上所有缺失文件。每个文件都必须创建，不要遗漏！`;

    const timeout = testCase.timeout ?? testCase.cliOptions?.timeout ?? 120000;
    const cliResult = await runClaude({
      prompt: nudgePrompt,
      workDir,
      model: testCase.cliOptions?.model,
      allowedTools: testCase.cliOptions?.allowedTools,
      timeout,
    });

    const trace = parseExecutionTrace(cliResult.output);
    const { createTempProject } = await import('./utils/temp-project.js');

    // 重新读取文件快照
    const files = new Map<string, string>();
    const fs = await import('fs/promises');
    const path = await import('path');

    const readDir = async (dir: string, base: string = '') => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.join(base, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          await readDir(fullPath, relativePath);
        } else if (entry.isFile()) {
          try {
            files.set(relativePath, await fs.readFile(fullPath, 'utf-8'));
          } catch {}
        }
      }
    };
    await readDir(workDir);

    const ctx: TestContext = {
      testCase,
      workDir,
      startTime: Date.now(),
      output: cliResult.output,
      exitCode: cliResult.exitCode,
      files,
    };

    const validations = await runValidations(ctx, testCase.validations);
    const processValidations = testCase.processValidations?.length
      ? await runProcessValidations(trace, ctx, testCase.processValidations)
      : [];

    const allPassed = validations.every(v => v.passed) && processValidations.every(v => v.passed);

    return {
      testCase,
      status: allPassed ? 'passed' : 'failed',
      validations,
      processValidations,
      trace,
      metrics: { duration: cliResult.duration, ...cliResult.metrics },
      output: cliResult.output,
      workDir: allPassed ? undefined : workDir,
    };
  }

  private async runSingleTest(testCase: TestCase): Promise<TestResult> {
    let project: TempProject | null = null;

    try {
      project = await createTempProject(testCase.fixture);

      if (testCase.setupCommands?.length) {
        const { execFileSync } = await import('child_process');
        for (const cmd of testCase.setupCommands) {
          const [command, ...args] = cmd.split(' ');
          execFileSync(command, args, { cwd: project.path, stdio: 'pipe' });
        }
      }

      const timeout =
        testCase.timeout ?? testCase.cliOptions?.timeout ?? 120000;
      const cliResult = await runClaude({
        prompt: testCase.prompt,
        workDir: project.path,
        model: testCase.cliOptions?.model,
        allowedTools: testCase.cliOptions?.allowedTools,
        plan: testCase.cliOptions?.plan,
        timeout,
      });

      const trace = parseExecutionTrace(cliResult.output);

      const ctx: TestContext = {
        testCase,
        workDir: project.path,
        startTime: Date.now(),
        output: cliResult.output,
        exitCode: cliResult.exitCode,
        files: await project.snapshot(),
      };

      const validations = await runValidations(ctx, testCase.validations);

      const processValidations = testCase.processValidations?.length
        ? await runProcessValidations(trace, ctx, testCase.processValidations)
        : [];

      const allPassed =
        validations.every((v) => v.passed) &&
        processValidations.every((v) => v.passed);

      if (!allPassed && this.options.preserveOnFail) {
        // 保留失败的工作目录用于调试
      } else {
        await project.cleanup();
        project = null;
      }

      return {
        testCase,
        status: allPassed ? 'passed' : 'failed',
        validations,
        processValidations,
        trace,
        metrics: {
          duration: cliResult.duration,
          ...cliResult.metrics,
        },
        output: cliResult.output,
        workDir: allPassed ? undefined : project?.path,
      };
    } catch (error: any) {
      if (error.message?.includes('Timeout')) {
        return {
          testCase,
          status: 'timeout',
          validations: [],
          metrics: { duration: testCase.timeout ?? 120000 },
          output: '',
          error: error.message,
        };
      }
      throw error;
    } finally {
      if (project && !this.options.preserveOnFail) {
        await project.cleanup().catch(() => {});
      }
    }
  }

  filterTestCases(testCases: TestCase[]): TestCase[] {
    const { filter } = this.options;

    return testCases.filter((tc) => {
      if (filter.ids?.length && !filter.ids.includes(tc.id)) return false;
      if (filter.categories?.length && !filter.categories.includes(tc.category))
        return false;
      if (
        filter.complexities?.length &&
        !filter.complexities.includes(tc.complexity)
      )
        return false;
      if (filter.tags?.length && !filter.tags.some((t) => tc.tags?.includes(t)))
        return false;
      return true;
    });
  }

  private generateReport(results: TestResult[], duration: number): TestReport {
    const summary = {
      total: results.length,
      passed: results.filter((r) => r.status === 'passed').length,
      failed: results.filter((r) => r.status === 'failed').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      timeout: results.filter((r) => r.status === 'timeout').length,
      error: results.filter((r) => r.status === 'error').length,
    };

    const byCategory = {} as Record<Category, { passed: number; total: number }>;
    const byComplexity = {} as Record<
      Complexity,
      { passed: number; total: number }
    >;

    for (const result of results) {
      const cat = result.testCase.category;
      const comp = result.testCase.complexity;

      byCategory[cat] = byCategory[cat] || { passed: 0, total: 0 };
      byCategory[cat].total++;
      if (result.status === 'passed') byCategory[cat].passed++;

      byComplexity[comp] = byComplexity[comp] || { passed: 0, total: 0 };
      byComplexity[comp].total++;
      if (result.status === 'passed') byComplexity[comp].passed++;
    }

    return {
      timestamp: new Date().toISOString(),
      duration,
      summary,
      byCategory,
      byComplexity,
      results,
    };
  }

  private createSkippedResult(testCase: TestCase): TestResult {
    return {
      testCase,
      status: 'skipped',
      validations: [],
      metrics: { duration: 0 },
      output: '',
    };
  }

  private createErrorResult(testCase: TestCase, error: any): TestResult {
    return {
      testCase,
      status: 'error',
      validations: [],
      metrics: { duration: 0 },
      output: '',
      error: error?.message || String(error),
    };
  }
}
