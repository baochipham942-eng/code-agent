// ============================================================================
// Assertion Engine - Verify test expectations
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import type {
  TestExpectations,
  ToolExecutionRecord,
} from './types';

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
  errors: string[]
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

    if (!hasErrors && !recoveredAfterError) {
      // No errors to handle - this might be OK
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
    } catch (error: any) {
      failures.push({
        assertion: 'test_pass',
        expected: `"${expect.test_pass}" exits with code 0`,
        actual: `exit code ${error.status ?? 'unknown'}`,
        message: `Command "${expect.test_pass}" failed`,
      });
    }
  }

  return failures;
}

/**
 * Count total assertions in an expectations object
 */
function countAssertions(expect: TestExpectations): number {
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

  return Math.max(count, 1); // At least 1 to avoid division by zero
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
  failures.push(...assertErrorHandling(expect, context.toolExecutions, context.errors));

  // Conversation assertions
  failures.push(...assertConversation(expect, context.responses, context.toolExecutions));

  // Turn count assertions
  failures.push(...assertTurnCount(expect, context.turnCount));

  // Test pass assertion
  failures.push(...assertTestPass(expect, context.workingDirectory));

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
