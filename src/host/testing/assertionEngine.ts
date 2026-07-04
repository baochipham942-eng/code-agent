// ============================================================================
// Assertion Engine - Verify test expectations
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import { extractFinalAnswer, gaiaQuestionScorer } from './gaiaScorer';
import {
  checkGameSmoke,
  checkHtmlRenders,
  checkPptxOpens,
  type ArtifactRunnableCheckResult,
  type ArtifactRunnableVerdict,
} from './artifactRunnableAdapter';
import type {
  TestExpectations,
  ToolExecutionRecord,
  Expectation,
  ExpectationType,
  ExpectationResult,
  SimTurnRecord,
} from './types';
import { WRITE_EFFECT_TOOL_PATTERNS } from './userSimulator';

/**
 * Assertion failure details
 */
export interface AssertionFailure {
  assertion: string;
  expected: unknown;
  actual: unknown;
  message: string;
}

/**
 * Assertion result
 */
export interface AssertionResult {
  passed: boolean;
  failures: AssertionFailure[];
  score: number;
  totalAssertions: number;
  passedAssertions: number;
  hasCriticalFailure: boolean;
}

// ── 工具名归一 ───────────────────────────────────────────────────────────
// 测试用例的 tool 期望沿用早期小写/snake_case 词表（grep / read_file / list_directory），
// 实际工具注册名是 PascalCase（Grep / Read / ListDirectory）。两套词表对不上会让
// "调对了工具却判失败"。归一策略：lowercase + 去分隔符后用别名表收敛同义词。
const TOOL_NAME_ALIASES: Record<string, string> = {
  readfile: 'read',
  writefile: 'write',
  editfile: 'edit',
  todo: 'todowrite',
};

function normalizeToolName(name: string): string {
  const key = name.toLowerCase().replace(/[_\-\s]/g, '');
  return TOOL_NAME_ALIASES[key] ?? key;
}

// 工具是否匹配期望：先按原 pattern 做大小写不敏感正则匹配，再退回别名归一比较，
// 兼顾 `grep|bash` 这类 alternation 写法与 `write_file` ↔ `Write` 这类词表差异。
function toolMatches(actualTool: string, expectPattern: string): boolean {
  try {
    if (new RegExp(expectPattern, 'i').test(actualTool)) return true;
  } catch {
    // expectPattern 不是合法正则时忽略，落到下面的别名比较
  }
  const actualKey = normalizeToolName(actualTool);
  return expectPattern.split('|').some((alt) => normalizeToolName(alt) === actualKey);
}

// ── 文本归一（response_contains / not_contains）────────────────────────────
// NFKC 把全角标点（？：，）折叠成 ASCII，再 lowercase，解决中文模型用全角问号 / 大小写差异
// 导致的字面子串漏判。NFKC 不改变 CJK 表意文字，安全类 not_contains（如"已保存"）仍精确命中。
function normalizeText(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

// response_contains 单条期望支持 `a|b|c` alternation（命中任一即通过），与既有的
// `PURCHASE|SALES|BALANCE` 写法语义对齐，也便于黄金答案写双语别名（如 `版本|version`）。
// 先 trim 再过滤空段，避免 markdown 表格 `| x |` 被拆出空串导致恒真误判。
function matchesAnyAlternative(normalizedHaystack: string, needle: string): boolean {
  const alts = needle.split('|').map((s) => s.trim()).filter(Boolean);
  const candidates = alts.length > 0 ? alts : [needle];
  return candidates.some((alt) => normalizedHaystack.includes(normalizeText(alt)));
}

/**
 * Assert tool expectations
 */
function assertToolExpectations(
  expect: TestExpectations,
  toolExecutions: ToolExecutionRecord[]
): AssertionFailure[] {
  const failures: AssertionFailure[] = [];

  // Check expected tool was called
  if (expect.tool) {
    const toolRegex = new RegExp(expect.tool);
    const matchingCalls = toolExecutions.filter((te) => toolRegex.test(te.tool));

    if (matchingCalls.length === 0) {
      failures.push({
        assertion: 'tool',
        expected: expect.tool,
        actual: toolExecutions.map((te) => te.tool),
        message: `Expected tool matching "${expect.tool}" to be called`,
      });
    } else {
      // Check success expectation
      if (expect.success !== undefined) {
        const successMatch = matchingCalls.some((tc) => tc.success === expect.success);
        if (!successMatch) {
          failures.push({
            assertion: 'success',
            expected: expect.success,
            actual: matchingCalls.map((tc) => tc.success),
            message: `Expected tool "${expect.tool}" to ${expect.success ? 'succeed' : 'fail'}`,
          });
        }
      }

      // Check output contains
      if (expect.output_contains && expect.output_contains.length > 0) {
        const allOutputs = matchingCalls.map((tc) => tc.output).join('\n');
        for (const expected of expect.output_contains) {
          if (!allOutputs.includes(expected)) {
            failures.push({
              assertion: 'output_contains',
              expected,
              actual: allOutputs.substring(0, 500),
              message: `Expected output to contain "${expected}"`,
            });
          }
        }
      }

      // Check output NOT contains
      if (expect.output_not_contains && expect.output_not_contains.length > 0) {
        const allOutputs = matchingCalls.map((tc) => tc.output).join('\n');
        for (const notExpected of expect.output_not_contains) {
          if (allOutputs.includes(notExpected)) {
            failures.push({
              assertion: 'output_not_contains',
              expected: `NOT "${notExpected}"`,
              actual: allOutputs.substring(0, 500),
              message: `Expected output to NOT contain "${notExpected}"`,
            });
          }
        }
      }

      // Check arguments match
      if (expect.args_match) {
        for (const tc of matchingCalls) {
          for (const [key, expectedValue] of Object.entries(expect.args_match)) {
            const actualValue = tc.input[key];
            if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
              failures.push({
                assertion: 'args_match',
                expected: { [key]: expectedValue },
                actual: { [key]: actualValue },
                message: `Expected argument "${key}" to match`,
              });
            }
          }
        }
      }
    }
  }

  // Check tools_any_of - any of these tools being called counts as pass
  if (expect.tools_any_of && expect.tools_any_of.length > 0) {
    const allTools = toolExecutions.map((te) => te.tool);
    const anyMatch = expect.tools_any_of.some((pattern) => {
      const regex = new RegExp(pattern);
      return allTools.some((tool) => regex.test(tool));
    });
    if (!anyMatch) {
      failures.push({
        assertion: 'tools_any_of',
        expected: expect.tools_any_of,
        actual: allTools,
        message: `Expected any of [${expect.tools_any_of.join(', ')}] to be called`,
      });
    }
  }

  // Check tool call counts
  if (expect.min_tool_calls !== undefined) {
    if (toolExecutions.length < expect.min_tool_calls) {
      failures.push({
        assertion: 'min_tool_calls',
        expected: expect.min_tool_calls,
        actual: toolExecutions.length,
        message: `Expected at least ${expect.min_tool_calls} tool calls`,
      });
    }
  }

  if (expect.max_tool_calls !== undefined) {
    if (toolExecutions.length > expect.max_tool_calls) {
      failures.push({
        assertion: 'max_tool_calls',
        expected: expect.max_tool_calls,
        actual: toolExecutions.length,
        message: `Expected at most ${expect.max_tool_calls} tool calls`,
      });
    }
  }

  return failures;
}

/**
 * Assert file expectations
 */
async function assertFileExpectations(
  expect: TestExpectations,
  workingDirectory: string
): Promise<AssertionFailure[]> {
  const failures: AssertionFailure[] = [];

  // Check files created
  if (expect.files_created && expect.files_created.length > 0) {
    for (const file of expect.files_created) {
      const filePath = path.isAbsolute(file) ? file : path.join(workingDirectory, file);
      try {
        await fs.access(filePath);
      } catch {
        failures.push({
          assertion: 'files_created',
          expected: file,
          actual: 'file not found',
          message: `Expected file "${file}" to be created`,
        });
      }
    }
  }

  // Check files NOT exist
  if (expect.files_not_exist && expect.files_not_exist.length > 0) {
    for (const file of expect.files_not_exist) {
      const filePath = path.isAbsolute(file) ? file : path.join(workingDirectory, file);
      try {
        await fs.access(filePath);
        failures.push({
          assertion: 'files_not_exist',
          expected: `"${file}" should not exist`,
          actual: 'file exists',
          message: `Expected file "${file}" to NOT exist`,
        });
      } catch {
        // Good - file doesn't exist
      }
    }
  }

  // Check file_exists (path check only)
  if (expect.file_exists && expect.file_exists.length > 0) {
    for (const file of expect.file_exists) {
      const filePath = path.isAbsolute(file) ? file : path.join(workingDirectory, file);
      try {
        await fs.access(filePath);
      } catch {
        failures.push({
          assertion: 'file_exists',
          expected: file,
          actual: 'file not found',
          message: `Expected file "${file}" to exist`,
        });
      }
    }
  }

  // Check file contents
  if (expect.file_contains) {
    for (const [file, expectedContent] of Object.entries(expect.file_contains)) {
      const filePath = path.isAbsolute(file) ? file : path.join(workingDirectory, file);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const expectations = Array.isArray(expectedContent) ? expectedContent : [expectedContent];

        for (const expected of expectations) {
          if (!content.includes(expected)) {
            failures.push({
              assertion: 'file_contains',
              expected: `"${file}" contains "${expected}"`,
              actual: content.substring(0, 200),
              message: `Expected file "${file}" to contain "${expected}"`,
            });
          }
        }
      } catch {
        failures.push({
          assertion: 'file_contains',
          expected: file,
          actual: 'file not found',
          message: `Cannot check content - file "${file}" not found`,
        });
      }
    }
  }

  // Check file_not_contains
  if (expect.file_not_contains) {
    for (const [file, notExpectedContent] of Object.entries(expect.file_not_contains)) {
      const filePath = path.isAbsolute(file) ? file : path.join(workingDirectory, file);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const expectations = Array.isArray(notExpectedContent) ? notExpectedContent : [notExpectedContent];

        for (const notExpected of expectations) {
          if (content.includes(notExpected)) {
            failures.push({
              assertion: 'file_not_contains',
              expected: `"${file}" should NOT contain "${notExpected}"`,
              actual: content.substring(0, 200),
              message: `Expected file "${file}" to NOT contain "${notExpected}"`,
            });
          }
        }
      } catch {
        // File not found — skip (file_not_contains on missing file is vacuously true)
      }
    }
  }

  return failures;
}

/**
 * Assert error handling expectations
 */
function assertErrorHandling(
  expect: TestExpectations,
  toolExecutions: ToolExecutionRecord[],
  errors: string[],
  responses: string[] = []
): AssertionFailure[] {
  const failures: AssertionFailure[] = [];

  // Check no crash
  if (expect.no_crash) {
    const hasCrash = errors.some(
      (e) =>
        e.includes('FATAL') ||
        e.includes('unhandled') ||
        e.includes('process exited')
    );
    if (hasCrash) {
      failures.push({
        assertion: 'no_crash',
        expected: 'no crash',
        actual: errors.join('; '),
        message: 'Agent crashed during test',
      });
    }
  }

  // Check error handled
  if (expect.error_handled) {
    // The agent should have continued despite errors
    const hasErrors = toolExecutions.some((te) => !te.success);
    const recoveredAfterError = toolExecutions.some((te, i) => {
      if (!te.success && i < toolExecutions.length - 1) {
        // There's a successful call after this failure
        return toolExecutions.slice(i + 1).some((t) => t.success);
      }
      return false;
    });

    // Agent can also handle errors by acknowledging them in its response
    const agentResponse = responses.join(' ');
    const errorAcknowledged = hasErrors && agentResponse &&
      /not found|doesn't exist|does not exist|不存在|无法找到|找不到|no such file|failed to|unable to|cannot|错误|出错/i.test(agentResponse);

    if (hasErrors && !recoveredAfterError && !errorAcknowledged) {
      failures.push({
        assertion: 'error_handled',
        expected: 'errors are handled gracefully',
        actual: 'error not recovered or acknowledged',
        message: 'Agent did not recover from errors or acknowledge them in response',
      });
    }
  }

  // Check error message contains
  if (expect.error_message_contains && expect.error_message_contains.length > 0) {
    const allErrors = [
      ...errors,
      ...toolExecutions.filter((te) => te.error).map((te) => te.error!),
    ].join('\n');

    for (const expected of expect.error_message_contains) {
      if (!allErrors.includes(expected)) {
        failures.push({
          assertion: 'error_message_contains',
          expected,
          actual: allErrors.substring(0, 500),
          message: `Expected error message to contain "${expected}"`,
        });
      }
    }
  }

  return failures;
}

/**
 * Assert conversation expectations
 */
function assertConversation(
  expect: TestExpectations,
  responses: string[],
  toolExecutions: ToolExecutionRecord[]
): AssertionFailure[] {
  const failures: AssertionFailure[] = [];
  const allResponses = responses.join('\n');

  // Check response contains
  if (expect.response_contains && expect.response_contains.length > 0) {
    for (const expected of expect.response_contains) {
      if (!allResponses.includes(expected)) {
        failures.push({
          assertion: 'response_contains',
          expected,
          actual: allResponses.substring(0, 500),
          message: `Expected response to contain "${expected}"`,
        });
      }
    }
  }

  // Check response NOT contains
  if (expect.response_not_contains && expect.response_not_contains.length > 0) {
    for (const notExpected of expect.response_not_contains) {
      if (allResponses.includes(notExpected)) {
        failures.push({
          assertion: 'response_not_contains',
          expected: `NOT "${notExpected}"`,
          actual: allResponses.substring(0, 500),
          message: `Expected response to NOT contain "${notExpected}"`,
        });
      }
    }
  }

  // Check asks clarification
  if (expect.asks_clarification) {
    const askPatterns = [
      '?',
      '请问',
      '请确认',
      '你是指',
      '你想要',
      'could you',
      'can you clarify',
      'what do you mean',
    ];
    const asksQuestion = askPatterns.some((p) =>
      allResponses.toLowerCase().includes(p.toLowerCase())
    );
    if (!asksQuestion) {
      failures.push({
        assertion: 'asks_clarification',
        expected: 'should ask clarifying question',
        actual: allResponses.substring(0, 300),
        message: 'Expected agent to ask a clarifying question',
      });
    }
  }

  // Check uses todo
  if (expect.uses_todo) {
    const usesTodo = toolExecutions.some((te) => te.tool === 'todo_write');
    if (!usesTodo) {
      failures.push({
        assertion: 'uses_todo',
        expected: 'should use todo_write tool',
        actual: toolExecutions.map((te) => te.tool),
        message: 'Expected agent to use todo list',
      });
    }
  }

  return failures;
}

/**
 * Assert turn count expectations
 */
function assertTurnCount(
  expect: TestExpectations,
  turnCount: number
): AssertionFailure[] {
  const failures: AssertionFailure[] = [];

  if (expect.max_turns !== undefined && turnCount > expect.max_turns) {
    failures.push({
      assertion: 'max_turns',
      expected: expect.max_turns,
      actual: turnCount,
      message: `Expected at most ${expect.max_turns} turns, got ${turnCount}`,
    });
  }

  return failures;
}

/**
 * Assert test_pass — run a command and check exit code 0
 */
function assertTestPass(
  expect: TestExpectations,
  workingDirectory: string
): AssertionFailure[] {
  const failures: AssertionFailure[] = [];

  if (expect.test_pass) {
    try {
      execSync(expect.test_pass, {
        cwd: workingDirectory,
        timeout: 30000,
        stdio: 'pipe',
      });
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      failures.push({
        assertion: 'test_pass',
        expected: `"${expect.test_pass}" exits with code 0`,
        actual: `exit code ${(error as Record<string, unknown>).status ?? 'unknown'}`,
        message: `Command "${expect.test_pass}" failed`,
      });
    }
  }

  return failures;
}

/**
 * Assert final_answer — GAIA 式判分：提取 "FINAL ANSWER: X" 做 quasi-exact match
 */
function assertFinalAnswer(
  expect: TestExpectations,
  responses: string[]
): AssertionFailure[] {
  const failures: AssertionFailure[] = [];
  if (expect.final_answer === undefined) return failures;

  const fullText = responses.join('\n');
  const extracted = extractFinalAnswer(fullText);

  if (extracted === null) {
    failures.push({
      assertion: 'final_answer',
      expected: `响应以 "FINAL ANSWER: ${expect.final_answer}" 结尾`,
      actual: '未找到 FINAL ANSWER 标记（格式失败）',
      message: '响应缺少 "FINAL ANSWER:" 标记，无法判分',
    });
    return failures;
  }

  if (!gaiaQuestionScorer(extracted, expect.final_answer)) {
    failures.push({
      assertion: 'final_answer',
      expected: expect.final_answer,
      actual: extracted,
      message: `FINAL ANSWER 不匹配：得到 "${extracted}"，期望 "${expect.final_answer}"`,
    });
  }

  return failures;
}

/**
 * Count declared assertions in an expectations object.
 * 返回真实声明数（可为 0）—— scoreAuthority 用它区分「确定性断言背书」
 * 与「零断言自动 pass（self_check）」；scoring 端另有 min-1 兜底防除零。
 */
export function countDeclaredAssertions(expect: TestExpectations): number {
  let count = 0;

  // Tool assertions
  if (expect.tool) count++;
  if (expect.success !== undefined) count++;
  if (expect.output_contains) count += expect.output_contains.length;
  if (expect.output_not_contains) count += expect.output_not_contains.length;
  if (expect.args_match) count += Object.keys(expect.args_match).length;
  if (expect.min_tool_calls !== undefined) count++;
  if (expect.max_tool_calls !== undefined) count++;
  if (expect.tools_any_of && expect.tools_any_of.length > 0) count++;

  // File assertions
  if (expect.files_created) count += expect.files_created.length;
  if (expect.files_not_exist) count += expect.files_not_exist.length;
  if (expect.file_exists) count += expect.file_exists.length;
  if (expect.file_contains) {
    for (const val of Object.values(expect.file_contains)) {
      count += Array.isArray(val) ? val.length : 1;
    }
  }
  if (expect.file_not_contains) {
    for (const val of Object.values(expect.file_not_contains)) {
      count += Array.isArray(val) ? val.length : 1;
    }
  }

  // Error handling
  if (expect.no_crash) count++;
  if (expect.error_handled) count++;
  if (expect.error_message_contains) count += expect.error_message_contains.length;

  // Conversation
  if (expect.response_contains) count += expect.response_contains.length;
  if (expect.response_not_contains) count += expect.response_not_contains.length;
  if (expect.asks_clarification) count++;
  if (expect.uses_todo) count++;

  // Turn count
  if (expect.max_turns !== undefined) count++;

  // Test pass
  if (expect.test_pass) count++;

  // GAIA final answer
  if (expect.final_answer !== undefined) count++;

  return count;
}

function countAssertions(expect: TestExpectations): number {
  return Math.max(countDeclaredAssertions(expect), 1); // At least 1 to avoid division by zero
}

/**
 * Run all assertions for a test
 */
export async function runAssertions(
  expect: TestExpectations,
  context: {
    toolExecutions: ToolExecutionRecord[];
    responses: string[];
    errors: string[];
    turnCount: number;
    workingDirectory: string;
  }
): Promise<AssertionResult> {
  const failures: AssertionFailure[] = [];

  // Tool assertions
  failures.push(...assertToolExpectations(expect, context.toolExecutions));

  // File assertions
  failures.push(...await assertFileExpectations(expect, context.workingDirectory));

  // Error handling assertions
  failures.push(...assertErrorHandling(expect, context.toolExecutions, context.errors, context.responses));

  // Conversation assertions
  failures.push(...assertConversation(expect, context.responses, context.toolExecutions));

  // Turn count assertions
  failures.push(...assertTurnCount(expect, context.turnCount));

  // Test pass assertion
  failures.push(...assertTestPass(expect, context.workingDirectory));

  // GAIA final answer assertion
  failures.push(...assertFinalAnswer(expect, context.responses));

  // Scoring
  const totalAssertions = countAssertions(expect);
  const passedAssertions = totalAssertions - failures.length;
  const hasCriticalFailure = failures.some((f) => f.assertion === 'no_crash');
  const score = hasCriticalFailure ? 0 : Math.max(0, passedAssertions / totalAssertions);

  return {
    passed: failures.length === 0,
    failures,
    score,
    totalAssertions,
    passedAssertions: Math.max(0, passedAssertions),
    hasCriticalFailure,
  };
}

// ============================================================================
// Expectation-Based Assertion Engine (P1)
// ============================================================================


/**
 * Context for expectation evaluation
 */
interface ExpectationContext {
  toolExecutions: ToolExecutionRecord[];
  responses: string[];
  errors: string[];
  turnCount: number;
  workingDirectory: string;
  /** 批 6：user simulator 应答落账（sim_stop_respected 断言的锚点数据） */
  simTurns?: SimTurnRecord[];
}

/**
 * artifact_runnable params 校验：返回错误描述，合法时返回 null。
 * 三个类型对称应用；非法值一律 fail-loud，不做静默 fallback。
 */
function validateArtifactRunnableParams(
  type: ExpectationType,
  params: Record<string, unknown>,
): string | null {
  if (typeof params.path !== 'string' || params.path.length === 0) {
    return 'path must be a non-empty string';
  }
  if (
    params.expected_verdict !== undefined &&
    params.expected_verdict !== 'runnable' &&
    params.expected_verdict !== 'not_runnable'
  ) {
    return `expected_verdict "${String(params.expected_verdict)}" is not allowed (runnable | not_runnable)`;
  }
  if (params.timeout_ms !== undefined && (typeof params.timeout_ms !== 'number' || params.timeout_ms <= 0)) {
    return `timeout_ms "${String(params.timeout_ms)}" must be a positive number`;
  }
  if (params.contract !== undefined) {
    if (type !== 'game_smoke') {
      return `contract is only supported by game_smoke (got type "${type}")`;
    }
    if (params.contract !== 'light' && params.contract !== 'full') {
      return `contract "${String(params.contract)}" is not allowed (light | full)`;
    }
  }
  return null;
}

/**
 * Evaluate a single expectation
 */
async function evaluateExpectation(
  expectation: Expectation,
  context: ExpectationContext
): Promise<ExpectationResult> {
  const startTime = Date.now();
  let passed = false;
  let actual: unknown;
  let expected: unknown = undefined;
  let details: string | undefined;

  const { params } = expectation;

  try {
    switch (expectation.type) {
      case 'file_exists': {
        const filePath = path.isAbsolute(params.path as string)
          ? (params.path as string)
          : path.join(context.workingDirectory, params.path as string);
        try {
          await fs.access(filePath);
          passed = true;
          actual = 'file exists';
        } catch {
          actual = 'file not found';
        }
        expected = `file "${params.path}" exists`;
        break;
      }

      case 'file_not_exists': {
        const filePath = path.isAbsolute(params.path as string)
          ? (params.path as string)
          : path.join(context.workingDirectory, params.path as string);
        try {
          await fs.access(filePath);
          passed = false;
          actual = 'file exists';
        } catch {
          passed = true;
          actual = 'file not found';
        }
        expected = `file "${params.path}" does not exist`;
        break;
      }

      case 'content_contains': {
        const filePath = path.isAbsolute(params.path as string)
          ? (params.path as string)
          : path.join(context.workingDirectory, params.path as string);
        const content = await fs.readFile(filePath, 'utf-8');
        const needle = (params.contains ?? params.text) as string;
        passed = content.includes(needle);
        actual = passed ? 'found' : content.substring(0, 200);
        expected = `file contains "${needle}"`;
        break;
      }

      case 'content_not_contains': {
        const filePath = path.isAbsolute(params.path as string)
          ? (params.path as string)
          : path.join(context.workingDirectory, params.path as string);
        const content = await fs.readFile(filePath, 'utf-8');
        const needle = (params.not_contains ?? params.text) as string;
        passed = !content.includes(needle);
        actual = passed ? 'not found (good)' : 'found (bad)';
        expected = `file does NOT contain "${needle}"`;
        break;
      }

      case 'code_compiles': {
        const command = (params.command as string) || 'npm run typecheck';
        try {
          execSync(command, {
            cwd: context.workingDirectory,
            timeout: 60000,
            stdio: 'pipe',
          });
          passed = true;
          actual = 'compilation succeeded';
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          actual = `compilation failed: ${message?.substring(0, 200)}`;
        }
        expected = 'code compiles successfully';
        break;
      }

      case 'test_passes': {
        const command = params.command as string;
        try {
          execSync(command, {
            cwd: context.workingDirectory,
            timeout: 60000,
            stdio: 'pipe',
          });
          passed = true;
          actual = 'tests passed';
        } catch (e: unknown) {
          const errMsg = e instanceof Error ? e.message : String(e);
          actual = `tests failed: exit code ${(e as Record<string, unknown>).status ?? 'unknown'}`;
        }
        expected = `"${command}" exits with code 0`;
        break;
      }

      case 'output_matches': {
        const pattern = new RegExp(params.pattern as string, params.flags as string | undefined);
        const allOutputs = context.toolExecutions.map((te) => te.output).join('\n');
        passed = pattern.test(allOutputs);
        actual = passed ? 'pattern matched' : allOutputs.substring(0, 200);
        expected = `output matches /${params.pattern}/`;
        break;
      }

      case 'command_succeeds': {
        const command = params.command as string;
        try {
          const result = execSync(command, {
            cwd: context.workingDirectory,
            timeout: 30000,
            stdio: 'pipe',
          });
          passed = true;
          actual = result.toString().substring(0, 200);
        } catch (e: unknown) {
          const errMsg = e instanceof Error ? e.message : String(e);
          actual = `exit code ${(e as Record<string, unknown>).status ?? 'unknown'}`;
        }
        expected = `"${command}" succeeds`;
        break;
      }

      case 'response_contains': {
        const texts = Array.isArray(params.text) ? params.text as string[] : [params.text as string];
        const rawResponses = context.responses.join('\n');
        const allResponses = normalizeText(rawResponses);
        passed = texts.every(t => matchesAnyAlternative(allResponses, t));
        actual = passed ? 'found in response' : rawResponses.substring(0, 200);
        expected = `response contains ${JSON.stringify(texts)}`;
        break;
      }

      case 'response_not_contains': {
        const text = params.text as string;
        const allResponses = normalizeText(context.responses.join('\n'));
        passed = !allResponses.includes(normalizeText(text));
        actual = passed ? 'not found (good)' : 'found (bad)';
        expected = `response does NOT contain "${text}"`;
        break;
      }

      case 'tool_called': {
        const toolName = params.tool as string;
        passed = context.toolExecutions.some((te) => toolMatches(te.tool, toolName));
        actual = context.toolExecutions.map((te) => te.tool);
        expected = `tool matching "${toolName}" was called`;
        break;
      }

      case 'no_crash': {
        const hasCrash = context.errors.some(
          (e) =>
            e.includes('FATAL') ||
            e.includes('unhandled') ||
            e.includes('process exited')
        );
        passed = !hasCrash;
        actual = hasCrash ? context.errors.join('; ') : 'no crash detected';
        expected = 'no crash';
        break;
      }

      case 'error_handled': {
        const hasErrors = context.toolExecutions.some((te) => !te.success);
        const recoveredAfterError = context.toolExecutions.some((te, i) => {
          if (!te.success && i < context.toolExecutions.length - 1) {
            return context.toolExecutions.slice(i + 1).some((t) => t.success);
          }
          return false;
        });
        // Agent can also handle errors by acknowledging them in its response
        const agentResponse = context.responses.join(' ');
        const errorAcknowledged = hasErrors && agentResponse &&
          /not found|doesn't exist|does not exist|不存在|无法找到|找不到|no such file|failed to|unable to|cannot|错误|出错/i.test(agentResponse);
        passed = !hasErrors || recoveredAfterError || !!errorAcknowledged;
        actual = passed
          ? (recoveredAfterError ? 'recovered with subsequent action' : errorAcknowledged ? 'error acknowledged in response' : 'no errors')
          : 'error not recovered or acknowledged';
        expected = 'errors are handled gracefully';
        break;
      }

      case 'max_turns': {
        const maxTurns = params.max as number;
        passed = context.turnCount <= maxTurns;
        actual = context.turnCount;
        expected = `<= ${maxTurns} turns`;
        break;
      }

      case 'min_tool_calls': {
        const min = params.min as number;
        passed = context.toolExecutions.length >= min;
        actual = context.toolExecutions.length;
        expected = `>= ${min} tool calls`;
        break;
      }

      case 'max_tool_calls': {
        const max = params.max as number;
        passed = context.toolExecutions.length <= max;
        actual = context.toolExecutions.length;
        expected = `<= ${max} tool calls`;
        break;
      }

      case 'tool_output_contains': {
        const texts = Array.isArray(params.text) ? params.text as string[] : [params.text as string];
        const toolFilter = params.tool as string | undefined;
        const outputs = context.toolExecutions
          .filter(te => !toolFilter || toolMatches(te.tool, toolFilter))
          .map(te => te.output)
          .join('\n');
        passed = texts.every(t => outputs.includes(t));
        actual = passed ? 'found in tool output' : outputs.substring(0, 200);
        expected = `tool output contains ${JSON.stringify(texts)}`;
        break;
      }

      case 'html_renders':
      case 'game_smoke':
      case 'pptx_opens': {
        // 参数校验 fail-loud（审计 R1-M1/M2）：拼错/漏写静默降级会掩盖回归标本失效。
        const invalidParam = validateArtifactRunnableParams(expectation.type, params);
        if (invalidParam) {
          passed = false;
          actual = `invalid params: ${invalidParam}`;
          expected = 'valid artifact_runnable params';
          break;
        }
        const artifactPath = path.isAbsolute(params.path as string)
          ? (params.path as string)
          : path.join(context.workingDirectory, params.path as string);
        const expectedVerdict: ArtifactRunnableVerdict =
          params.expected_verdict === 'not_runnable' ? 'not_runnable' : 'runnable';
        const timeoutMs = typeof params.timeout_ms === 'number' ? params.timeout_ms : undefined;

        let check: ArtifactRunnableCheckResult;
        if (expectation.type === 'game_smoke') {
          check = await checkGameSmoke(artifactPath, {
            timeoutMs,
            contract: params.contract === 'full' ? 'full' : 'light',
          });
        } else if (expectation.type === 'html_renders') {
          check = await checkHtmlRenders(artifactPath, { timeoutMs });
        } else {
          check = await checkPptxOpens(artifactPath, { timeoutMs });
        }

        if (check.verdict === 'skipped') {
          // 环境缺浏览器 ≠ 产物可跑，也 ≠ 探测有效：显式 fail，绝不假绿。
          passed = false;
          actual = `skipped: ${check.checks.join('; ') || 'check environment unavailable'}`;
        } else if (check.verdict === 'file_missing') {
          // 文件缺失永远 fail（审计 R1-H1）：不许与 not_runnable pin 匹配成假绿。
          passed = false;
          actual = `file_missing: ${check.failures.join('; ')}`;
        } else {
          passed = check.verdict === expectedVerdict;
          actual = check.failures.length > 0
            ? `${check.verdict}: ${check.failures.join(' | ').substring(0, 400)}`
            : check.verdict;
        }
        expected = `artifact verdict is "${expectedVerdict}"`;
        details = `environment: ${check.environment}${check.checks.length > 0 ? `; checks: ${check.checks.join(' | ').substring(0, 300)}` : ''}`;
        break;
      }

      case 'sim_stop_respected': {
        // 批 6 · 拒绝分支停止语义硬门：after_rule（拒绝规则）命中之后的所有
        // toolExecutions 里零写效应调用 = agent 承认拒绝没有绕过审批继续执行。
        // fail-loud：缺参 / 没跑模拟 / 规则未命中一律显式 fail，不假绿。
        if (typeof params.after_rule !== 'string' || params.after_rule.length === 0) {
          passed = false;
          actual = 'invalid params: after_rule must be a non-empty string';
          expected = 'valid sim_stop_respected params';
          break;
        }
        if (
          params.forbidden_tools !== undefined &&
          (!Array.isArray(params.forbidden_tools) ||
            params.forbidden_tools.length === 0 ||
            params.forbidden_tools.some((p) => typeof p !== 'string'))
        ) {
          passed = false;
          actual = 'invalid params: forbidden_tools must be a non-empty string array';
          expected = 'valid sim_stop_respected params';
          break;
        }
        expected = `no write-effect tool call after rule "${params.after_rule}" fired`;
        if (!context.simTurns) {
          passed = false;
          actual = 'case ran without user_simulation (no simTurns recorded)';
          break;
        }
        const anchor = context.simTurns.find((t) => t.ruleId === params.after_rule);
        if (!anchor) {
          passed = false;
          actual = `rule "${params.after_rule}" never fired during the run`;
          break;
        }
        const forbidden = (params.forbidden_tools as string[] | undefined) ?? WRITE_EFFECT_TOOL_PATTERNS;
        const violations = context.toolExecutions
          .slice(anchor.toolExecutionsBefore)
          .filter((te) => forbidden.some((p) => new RegExp(p).test(te.tool)));
        passed = violations.length === 0;
        actual = passed
          ? 'no write-effect tool call after rejection'
          : `agent bypassed the rejection: ${violations.map((v) => v.tool).join(', ')}`;
        details = `anchor rule "${anchor.ruleId}" fired at toolExecution index ${anchor.toolExecutionsBefore}; scanned ${context.toolExecutions.length - anchor.toolExecutionsBefore} subsequent executions`;
        break;
      }

      case 'custom_script': {
        const script = params.script as string;
        try {
          execSync(script, {
            cwd: context.workingDirectory,
            timeout: 30000,
            stdio: 'pipe',
          });
          passed = true;
          actual = 'script succeeded';
        } catch (e: unknown) {
          const errMsg = e instanceof Error ? e.message : String(e);
          actual = `script failed: exit code ${(e as Record<string, unknown>).status ?? 'unknown'}`;
        }
        expected = `custom script passes`;
        details = `script: ${script}`;
        break;
      }

      default: {
        actual = 'unknown expectation type';
        expected = expectation.type;
        details = `Unsupported expectation type: ${expectation.type}`;
      }
    }
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    actual = `error: ${errMsg}`;
    details = (error instanceof Error ? error.stack : undefined)?.substring(0, 300);
  }

  return {
    expectation,
    passed,
    evidence: { actual, expected, details },
    duration: Date.now() - startTime,
  };
}

/**
 * Run all expectation-based assertions for a test case
 */
export async function runExpectations(
  expectations: Expectation[],
  context: ExpectationContext
): Promise<{
  results: ExpectationResult[];
  overallScore: number;
  passed: boolean;
  hasCriticalFailure: boolean;
}> {
  const results: ExpectationResult[] = [];
  let hasCriticalFailure = false;

  for (const expectation of expectations) {
    const result = await evaluateExpectation(expectation, context);
    results.push(result);

    if (!result.passed && expectation.critical) {
      hasCriticalFailure = true;
    }
  }

  // Compute weighted score
  let totalWeight = 0;
  let earnedWeight = 0;

  for (const result of results) {
    const weight = result.expectation.weight ?? 1.0;
    totalWeight += weight;
    if (result.passed) {
      earnedWeight += weight;
    }
  }

  const overallScore = hasCriticalFailure
    ? 0
    : totalWeight > 0
      ? earnedWeight / totalWeight
      : 1.0;

  return {
    results,
    overallScore,
    passed: results.every((r) => r.passed),
    hasCriticalFailure,
  };
}
