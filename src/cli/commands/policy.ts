// ============================================================================
// Policy Command - exec-policy 离线校验与规则解释（CI pre-gate）
// ============================================================================
//
// 子命令:
//   check [--file <path>] [--expect "cmd=decision"...] [--json]  - 校验规则集
//   explain <command> [--file <path>] [--json]                   - 解释一条命令的匹配
//
// 完全离线：只读文件 + 纯函数校验（src/host/security/execPolicyCheck.ts），
// 不加载模型/网络/可写模块，不改写 policy 文件。
//
// 退出码: 0 = 全部通过（或无 policy 文件可校验）；1 = 校验/期望失败；
//         2 = 用法错误（commander 标准，如 --expect 格式错误）。
// ============================================================================

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { getProjectConfigDir, getUserConfigDir } from '../../host/config/configPaths';
import {
  checkPolicyExamples,
  explainPolicyCommand,
  findPolicyConflicts,
  parseExecPolicy,
  type PolicyExample,
  type PolicyIssue,
} from '../../host/security/execPolicyCheck';
import type { PolicyDecision, PrefixRule } from '../../host/security/execPolicy';
import type { CLIGlobalOptions } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ResolvedPolicyFile {
  /** 实际读取的路径；null = 没找到任何 policy 文件 */
  filePath: string | null;
  /** 候选路径（no-policy 报告用） */
  candidates: string[];
}

/** 与 ExecPolicyStore 相同的文件定位：--file 优先，其次项目级，最后用户级。 */
function resolvePolicyFile(file: string | undefined, project: string): ResolvedPolicyFile {
  if (file) {
    const resolved = path.resolve(file);
    return { filePath: fs.existsSync(resolved) ? resolved : null, candidates: [resolved] };
  }
  const candidates = [
    path.join(getProjectConfigDir(project), 'exec-policy.json'),
    path.join(getUserConfigDir(), 'exec-policy.json'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  return { filePath: found ?? null, candidates };
}

function getGlobalOptions(command: Command): Partial<CLIGlobalOptions> {
  // command → check/explain 子命令 → policyCommand → program
  const program = command.parent?.parent;
  return (program?.opts?.() ?? {}) as Partial<CLIGlobalOptions>;
}

function parseExpectOption(value: string, previous: PolicyExample[]): PolicyExample[] {
  const eq = value.lastIndexOf('=');
  const command = eq > 0 ? value.slice(0, eq).trim() : '';
  const expect = eq > 0 ? value.slice(eq + 1).trim() : '';
  if (!command || !['allow', 'prompt', 'forbidden'].includes(expect)) {
    throw new Error(`--expect 格式错误: ${JSON.stringify(value)}（应为 "命令=allow|prompt|forbidden"）`);
  }
  return [...previous, { command, expect: expect as PolicyDecision }];
}

function formatIssue(issue: PolicyIssue): string {
  const marker = issue.severity === 'error' ? '✗' : '⚠';
  return `  ${marker} [${issue.code}] ${issue.message}`;
}

function formatDecision(decision: PolicyDecision | null): string {
  return decision ?? 'no-match';
}

// ---------------------------------------------------------------------------
// policy check
// ---------------------------------------------------------------------------

interface CheckOptions {
  file?: string;
  expect?: PolicyExample[];
  json?: boolean;
}

const checkCommand = new Command('check')
  .description('离线校验 exec-policy 规则集（语法 / 冲突 / 示例命令），CI pre-gate 用')
  .option('--file <path>', '校验指定文件（默认: 项目 .code-agent/exec-policy.json，其次用户级）')
  .option('--expect <cmd=decision>', '示例命令期望断言，可重复，如 --expect "git status=allow"', parseExpectOption, [] as PolicyExample[])
  .option('--json', 'JSON 格式输出')
  .action((options: CheckOptions, command: Command) => {
    const globalOpts = getGlobalOptions(command);
    const json = options.json || process.argv.includes('--json');
    const resolved = resolvePolicyFile(options.file, globalOpts.project ?? process.cwd());

    // 无文件可校验：默认查找时不算失败（CI 可以直接跑，repo 没配 policy 时视为通过）；
    // 显式 --file 指向不存在的文件则明确报错。
    if (!resolved.filePath) {
      const missing = '未找到 exec-policy.json';
      if (options.file) {
        if (json) {
          console.log(JSON.stringify({ status: 'error', error: `${missing}: ${resolved.candidates[0]}`, file: null }, null, 2));
        } else {
          console.error(`${missing}: ${resolved.candidates[0]}`);
        }
        process.exit(1);
        return;
      }
      if (json) {
        console.log(JSON.stringify({ status: 'no-policy', file: null, candidates: resolved.candidates }, null, 2));
      } else {
        console.log([
          `${missing}（已检查: ${resolved.candidates.join(', ')}）`,
          '没有可校验的规则集 — 视为通过（CI 中可用 --file 钉住路径，缺失即失败）',
        ].join('\n'));
      }
      process.exit(0);
      return;
    }

    const filePath = resolved.filePath;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseExecPolicy(raw);
    const conflicts = findPolicyConflicts(parsed.rules);
    const issues = [...parsed.issues, ...conflicts];
    const examples = [...parsed.examples, ...(options.expect ?? [])];
    const exampleResults = checkPolicyExamples(parsed.rules, examples);

    const errorCount = issues.filter((i) => i.severity === 'error').length;
    const warningCount = issues.length - errorCount;
    const failedExamples = exampleResults.filter((r) => !r.pass);
    const pass = errorCount === 0 && failedExamples.length === 0;

    if (json) {
      console.log(JSON.stringify({
        status: pass ? 'pass' : 'fail',
        file: filePath,
        issues,
        examples: exampleResults,
        summary: {
          rules: parsed.rules.length,
          examples: exampleResults.length,
          errors: errorCount,
          warnings: warningCount,
          failedExamples: failedExamples.length,
        },
      }, null, 2));
    } else {
      const lines: string[] = [
        `exec-policy 校验: ${filePath}`,
        `  规则 ${parsed.rules.length} 条 · 示例 ${exampleResults.length} 条`,
        '',
      ];
      if (issues.length === 0) {
        lines.push('  ✓ 语法与冲突检查通过');
      } else {
        for (const issue of issues) lines.push(formatIssue(issue));
      }
      if (exampleResults.length > 0) {
        lines.push('', '示例逐条:');
        for (const r of exampleResults) {
          const marker = r.pass ? '✓' : '✗';
          lines.push(`  ${marker} ${JSON.stringify(r.command)} → ${formatDecision(r.actual)}（期望 ${r.expect}）`);
        }
      }
      lines.push(
        '',
        `结果: ${pass ? 'PASS' : 'FAIL'}（${errorCount} error, ${warningCount} warning` +
        (exampleResults.length > 0 ? `, ${failedExamples.length}/${exampleResults.length} 示例失败` : '') + '）',
      );
      console.log(lines.join('\n'));
    }
    process.exit(pass ? 0 : 1);
  });

// ---------------------------------------------------------------------------
// policy explain <command>
// ---------------------------------------------------------------------------

interface ExplainOptions {
  file?: string;
  json?: boolean;
}

const explainCommand = new Command('explain')
  .description('解释一条命令命中了哪条 exec-policy 规则及原因')
  .argument('<command>', '要解释的 shell 命令，如 "git push origin main"')
  .option('--file <path>', '使用指定 policy 文件（默认: 项目级，其次用户级）')
  .option('--json', 'JSON 格式输出')
  .action((command: string, options: ExplainOptions, cmd: Command) => {
    const globalOpts = getGlobalOptions(cmd);
    const json = options.json || process.argv.includes('--json');
    const resolved = resolvePolicyFile(options.file, globalOpts.project ?? process.cwd());

    let rules: readonly PrefixRule[] = [];
    if (resolved.filePath) {
      const parsed = parseExecPolicy(fs.readFileSync(resolved.filePath, 'utf-8'));
      if (parsed.issues.some((i) => i.severity === 'error')) {
        if (json) {
          console.log(JSON.stringify({ status: 'error', file: resolved.filePath, issues: parsed.issues }, null, 2));
        } else {
          console.error(
            [`exec-policy 文件存在语法错误，无法解释: ${resolved.filePath}`, ...parsed.issues.map(formatIssue)].join('\n'),
          );
        }
        process.exit(1);
        return;
      }
      rules = parsed.rules;
    }

    const explanation = explainPolicyCommand(rules, command);
    if (json) {
      console.log(JSON.stringify({
        status: 'ok',
        file: resolved.filePath,
        ...(resolved.filePath ? {} : { note: 'no-policy' }),
        ...explanation,
      }, null, 2));
    } else {
      console.log([
        `命令: ${explanation.command}`,
        `policy 文件: ${resolved.filePath ?? '（无 — 已检查: ' + resolved.candidates.join(', ') + '）'}`,
        `tokens: [${explanation.tokens.join(', ')}]`,
        `决策: ${formatDecision(explanation.decision)}`,
        `原因: ${explanation.reason}`,
      ].join('\n'));
    }
    process.exit(0);
  });

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

export const policyCommand = new Command('policy')
  .description('exec-policy 离线校验与规则解释（CI pre-gate，无模型/网络/副作用）')
  .addCommand(checkCommand)
  .addCommand(explainCommand);
