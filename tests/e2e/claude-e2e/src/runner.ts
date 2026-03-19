import { EventEmitter } from 'events';
import {
  TestCase,
  TestResult,
  TestContext,
  TestReport,
  Category,
  Complexity,
  ValidationResult,
  Validation,
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
    // 如果启用步骤分解执行，使用分步策略
    if (testCase.stepByStepExecution) {
      return this.runStepByStep(testCase);
    }

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

      // 检查是否可以使用 nudge 机制（支持缺失文件和未完成修改）
      if (testCase.nudgeOnMissingFile && result.workDir) {
        const missingFiles = this.getMissingFiles(result.validations);
        const incompleteFiles = this.getIncompleteFiles(result.validations);

        if (missingFiles.length > 0 || incompleteFiles.length > 0) {
          const nudgeDetails = [
            missingFiles.length > 0 ? `缺失: ${missingFiles.join(', ')}` : '',
            incompleteFiles.length > 0 ? `未完成: ${incompleteFiles.map(f => f.file).join(', ')}` : '',
          ].filter(Boolean).join('; ');
          console.log(`    💡 Nudge: ${nudgeDetails}`);

          const nudgeResult = await this.runWithNudge(testCase, result.workDir, missingFiles, incompleteFiles);
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
   * 步骤分解执行：将多步骤任务拆成独立调用，逐步验证
   * 解决 DeepSeek 等模型在复杂任务中"半途而废"的问题
   */
  private async runStepByStep(testCase: TestCase): Promise<TestResult> {
    let project: TempProject | null = null;
    const startTime = Date.now();
    let totalToolCalls = 0;

    try {
      project = await createTempProject(testCase.fixture);

      // 解析步骤：优先使用显式定义，否则从 prompt 自动提取
      const steps = testCase.steps ?? this.parseStepsFromPrompt(testCase.prompt);

      if (steps.length === 0) {
        console.log(`    ⚠️ 无法解析步骤，回退到普通执行`);
        return this.runSingleTest(testCase);
      }

      console.log(`    📋 分解为 ${steps.length} 个步骤执行`);

      // 逐步执行
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const stepNum = i + 1;

        // 构建单步骤 prompt，包含上下文
        const stepPrompt = this.buildStepPrompt(testCase, step.instruction, stepNum, steps.length);

        console.log(`    [${stepNum}/${steps.length}] ${step.instruction.substring(0, 50)}...`);

        // 执行单步骤，最多重试 2 次
        let stepSuccess = false;
        for (let retry = 0; retry < 3 && !stepSuccess; retry++) {
          const timeout = testCase.timeout ?? 60000;
          const cliResult = await runClaude({
            prompt: stepPrompt,
            workDir: project.path,
            model: testCase.cliOptions?.model,
            provider: testCase.cliOptions?.provider,
            allowedTools: testCase.cliOptions?.allowedTools,
            timeout,
          });

          totalToolCalls += cliResult.metrics?.toolCalls ?? 0;

          // 如果有步骤级验证，执行验证
          if (step.validation) {
            const files = await project.snapshot();
            const ctx: TestContext = {
              testCase,
              workDir: project.path,
              startTime,
              output: cliResult.output,
              exitCode: cliResult.exitCode,
              files,
            };
            const [result] = await runValidations(ctx, [step.validation]);
            stepSuccess = result.passed;
            if (!stepSuccess && retry < 2) {
              console.log(`    [${stepNum}] ❌ 验证失败，重试...`);
            }
          } else {
            // 无验证则假设成功
            stepSuccess = true;
          }
        }

        if (!stepSuccess) {
          console.log(`    [${stepNum}] ❌ 步骤失败`);
        }
      }

      // 最终验证
      const files = await project.snapshot();
      const ctx: TestContext = {
        testCase,
        workDir: project.path,
        startTime,
        output: '',
        exitCode: 0,
        files,
      };

      const validations = await runValidations(ctx, testCase.validations);
      const emptyTrace = { toolCalls: [], agentDispatches: [], totalApiCalls: 0, totalToolCalls, totalAgentDispatches: 0, timeline: [] };
      const processValidations = testCase.processValidations?.length
        ? await runProcessValidations(emptyTrace, ctx, testCase.processValidations)
        : [];

      const allPassed = validations.every(v => v.passed) && processValidations.every(v => v.passed);

      if (!allPassed && this.options.preserveOnFail) {
        // 保留失败目录
      } else {
        await project.cleanup();
        project = null;
      }

      return {
        testCase,
        status: allPassed ? 'passed' : 'failed',
        validations,
        processValidations,
        metrics: {
          duration: Date.now() - startTime,
          toolCalls: totalToolCalls,
        },
        output: '',
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

  /**
   * 从 prompt 自动解析步骤（识别 1. 2. 3. 格式）
   */
  private parseStepsFromPrompt(prompt: string): { instruction: string; validation?: Validation }[] {
    const stepRegex = /^\s*(\d+)\.\s*(.+)$/gm;
    const steps: { instruction: string }[] = [];
    let match;

    while ((match = stepRegex.exec(prompt)) !== null) {
      steps.push({ instruction: match[2].trim() });
    }

    return steps;
  }

  /**
   * 构建单步骤 prompt
   */
  private buildStepPrompt(testCase: TestCase, instruction: string, stepNum: number, totalSteps: number): string {
    return `你正在执行一个多步骤任务的第 ${stepNum}/${totalSteps} 步。

当前步骤：${instruction}

重要提示：
- 只执行当前步骤，不要执行其他步骤
- 必须实际调用工具完成操作（read_file、edit_file、write_file）
- 完成后立即停止

背景信息：
${testCase.prompt}`;
  }

  /**
   * 从验证结果中提取缺失的文件（file-exists 验证失败）
   */
  private getMissingFiles(validations: ValidationResult[]): string[] {
    return validations
      .filter(v => !v.passed && v.validation.type === 'file-exists' && v.validation.target)
      .map(v => v.validation.target!);
  }

  /**
   * 从验证结果中提取未完成修改的文件（file-contains 验证失败）
   */
  private getIncompleteFiles(validations: ValidationResult[]): { file: string; missing: string[] }[] {
    return validations
      .filter(v => !v.passed && v.validation.type === 'file-contains' && v.validation.target)
      .map(v => ({
        file: v.validation.target!,
        missing: v.validation.contains || [],
      }));
  }

  /**
   * 使用 nudge 提示重新运行
   */
  private async runWithNudge(
    testCase: TestCase,
    workDir: string,
    missingFiles: string[],
    incompleteFiles: { file: string; missing: string[] }[] = []
  ): Promise<TestResult> {
    // 构建强制性的 nudge 提示，使用清单格式
    const parts: string[] = [];

    parts.push(`⚠️ 任务执行不完整，必须立即完成以下操作：`);
    parts.push('');

    // 构建清单
    let checklistIndex = 1;

    if (missingFiles.length > 0) {
      parts.push(`## 缺失的文件（必须创建）`);
      for (const file of missingFiles) {
        parts.push(`${checklistIndex}. [ ] 使用 write_file 创建 ${file}`);
        checklistIndex++;
      }
      parts.push('');
    }

    if (incompleteFiles.length > 0) {
      parts.push(`## 未完成修改的文件（必须编辑）`);
      for (const { file, missing } of incompleteFiles) {
        const keywords = missing.slice(0, 3).join('、');
        parts.push(`${checklistIndex}. [ ] 使用 edit_file 修改 ${file}，确保包含: ${keywords}`);
        checklistIndex++;
      }
      parts.push('');
    }

    parts.push(`---`);
    parts.push(`原始任务要求：`);
    parts.push(testCase.prompt);
    parts.push('');
    parts.push(`⛔ 警告：以上每一项都是必须完成的，不要遗漏任何一个！逐个完成并打钩。`);

    const nudgePrompt = parts.join('\n');

    const timeout = testCase.timeout ?? testCase.cliOptions?.timeout ?? 120000;
    const cliResult = await runClaude({
      prompt: nudgePrompt,
      workDir,
      model: testCase.cliOptions?.model,
      provider: testCase.cliOptions?.provider,
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

      // setupCommands 是预定义的测试配置，需要 shell 支持重定向等操作
      if (testCase.setupCommands?.length) {
        const { execSync } = await import('child_process');
        for (const cmd of testCase.setupCommands) {
          execSync(cmd, { cwd: project.path, stdio: 'pipe', shell: '/bin/bash' });
        }
      }

      const timeout =
        testCase.timeout ?? testCase.cliOptions?.timeout ?? 120000;
      const cliResult = await runClaude({
        prompt: testCase.prompt,
        workDir: project.path,
        model: testCase.cliOptions?.model,
        provider: testCase.cliOptions?.provider,
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
