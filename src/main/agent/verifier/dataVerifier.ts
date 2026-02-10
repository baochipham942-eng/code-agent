// ============================================================================
// Data Verifier - 数据处理任务验证器
// ============================================================================
// 检查：output_file_exists + file_readable + no_all_null_columns +
//       row_count_sanity + no_empty_result_columns
// 借鉴 Great Expectations 的声明式验证模式
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { createLogger } from '../../services/infra/logger';
import type { TaskVerifier, VerificationContext, VerificationResult, VerificationCheck } from './verifierRegistry';
import type { TaskAnalysis } from '../hybrid/taskRouter';

const logger = createLogger('DataVerifier');

/**
 * Data task verifier
 *
 * Performs deterministic checks on data processing outputs:
 * 1. output_file_exists — Output file exists and is non-empty (>1KB)
 * 2. file_readable — Output file can be parsed without errors
 * 3. no_all_null_columns — No columns are entirely null/empty
 * 4. row_count_sanity — Output row count is reasonable
 * 5. no_empty_result_columns — Key result columns are not all zero/NaN
 */
export class DataVerifier implements TaskVerifier {
  id = 'data-verifier';
  taskType = 'data' as const;

  canVerify(taskAnalysis: TaskAnalysis): boolean {
    return taskAnalysis.taskType === 'data';
  }

  async verify(context: VerificationContext): Promise<VerificationResult> {
    const checks: VerificationCheck[] = [];
    const outputFiles = this.findDataFiles(context);

    if (outputFiles.length === 0) {
      // No data files found — check if agent output describes results inline
      checks.push({
        name: 'output_file_exists',
        passed: false,
        score: 0,
        message: 'No data output files (.xlsx/.csv) found in modified files or tool call results',
      });
    } else {
      for (const file of outputFiles) {
        // Check 1: File exists and non-empty
        checks.push(this.checkFileExists(file));

        // Check 2: File readable
        const readableCheck = this.checkFileReadable(file);
        checks.push(readableCheck);

        // Only run data quality checks if file is readable
        if (readableCheck.passed) {
          // Check 3: No all-null columns
          const nullCheck = this.checkNoAllNullColumns(file);
          if (nullCheck) checks.push(nullCheck);

          // Check 4: Row count sanity
          const rowCheck = this.checkRowCountSanity(file, context);
          if (rowCheck) checks.push(rowCheck);

          // Check 5: No empty result columns
          const emptyCheck = this.checkNoEmptyResultColumns(file);
          if (emptyCheck) checks.push(emptyCheck);
        }
      }
    }

    // Also check agent output for inline data results
    checks.push(this.checkOutputDescribesResults(context));

    // Calculate overall score
    const totalScore = checks.reduce((sum, c) => sum + c.score, 0);
    const score = checks.length > 0 ? totalScore / checks.length : 0;
    const passed = checks.filter(c => !c.passed).length <= 1 && score >= 0.6;

    const suggestions: string[] = [];
    for (const check of checks) {
      if (!check.passed) {
        suggestions.push(`Fix: ${check.name} — ${check.message}`);
      }
    }

    return {
      passed,
      score,
      checks,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
      taskType: 'data',
      durationMs: 0,
    };
  }

  private checkFileExists(filePath: string): VerificationCheck {
    if (!fs.existsSync(filePath)) {
      return {
        name: 'output_file_exists',
        passed: false,
        score: 0,
        message: `Output file not found: ${path.basename(filePath)}`,
        metadata: { path: filePath },
      };
    }

    const stats = fs.statSync(filePath);
    const isReasonableSize = stats.size > 1024; // > 1KB

    return {
      name: 'output_file_exists',
      passed: isReasonableSize,
      score: isReasonableSize ? 1 : 0.3,
      message: isReasonableSize
        ? `Output file exists: ${path.basename(filePath)} (${(stats.size / 1024).toFixed(1)} KB)`
        : `Output file too small: ${path.basename(filePath)} (${stats.size} bytes)`,
      metadata: { path: filePath, size: stats.size },
    };
  }

  private checkFileReadable(filePath: string): VerificationCheck {
    const ext = path.extname(filePath).toLowerCase();

    try {
      if (ext === '.csv') {
        // Try reading first few lines
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());
        if (lines.length < 1) {
          return {
            name: 'file_readable',
            passed: false,
            score: 0,
            message: 'CSV file is empty',
          };
        }
        return {
          name: 'file_readable',
          passed: true,
          score: 1,
          message: `CSV file readable: ${lines.length} lines`,
          metadata: { lines: lines.length },
        };
      }

      if (ext === '.xlsx' || ext === '.xls') {
        // Use Python to validate xlsx
        const result = this.runPythonCheck(
          `import pandas as pd; df=pd.read_excel('${filePath.replace(/'/g, "\\'")}'); print(f'ok:{len(df)}:{len(df.columns)}')`
        );
        if (result && result.startsWith('ok:')) {
          const parts = result.split(':');
          return {
            name: 'file_readable',
            passed: true,
            score: 1,
            message: `Excel file readable: ${parts[1]} rows, ${parts[2]} columns`,
            metadata: { rows: parseInt(parts[1]), columns: parseInt(parts[2]) },
          };
        }
        return {
          name: 'file_readable',
          passed: false,
          score: 0,
          message: `Excel file cannot be parsed: ${result || 'unknown error'}`,
        };
      }

      // Unknown data format, pass with lower confidence
      return {
        name: 'file_readable',
        passed: true,
        score: 0.7,
        message: `File format ${ext} not validated (unsupported)`,
      };
    } catch (error) {
      return {
        name: 'file_readable',
        passed: false,
        score: 0,
        message: `File read error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private checkNoAllNullColumns(filePath: string): VerificationCheck | null {
    const ext = path.extname(filePath).toLowerCase();

    try {
      let script: string;
      if (ext === '.csv') {
        script = `import pandas as pd; df=pd.read_csv('${filePath.replace(/'/g, "\\'")}'); nullcols=list(df.columns[df.isnull().all()]); print(f'nullcols:{len(nullcols)}:{",".join(nullcols[:5])}')`;
      } else if (ext === '.xlsx' || ext === '.xls') {
        script = `import pandas as pd; df=pd.read_excel('${filePath.replace(/'/g, "\\'")}'); nullcols=list(df.columns[df.isnull().all()]); print(f'nullcols:{len(nullcols)}:{",".join(str(c) for c in nullcols[:5])}')`;
      } else {
        return null;
      }

      const result = this.runPythonCheck(script);
      if (!result || !result.startsWith('nullcols:')) return null;

      const parts = result.split(':');
      const nullCount = parseInt(parts[1]);
      const nullNames = parts[2] || '';
      const hasNullColumns = nullCount > 0;

      return {
        name: 'no_all_null_columns',
        passed: !hasNullColumns,
        score: hasNullColumns ? 0.3 : 1,
        message: hasNullColumns
          ? `Found ${nullCount} all-null column(s): ${nullNames}`
          : 'No all-null columns detected',
        metadata: { nullColumnCount: nullCount, nullColumns: nullNames },
      };
    } catch {
      return null;
    }
  }

  private checkRowCountSanity(filePath: string, context: VerificationContext): VerificationCheck | null {
    const ext = path.extname(filePath).toLowerCase();

    try {
      let script: string;
      if (ext === '.csv') {
        script = `import pandas as pd; df=pd.read_csv('${filePath.replace(/'/g, "\\'")}'); print(f'rows:{len(df)}')`;
      } else if (ext === '.xlsx' || ext === '.xls') {
        script = `import pandas as pd; df=pd.read_excel('${filePath.replace(/'/g, "\\'")}'); print(f'rows:{len(df)}')`;
      } else {
        return null;
      }

      const result = this.runPythonCheck(script);
      if (!result || !result.startsWith('rows:')) return null;

      const rowCount = parseInt(result.split(':')[1]);

      // Empty result is suspicious
      if (rowCount === 0) {
        return {
          name: 'row_count_sanity',
          passed: false,
          score: 0,
          message: 'Output has 0 rows — likely a processing error',
          metadata: { rowCount },
        };
      }

      // Very few rows might be suspicious depending on context
      const isSuspiciouslySmall = rowCount < 2 && !context.taskDescription.match(/\b(one|single|1|一个|单)\b/i);

      return {
        name: 'row_count_sanity',
        passed: !isSuspiciouslySmall,
        score: isSuspiciouslySmall ? 0.5 : 1,
        message: isSuspiciouslySmall
          ? `Output has only ${rowCount} row(s) — may be incomplete`
          : `Row count: ${rowCount}`,
        metadata: { rowCount },
      };
    } catch {
      return null;
    }
  }

  private checkNoEmptyResultColumns(filePath: string): VerificationCheck | null {
    const ext = path.extname(filePath).toLowerCase();

    try {
      let script: string;
      if (ext === '.csv') {
        script = `import pandas as pd; df=pd.read_csv('${filePath.replace(/'/g, "\\'")}'); numcols=df.select_dtypes(include='number').columns; zerocols=[c for c in numcols if (df[c].fillna(0)==0).all()]; print(f'zerocols:{len(zerocols)}:{",".join(str(c) for c in zerocols[:5])}')`;
      } else if (ext === '.xlsx' || ext === '.xls') {
        script = `import pandas as pd; df=pd.read_excel('${filePath.replace(/'/g, "\\'")}'); numcols=df.select_dtypes(include='number').columns; zerocols=[c for c in numcols if (df[c].fillna(0)==0).all()]; print(f'zerocols:{len(zerocols)}:{",".join(str(c) for c in zerocols[:5])}')`;
      } else {
        return null;
      }

      const result = this.runPythonCheck(script);
      if (!result || !result.startsWith('zerocols:')) return null;

      const parts = result.split(':');
      const zeroCount = parseInt(parts[1]);
      const zeroNames = parts[2] || '';

      // Allow some zero columns (e.g., boolean flags), but warn if too many
      const totalColResult = this.runPythonCheck(
        ext === '.csv'
          ? `import pandas as pd; print(len(pd.read_csv('${filePath.replace(/'/g, "\\'")}').select_dtypes(include='number').columns))`
          : `import pandas as pd; print(len(pd.read_excel('${filePath.replace(/'/g, "\\'")}').select_dtypes(include='number').columns))`
      );
      const totalNumCols = totalColResult ? parseInt(totalColResult) : 0;
      const hasIssue = totalNumCols > 0 && zeroCount / totalNumCols > 0.5;

      return {
        name: 'no_empty_result_columns',
        passed: !hasIssue,
        score: hasIssue ? 0.4 : 1,
        message: hasIssue
          ? `${zeroCount}/${totalNumCols} numeric columns are all zero/NaN: ${zeroNames}`
          : `Numeric columns have data (${zeroCount} zero-only out of ${totalNumCols})`,
        metadata: { zeroColumnCount: zeroCount, totalNumericColumns: totalNumCols },
      };
    } catch {
      return null;
    }
  }

  private checkOutputDescribesResults(context: VerificationContext): VerificationCheck {
    const output = context.agentOutput;

    // Check for data-related output indicators
    const indicators = [
      /\d+\s*(行|rows?|条|records?)/i,
      /\d+\s*(列|columns?|字段)/i,
      /(结果|result|output|输出).*\.(xlsx|csv|xls)/i,
      /(保存|saved?|写入|exported?|生成)/i,
      /DataFrame|dataframe|数据框/i,
    ];

    const matchCount = indicators.filter(re => re.test(output)).length;
    const score = Math.min(1, matchCount / 3);
    const passed = matchCount >= 2 || output.length >= 200;

    return {
      name: 'output_describes_results',
      passed,
      score,
      message: passed
        ? `Output describes data results (${matchCount}/${indicators.length} indicators)`
        : `Output may not describe data results adequately (${matchCount}/${indicators.length} indicators)`,
    };
  }

  /**
   * Find data output files from context
   */
  private findDataFiles(context: VerificationContext): string[] {
    const dataExtensions = ['.xlsx', '.xls', '.csv'];
    const files: string[] = [];

    // From modified files
    if (context.modifiedFiles) {
      for (const f of context.modifiedFiles) {
        const ext = path.extname(f).toLowerCase();
        if (dataExtensions.includes(ext)) {
          const fullPath = path.isAbsolute(f) ? f : path.join(context.workingDirectory, f);
          if (fs.existsSync(fullPath)) {
            files.push(fullPath);
          }
        }
      }
    }

    // From tool call results — look for file paths in bash/write_file outputs
    if (context.toolCalls) {
      for (const call of context.toolCalls) {
        if (!call.result?.success || !call.result.output) continue;
        const output = call.result.output;

        // Extract file paths from output
        const pathMatches = output.match(/[^\s'"]+\.(xlsx|csv|xls)\b/gi) || [];
        for (const match of pathMatches) {
          const fullPath = path.isAbsolute(match) ? match : path.join(context.workingDirectory, match);
          if (fs.existsSync(fullPath) && !files.includes(fullPath)) {
            files.push(fullPath);
          }
        }
      }
    }

    // From agent output text
    const outputMatches = context.agentOutput.match(/[^\s'"]+\.(xlsx|csv|xls)\b/gi) || [];
    for (const match of outputMatches) {
      const fullPath = path.isAbsolute(match) ? match : path.join(context.workingDirectory, match);
      if (fs.existsSync(fullPath) && !files.includes(fullPath)) {
        files.push(fullPath);
      }
    }

    return files;
  }

  /**
   * Run a Python one-liner check, returns stdout or null on error
   */
  private runPythonCheck(script: string): string | null {
    try {
      const result = execSync(`python3 -c "${script.replace(/"/g, '\\"')}"`, {
        timeout: 15000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return result.trim();
    } catch (error) {
      logger.debug('Python check failed:', error instanceof Error ? error.message : String(error));
      return null;
    }
  }
}
