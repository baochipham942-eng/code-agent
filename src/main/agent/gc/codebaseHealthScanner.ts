// ============================================================================
// Codebase Health Scanner - Periodic GC scans via PostExecution hook
// ============================================================================
// Harness Engineering P2b: 代码库健康度持续监控
// 4 项健康检查（通过 PostExecution hook 触发，异步执行不阻塞）:
// - typecheck_freshness: 每 5 轮运行 tsc --noEmit，追踪错误数趋势
// - hardcoded_values: 每 10 轮扫描硬编码违规
// - test_freshness: 每 10 轮检查修改文件是否有对应测试
// - doc_drift: 每 20 轮检查 CLAUDE.md token 数是否膨胀
// ============================================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('CodebaseHealthScanner');
const execAsync = promisify(exec);

// ============================================================================
// Types
// ============================================================================

export interface HealthCheck {
  name: string;
  passed: boolean;
  score: number; // 0-1
  message: string;
  trend?: 'improving' | 'stable' | 'degrading';
}

export interface HealthScanResult {
  timestamp: number;
  turnCount: number;
  checks: HealthCheck[];
  overallScore: number;
  alerts: string[];
  durationMs: number;
}

interface ScanHistory {
  typecheckErrors: number[];
  hardcodedViolations: number[];
  claudeMdTokens: number[];
}

// ============================================================================
// Codebase Health Scanner
// ============================================================================

class CodebaseHealthScannerService {
  private history: ScanHistory = {
    typecheckErrors: [],
    hardcodedViolations: [],
    claudeMdTokens: [],
  };
  private lastScanResult: HealthScanResult | null = null;
  private scanning = false;

  /**
   * Run health scan based on turn count (different checks at different intervals)
   * Called from PostExecution hook — runs async, does not block agent.
   */
  async scan(turnCount: number, workingDirectory: string, modifiedFiles: string[]): Promise<HealthScanResult | null> {
    if (this.scanning) return null;
    this.scanning = true;

    const startTime = Date.now();
    const checks: HealthCheck[] = [];
    const alerts: string[] = [];

    try {
      // typecheck_freshness: every 5 turns
      if (turnCount % 5 === 0) {
        const check = await this.checkTypeScript(workingDirectory);
        checks.push(check);
        if (!check.passed) alerts.push(`TypeScript: ${check.message}`);
      }

      // hardcoded_values: every 10 turns
      if (turnCount % 10 === 0) {
        const check = await this.checkHardcodedValues(workingDirectory);
        checks.push(check);
        if (!check.passed) alerts.push(`Hardcoded values: ${check.message}`);
      }

      // test_freshness: every 10 turns (if files were modified)
      if (turnCount % 10 === 0 && modifiedFiles.length > 0) {
        const check = await this.checkTestFreshness(workingDirectory, modifiedFiles);
        checks.push(check);
        if (!check.passed) alerts.push(`Test coverage: ${check.message}`);
      }

      // doc_drift: every 20 turns
      if (turnCount % 20 === 0) {
        const check = await this.checkDocDrift(workingDirectory);
        checks.push(check);
        if (!check.passed) alerts.push(`Doc drift: ${check.message}`);
      }

      if (checks.length === 0) {
        this.scanning = false;
        return null; // No checks ran this turn
      }

      const overallScore = checks.length > 0
        ? checks.reduce((sum, c) => sum + c.score, 0) / checks.length
        : 1;

      const result: HealthScanResult = {
        timestamp: Date.now(),
        turnCount,
        checks,
        overallScore,
        alerts,
        durationMs: Date.now() - startTime,
      };

      this.lastScanResult = result;

      logger.info('[GC] Health scan completed', {
        turnCount,
        checksRun: checks.length,
        overallScore: overallScore.toFixed(2),
        alerts: alerts.length,
        durationMs: result.durationMs,
      });

      return result;
    } catch (error) {
      logger.error('[GC] Health scan failed:', error);
      return null;
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Get the latest scan result (for dynamic reminders)
   */
  getLastScanResult(): HealthScanResult | null {
    return this.lastScanResult;
  }

  // --------------------------------------------------------------------------
  // Individual Health Checks
  // --------------------------------------------------------------------------

  private async checkTypeScript(workingDirectory: string): Promise<HealthCheck> {
    try {
      const { stdout, stderr } = await execAsync('npx tsc --noEmit 2>&1 | grep -c "error TS" || echo "0"', {
        cwd: workingDirectory,
        timeout: 30000,
      });

      const errorCount = parseInt(stdout.trim(), 10) || 0;
      this.history.typecheckErrors.push(errorCount);

      const trend = this.calculateTrend(this.history.typecheckErrors);

      return {
        name: 'typecheck_freshness',
        passed: errorCount === 0,
        score: errorCount === 0 ? 1 : Math.max(0, 1 - errorCount * 0.1),
        message: errorCount === 0
          ? 'TypeScript: no errors'
          : `TypeScript: ${errorCount} error(s)`,
        trend,
      };
    } catch {
      return {
        name: 'typecheck_freshness',
        passed: true,
        score: 0.5,
        message: 'TypeScript check skipped (tsc not available)',
      };
    }
  }

  private async checkHardcodedValues(workingDirectory: string): Promise<HealthCheck> {
    try {
      const scriptPath = path.join(workingDirectory, 'scripts', 'check-hardcoded-models.sh');
      await fs.access(scriptPath);

      const { stdout } = await execAsync(`bash "${scriptPath}" 2>&1 | tail -1`, {
        cwd: workingDirectory,
        timeout: 15000,
      });

      const hasViolations = stdout.includes('FAIL') || stdout.includes('violation');
      const violationMatch = stdout.match(/(\d+)\s*(violation|issue)/i);
      const violationCount = violationMatch ? parseInt(violationMatch[1], 10) : (hasViolations ? 1 : 0);

      this.history.hardcodedViolations.push(violationCount);

      return {
        name: 'hardcoded_values',
        passed: violationCount === 0,
        score: violationCount === 0 ? 1 : Math.max(0, 1 - violationCount * 0.15),
        message: violationCount === 0
          ? 'No hardcoded values detected'
          : `${violationCount} hardcoded value violation(s)`,
        trend: this.calculateTrend(this.history.hardcodedViolations),
      };
    } catch {
      return {
        name: 'hardcoded_values',
        passed: true,
        score: 0.5,
        message: 'Hardcoded value check skipped (script not found)',
      };
    }
  }

  private async checkTestFreshness(workingDirectory: string, modifiedFiles: string[]): Promise<HealthCheck> {
    const tsFiles = modifiedFiles.filter(f => f.endsWith('.ts') && !f.includes('.test.') && !f.includes('.spec.'));
    if (tsFiles.length === 0) {
      return {
        name: 'test_freshness',
        passed: true,
        score: 1,
        message: 'No source files modified',
      };
    }

    let filesWithTests = 0;
    for (const file of tsFiles) {
      const testFile = file.replace('.ts', '.test.ts');
      const specFile = file.replace('.ts', '.spec.ts');
      try {
        await fs.access(path.join(workingDirectory, testFile));
        filesWithTests++;
      } catch {
        try {
          await fs.access(path.join(workingDirectory, specFile));
          filesWithTests++;
        } catch {
          // No test file found
        }
      }
    }

    const coverage = tsFiles.length > 0 ? filesWithTests / tsFiles.length : 1;

    return {
      name: 'test_freshness',
      passed: coverage >= 0.5,
      score: coverage,
      message: `${filesWithTests}/${tsFiles.length} modified files have tests (${(coverage * 100).toFixed(0)}%)`,
    };
  }

  private async checkDocDrift(workingDirectory: string): Promise<HealthCheck> {
    try {
      const claudeMdPath = path.join(workingDirectory, 'CLAUDE.md');
      const content = await fs.readFile(claudeMdPath, 'utf-8');

      // Rough token estimate (chars / 3.5)
      const tokens = Math.ceil(content.length / 3.5);
      this.history.claudeMdTokens.push(tokens);

      const MAX_TOKENS = 5000; // Alert if CLAUDE.md grows beyond 5K tokens
      const passed = tokens <= MAX_TOKENS;

      return {
        name: 'doc_drift',
        passed,
        score: passed ? 1 : Math.max(0, 1 - (tokens - MAX_TOKENS) / MAX_TOKENS),
        message: `CLAUDE.md: ~${tokens} tokens${passed ? '' : ` (exceeds ${MAX_TOKENS} limit)`}`,
        trend: this.calculateTrend(this.history.claudeMdTokens),
      };
    } catch {
      return {
        name: 'doc_drift',
        passed: true,
        score: 0.5,
        message: 'CLAUDE.md not found',
      };
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private calculateTrend(history: number[]): 'improving' | 'stable' | 'degrading' {
    if (history.length < 2) return 'stable';

    const recent = history.slice(-3);
    const prev = history.slice(-6, -3);

    if (prev.length === 0) return 'stable';

    const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length;
    const prevAvg = prev.reduce((s, v) => s + v, 0) / prev.length;

    const diff = recentAvg - prevAvg;
    if (Math.abs(diff) < 0.5) return 'stable';
    // For error/violation counts, lower is better
    return diff < 0 ? 'improving' : 'degrading';
  }
}

// ============================================================================
// Singleton
// ============================================================================

let instance: CodebaseHealthScannerService | null = null;

export function getCodebaseHealthScanner(): CodebaseHealthScannerService {
  if (!instance) {
    instance = new CodebaseHealthScannerService();
  }
  return instance;
}
