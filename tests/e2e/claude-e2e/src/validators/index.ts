import { execFileSync } from 'child_process';
import { readFile, access } from 'fs/promises';
import { join, basename, resolve, relative } from 'path';
import {
  TestContext,
  Validation,
  ValidationResult,
  ProcessValidation,
  ProcessValidationResult,
  ExecutionTrace,
  ToolCall,
} from '../types.js';

// ===== 工具名称映射 =====
// Claude Code 和 code-agent 使用不同的工具命名
// 这里提供双向映射，使测试用例可以使用任一命名
const TOOL_NAME_ALIASES: Record<string, string[]> = {
  // Claude Code 名称 -> code-agent 别名
  'Write': ['write_file'],
  'Read': ['read_file'],
  'Edit': ['edit_file'],
  'Bash': ['bash'],
  'Task': ['spawn_agent'],
  'Glob': ['glob'],
  'Grep': ['grep'],
  // code-agent 名称 -> Claude Code 别名
  'write_file': ['Write'],
  'read_file': ['Read'],
  'edit_file': ['Edit'],
  'bash': ['Bash'],
  'spawn_agent': ['Task'],
};

/**
 * 检查实际工具名是否匹配期望的工具名（考虑别名）
 */
function toolNameMatches(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  const aliases = TOOL_NAME_ALIASES[expected] || [];
  return aliases.includes(actual);
}

/**
 * 检查实际工具列表是否包含期望的工具（考虑别名）
 */
function hasToolWithAlias(actualTools: string[], expectedTool: string): boolean {
  if (actualTools.includes(expectedTool)) return true;
  const aliases = TOOL_NAME_ALIASES[expectedTool] || [];
  return aliases.some(alias => actualTools.includes(alias));
}

/**
 * 获取工具名及其所有别名
 */
function getToolNameWithAliases(toolName: string): string[] {
  return [toolName, ...(TOOL_NAME_ALIASES[toolName] || [])];
}

export async function runValidations(
  ctx: TestContext,
  validations: Validation[]
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];

  for (const validation of validations) {
    const result = await runSingleValidation(ctx, validation);
    results.push(result);
  }

  return results;
}

async function runSingleValidation(
  ctx: TestContext,
  validation: Validation
): Promise<ValidationResult> {
  try {
    switch (validation.type) {
      case 'file-exists':
        return await validateFileExists(ctx, validation);
      case 'file-contains':
        return await validateFileContains(ctx, validation);
      case 'file-structure':
        return await validateFileStructure(ctx, validation);
      case 'compile-pass':
        return await validateCompilePass(ctx, validation);
      case 'test-pass':
        return await validateTestPass(ctx, validation);
      case 'output-contains':
        return validateOutputContains(ctx, validation);
      case 'output-matches':
        return validateOutputMatches(ctx, validation);
      case 'no-error':
        return validateNoError(ctx, validation);
      case 'custom':
        return await validation.custom!(ctx);
      default:
        return {
          passed: false,
          validation,
          message: `Unknown validation type: ${validation.type}`,
        };
    }
  } catch (error: any) {
    return {
      passed: false,
      validation,
      message: `Validation error: ${error.message}`,
    };
  }
}

async function validateFileExists(
  ctx: TestContext,
  v: Validation
): Promise<ValidationResult> {
  const filePath = join(ctx.workDir, v.target!);
  try {
    await access(filePath);
    return { passed: true, validation: v };
  } catch {
    return {
      passed: false,
      validation: v,
      message: `File not found: ${v.target}`,
    };
  }
}

async function validateFileContains(
  ctx: TestContext,
  v: Validation
): Promise<ValidationResult> {
  const filePath = join(ctx.workDir, v.target!);
  try {
    const content = await readFile(filePath, 'utf-8');
    const searchContent = v.ignoreCase ? content.toLowerCase() : content;

    if (v.contains) {
      const missing = v.contains.filter((s) => {
        if (v.regex) {
          const flags = v.ignoreCase ? 'i' : '';
          return !new RegExp(s, flags).test(content);
        }
        const needle = v.ignoreCase ? s.toLowerCase() : s;
        return !searchContent.includes(needle);
      });
      if (missing.length > 0) {
        return {
          passed: false,
          validation: v,
          message: `File missing content: ${missing.join(', ')}`,
        };
      }
    }

    if (v.notContains) {
      const found = v.notContains.filter((s) => {
        if (v.regex) {
          const flags = v.ignoreCase ? 'i' : '';
          return new RegExp(s, flags).test(content);
        }
        const needle = v.ignoreCase ? s.toLowerCase() : s;
        return searchContent.includes(needle);
      });
      if (found.length > 0) {
        return {
          passed: false,
          validation: v,
          message: `File contains forbidden content: ${found.join(', ')}`,
        };
      }
    }

    return { passed: true, validation: v };
  } catch {
    return {
      passed: false,
      validation: v,
      message: `Cannot read file: ${v.target}`,
    };
  }
}

async function validateFileStructure(
  ctx: TestContext,
  v: Validation
): Promise<ValidationResult> {
  const paths = v.structure || [];
  const missing: string[] = [];

  for (const p of paths) {
    const fullPath = join(ctx.workDir, p);
    try {
      await access(fullPath);
    } catch {
      missing.push(p);
    }
  }

  if (missing.length > 0) {
    return {
      passed: false,
      validation: v,
      message: `Missing paths: ${missing.join(', ')}`,
      details: { missing },
    };
  }

  return { passed: true, validation: v };
}

async function validateCompilePass(
  ctx: TestContext,
  v: Validation
): Promise<ValidationResult> {
  try {
    execFileSync('npx', ['tsc', '--noEmit'], {
      cwd: ctx.workDir,
      stdio: 'pipe',
    });
    return { passed: true, validation: v };
  } catch (error: any) {
    return {
      passed: false,
      validation: v,
      message: `Compilation failed: ${error.stderr?.toString() || error.message}`,
    };
  }
}

async function validateTestPass(
  ctx: TestContext,
  v: Validation
): Promise<ValidationResult> {
  try {
    const args = v.target ? ['vitest', 'run', v.target] : ['vitest', 'run'];
    execFileSync('npx', args, {
      cwd: ctx.workDir,
      stdio: 'pipe',
    });
    return { passed: true, validation: v };
  } catch (error: any) {
    return {
      passed: false,
      validation: v,
      message: `Tests failed: ${error.stderr?.toString() || error.message}`,
    };
  }
}

function validateOutputContains(
  ctx: TestContext,
  v: Validation
): ValidationResult {
  const searchOutput = v.ignoreCase ? ctx.output.toLowerCase() : ctx.output;

  // AND 逻辑：所有字符串都必须出现
  if (v.contains) {
    const missing = v.contains.filter((s) => {
      if (v.regex) {
        const flags = v.ignoreCase ? 'i' : '';
        return !new RegExp(s, flags).test(ctx.output);
      }
      const needle = v.ignoreCase ? s.toLowerCase() : s;
      return !searchOutput.includes(needle);
    });
    if (missing.length > 0) {
      return {
        passed: false,
        validation: v,
        message: `Output missing: ${missing.join(', ')}`,
      };
    }
  }

  // OR 逻辑：只要包含其中任意一个即可
  if (v.containsAny) {
    const found = v.containsAny.some((s) => {
      if (v.regex) {
        const flags = v.ignoreCase ? 'i' : '';
        return new RegExp(s, flags).test(ctx.output);
      }
      const needle = v.ignoreCase ? s.toLowerCase() : s;
      return searchOutput.includes(needle);
    });
    if (!found) {
      return {
        passed: false,
        validation: v,
        message: `Output missing any of: ${v.containsAny.slice(0, 5).join(', ')}...`,
      };
    }
  }

  if (v.notContains) {
    const found = v.notContains.filter((s) => {
      if (v.regex) {
        const flags = v.ignoreCase ? 'i' : '';
        return new RegExp(s, flags).test(ctx.output);
      }
      const needle = v.ignoreCase ? s.toLowerCase() : s;
      return searchOutput.includes(needle);
    });
    if (found.length > 0) {
      return {
        passed: false,
        validation: v,
        message: `Output contains forbidden: ${found.join(', ')}`,
      };
    }
  }

  return { passed: true, validation: v };
}

function validateOutputMatches(
  ctx: TestContext,
  v: Validation
): ValidationResult {
  const regex = new RegExp(v.target!);
  const passed = regex.test(ctx.output);

  return {
    passed,
    validation: v,
    message: passed ? undefined : `Output does not match pattern: ${v.target}`,
  };
}

function validateNoError(ctx: TestContext, v: Validation): ValidationResult {
  // 检测实际的错误模式，而不是简单的关键词匹配
  const errorPatterns = [
    /\bError:\s/i,                    // "Error: something"
    /\bERROR\b/,                       // 全大写 ERROR
    /\bfailed\b.*\bwith\b/i,          // "failed with"
    /\bcommand failed\b/i,            // "command failed"
    /\bunhandled.*error\b/i,          // "unhandled error"
    /\bfatal error\b/i,               // "fatal error"
    /\bexception\b.*\bthrown\b/i,     // "exception thrown"
    /\bpanic\b/i,                     // "panic"
    /exit code [1-9]/i,               // 非零退出码
  ];

  const foundErrors: string[] = [];
  for (const pattern of errorPatterns) {
    if (pattern.test(ctx.output)) {
      const match = ctx.output.match(pattern);
      if (match) foundErrors.push(match[0]);
    }
  }

  // 同时检查退出码
  const hasNonZeroExit = ctx.exitCode !== 0;

  const hasError = foundErrors.length > 0 || hasNonZeroExit;

  return {
    passed: !hasError,
    validation: v,
    message: hasError
      ? `Error indicators: ${foundErrors.join(', ')}${hasNonZeroExit ? ` (exit code: ${ctx.exitCode})` : ''}`
      : undefined,
  };
}

// ===== 过程验证 =====

export async function runProcessValidations(
  trace: ExecutionTrace,
  ctx: TestContext,
  validations: ProcessValidation[]
): Promise<ProcessValidationResult[]> {
  const results: ProcessValidationResult[] = [];

  for (const validation of validations) {
    const result = await runSingleProcessValidation(trace, ctx, validation);
    results.push(result);
  }

  return results;
}

async function runSingleProcessValidation(
  trace: ExecutionTrace,
  ctx: TestContext,
  validation: ProcessValidation
): Promise<ProcessValidationResult> {
  switch (validation.type) {
    case 'tool-used':
      return validateToolUsed(trace, validation);
    case 'tool-not-used':
      return validateToolNotUsed(trace, validation);
    case 'tool-sequence':
      return validateToolSequence(trace, validation);
    case 'tool-count-max':
      return validateToolCountMax(trace, validation);
    case 'tool-count-min':
      return validateToolCountMin(trace, validation);
    case 'agent-dispatched':
      return validateAgentDispatched(trace, validation);
    case 'agent-not-dispatched':
      return validateAgentNotDispatched(trace, validation);
    case 'agent-type':
      return validateAgentType(trace, validation);
    case 'no-redundant-reads':
      return validateNoRedundantReads(trace, validation);
    case 'no-blind-edit':
      return validateNoBlindEdit(trace, validation);
    case 'error-recovery':
      return validateErrorRecovery(trace, validation);
    case 'efficient-path':
      return validateEfficientPath(trace, validation);
    case 'custom-process':
      return validation.custom!(trace, ctx);
    default:
      return { passed: false, validation, message: 'Unknown validation type' };
  }
}

function getAllToolNames(trace: ExecutionTrace): string[] {
  return [...new Set(getAllToolCalls(trace).map((t) => t.name))];
}

function getAllToolCalls(trace: ExecutionTrace): ToolCall[] {
  return [
    ...trace.toolCalls,
    ...trace.agentDispatches.flatMap((a) => a.toolCalls),
  ];
}

function validateToolUsed(
  trace: ExecutionTrace,
  v: ProcessValidation
): ProcessValidationResult {
  const tools = Array.isArray(v.tool) ? v.tool : [v.tool!];
  const usedTools = getAllToolNames(trace);
  // 使用别名匹配，支持 Claude Code 和 code-agent 两种工具命名
  const missing = tools.filter((t) => !hasToolWithAlias(usedTools, t));

  return {
    passed: missing.length === 0,
    validation: v,
    message:
      missing.length > 0
        ? `Expected tools not used: ${missing.join(', ')} (actual: ${usedTools.join(', ')})`
        : undefined,
    details: { actualToolCalls: usedTools },
  };
}

function validateToolNotUsed(
  trace: ExecutionTrace,
  v: ProcessValidation
): ProcessValidationResult {
  const tools = Array.isArray(v.tool) ? v.tool : [v.tool!];
  const usedTools = getAllToolNames(trace);
  // 使用别名匹配，支持 Claude Code 和 code-agent 两种工具命名
  const forbidden = tools.filter((t) => hasToolWithAlias(usedTools, t));

  return {
    passed: forbidden.length === 0,
    validation: v,
    message:
      forbidden.length > 0
        ? `Forbidden tools were used: ${forbidden.join(', ')} (actual: ${usedTools.join(', ')})`
        : undefined,
    details: { actualToolCalls: usedTools },
  };
}

function validateToolSequence(
  trace: ExecutionTrace,
  v: ProcessValidation
): ProcessValidationResult {
  const actualSequence = trace.timeline
    .filter((e): e is ToolCall => 'name' in e && !('agentType' in e))
    .map((t) => t.name);

  // 构建支持别名的正则模式
  // 例如 'Read' 变成 '(Read|read_file)'
  const pattern = v.sequence!.map((s) => {
    if (s === '*') return '.*';
    const aliases = getToolNameWithAliases(s);
    return `(${aliases.join('|')})`;
  }).join('.*');

  const regex = new RegExp(pattern);
  const sequenceStr = actualSequence.join(',');
  const passed = regex.test(sequenceStr);

  return {
    passed,
    validation: v,
    message: passed
      ? undefined
      : `Tool sequence mismatch. Expected pattern: ${v.sequence!.join(' -> ')} (actual: ${actualSequence.join(' -> ')})`,
    details: { actualSequence },
  };
}

function validateToolCountMax(
  trace: ExecutionTrace,
  v: ProcessValidation
): ProcessValidationResult {
  let count = trace.totalToolCalls;
  if (v.toolFilter) {
    count = getAllToolCalls(trace).filter((t) => t.name === v.toolFilter).length;
  }

  return {
    passed: count <= v.count!,
    validation: v,
    message:
      count > v.count!
        ? `Too many tool calls: ${count} > ${v.count} (max)`
        : undefined,
  };
}

function validateToolCountMin(
  trace: ExecutionTrace,
  v: ProcessValidation
): ProcessValidationResult {
  let count = trace.totalToolCalls;
  if (v.toolFilter) {
    count = getAllToolCalls(trace).filter((t) => t.name === v.toolFilter).length;
  }

  return {
    passed: count >= v.count!,
    validation: v,
    message:
      count < v.count!
        ? `Too few tool calls: ${count} < ${v.count} (min)`
        : undefined,
  };
}

function validateAgentDispatched(
  trace: ExecutionTrace,
  v: ProcessValidation
): ProcessValidationResult {
  const passed = trace.agentDispatches.length > 0;
  return {
    passed,
    validation: v,
    message: passed ? undefined : 'Expected agent dispatch but none occurred',
  };
}

function validateAgentNotDispatched(
  trace: ExecutionTrace,
  v: ProcessValidation
): ProcessValidationResult {
  const passed = trace.agentDispatches.length === 0;
  return {
    passed,
    validation: v,
    message: passed
      ? undefined
      : `Expected direct execution but ${trace.agentDispatches.length} agents were dispatched`,
    details: {
      actualToolCalls: trace.agentDispatches.map((a) => `Task(${a.agentType})`),
    },
  };
}

function validateAgentType(
  trace: ExecutionTrace,
  v: ProcessValidation
): ProcessValidationResult {
  const expectedTypes = Array.isArray(v.agentType)
    ? v.agentType
    : [v.agentType!];
  // 使用大小写不敏感比较，因为测试用例可能用 'Explore' 而 code-agent 用 'explore'
  const actualTypesLower = trace.agentDispatches.map((a) => a.agentType.toLowerCase());
  const missing = expectedTypes.filter((t) => !actualTypesLower.includes(t.toLowerCase()));

  return {
    passed: missing.length === 0,
    validation: v,
    message:
      missing.length > 0
        ? `Expected agent types not used: ${missing.join(', ')}`
        : undefined,
  };
}

function validateNoRedundantReads(
  trace: ExecutionTrace,
  v: ProcessValidation
): ProcessValidationResult {
  // 支持 Read (Claude Code) 和 read_file (code-agent) 两种命名
  const readToolNames = getToolNameWithAliases('Read');
  const readCalls = getAllToolCalls(trace).filter((t) => readToolNames.includes(t.name));
  const readPaths = readCalls.map((t) => t.input.file_path || t.input.path);
  const duplicates = readPaths.filter(
    (path, i) => path && readPaths.indexOf(path) !== i
  );
  const uniqueDuplicates = [...new Set(duplicates)];

  return {
    passed: uniqueDuplicates.length === 0,
    validation: v,
    message:
      uniqueDuplicates.length > 0
        ? `Redundant file reads detected: ${uniqueDuplicates.join(', ')}`
        : undefined,
    details: { redundantOps: uniqueDuplicates },
  };
}

function validateNoBlindEdit(
  trace: ExecutionTrace,
  v: ProcessValidation
): ProcessValidationResult {
  const allCalls = getAllToolCalls(trace);
  const readPaths = new Set<string>();
  const blindEdits: string[] = [];

  // 支持两种工具命名
  const readToolNames = getToolNameWithAliases('Read');
  const editToolNames = getToolNameWithAliases('Edit');

  // 规范化路径，移除可能的临时目录前缀
  const normalizePath = (p: string): string => {
    // 提取相对路径部分 (e.g., src/utils/array.ts)
    const match = p.match(/(?:src|lib|app|components|pages|test|tests|spec|__tests__|fixtures)\/.+$/);
    return match ? match[0] : basename(p);
  };

  for (const call of allCalls) {
    if (readToolNames.includes(call.name)) {
      const path = call.input.file_path || call.input.path;
      if (path) {
        readPaths.add(path);
        readPaths.add(normalizePath(path));
      }
    } else if (editToolNames.includes(call.name)) {
      const editPath = call.input.file_path || call.input.path;
      if (editPath) {
        const normalizedEdit = normalizePath(editPath);
        // 检查原始路径或规范化路径是否被读取过
        const wasRead = readPaths.has(editPath) || readPaths.has(normalizedEdit);
        if (!wasRead) {
          blindEdits.push(editPath);
        }
      }
    }
  }

  return {
    passed: blindEdits.length === 0,
    validation: v,
    message:
      blindEdits.length > 0
        ? `Files edited without reading first: ${blindEdits.join(', ')}`
        : undefined,
    details: { inefficiencies: blindEdits },
  };
}

function validateErrorRecovery(
  trace: ExecutionTrace,
  v: ProcessValidation
): ProcessValidationResult {
  const allCalls = getAllToolCalls(trace);
  const errors = allCalls.filter((c) => c.error);

  if (errors.length === 0) {
    return { passed: true, validation: v };
  }

  const lastErrorIndex = allCalls.findIndex(
    (c) => c.id === errors[errors.length - 1].id
  );
  const hasRecoveryAttempt = lastErrorIndex < allCalls.length - 1;

  return {
    passed: hasRecoveryAttempt,
    validation: v,
    message: hasRecoveryAttempt
      ? undefined
      : 'Error occurred but no recovery attempt detected',
  };
}

function validateEfficientPath(
  trace: ExecutionTrace,
  v: ProcessValidation
): ProcessValidationResult {
  const eff = v.efficiency!;
  const issues: string[] = [];

  if (eff.maxToolCalls && trace.totalToolCalls > eff.maxToolCalls) {
    issues.push(`Tool calls: ${trace.totalToolCalls} > ${eff.maxToolCalls}`);
  }

  if (
    eff.maxAgentDispatches &&
    trace.totalAgentDispatches > eff.maxAgentDispatches
  ) {
    issues.push(
      `Agent dispatches: ${trace.totalAgentDispatches} > ${eff.maxAgentDispatches}`
    );
  }

  const redundantOps = detectRedundantOperations(trace);
  if (
    eff.maxRedundantOps !== undefined &&
    redundantOps.length > eff.maxRedundantOps
  ) {
    issues.push(
      `Redundant operations: ${redundantOps.length} > ${eff.maxRedundantOps}`
    );
  }

  return {
    passed: issues.length === 0,
    validation: v,
    message: issues.length > 0 ? issues.join('; ') : undefined,
    details: { inefficiencies: issues, redundantOps },
  };
}

function detectRedundantOperations(trace: ExecutionTrace): string[] {
  const ops: string[] = [];
  const seen = new Map<string, number>();

  for (const call of getAllToolCalls(trace)) {
    const key = `${call.name}:${JSON.stringify(call.input)}`;
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);

    if (count > 1) {
      ops.push(`${call.name}(duplicate #${count})`);
    }
  }

  return ops;
}
