// ============================================================================
// Assertion Engine Tests - 断言引擎单元测试
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { runAssertions } from '../../../src/main/testing/assertionEngine';
import type { TestExpectations, ToolExecutionRecord } from '../../../src/main/testing/types';

// ---- Helper: 构造最小 ToolExecutionRecord ----
function makeTool(overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return {
    tool: 'bash',
    input: {},
    output: '',
    success: true,
    duration: 100,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ---- Helper: 默认 context ----
function makeContext(overrides: Partial<{
  toolExecutions: ToolExecutionRecord[];
  responses: string[];
  errors: string[];
  turnCount: number;
  workingDirectory: string;
}> = {}) {
  return {
    toolExecutions: [],
    responses: [],
    errors: [],
    turnCount: 1,
    workingDirectory: '/tmp/assertion-engine-test',
    ...overrides,
  };
}

// ---- 测试用临时目录 ----
const TEST_DIR = '/tmp/assertion-engine-test';

beforeAll(async () => {
  await fs.mkdir(TEST_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
});

// ============================================================================
// 1. file_exists 断言
// ============================================================================
describe('file_exists 断言', () => {
  it('文件存在时通过', async () => {
    const filePath = path.join(TEST_DIR, 'exists-test.txt');
    await fs.writeFile(filePath, 'hello');

    const expectations: TestExpectations = {
      file_exists: ['exists-test.txt'],
    };

    const result = await runAssertions(expectations, makeContext());

    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
    expect(result.failures).toHaveLength(0);
  });

  it('文件不存在时失败', async () => {
    const expectations: TestExpectations = {
      file_exists: ['no-such-file-xyz.txt'],
    };

    const result = await runAssertions(expectations, makeContext());

    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].assertion).toBe('file_exists');
  });

  it('多文件部分存在时得部分分', async () => {
    await fs.writeFile(path.join(TEST_DIR, 'a.txt'), 'a');

    const expectations: TestExpectations = {
      file_exists: ['a.txt', 'b-not-exist.txt'],
    };

    const result = await runAssertions(expectations, makeContext());

    expect(result.passed).toBe(false);
    expect(result.score).toBe(0.5);
    expect(result.totalAssertions).toBe(2);
    expect(result.passedAssertions).toBe(1);
  });
});

// ============================================================================
// 2. file_not_contains 断言
// ============================================================================
describe('file_not_contains 断言', () => {
  it('文件不包含指定内容时通过', async () => {
    await fs.writeFile(path.join(TEST_DIR, 'clean.ts'), 'const config = loadConfig();');

    const expectations: TestExpectations = {
      file_not_contains: { 'clean.ts': 'hardcoded_password' },
    };

    const result = await runAssertions(expectations, makeContext());

    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
  });

  it('文件包含禁止内容时失败', async () => {
    await fs.writeFile(path.join(TEST_DIR, 'dirty.ts'), 'const pw = "hardcoded_password";');

    const expectations: TestExpectations = {
      file_not_contains: { 'dirty.ts': 'hardcoded_password' },
    };

    const result = await runAssertions(expectations, makeContext());

    expect(result.passed).toBe(false);
    expect(result.failures[0].assertion).toBe('file_not_contains');
  });

  it('多项检查时分别计分', async () => {
    await fs.writeFile(path.join(TEST_DIR, 'mixed.ts'), 'const key = "SECRET_KEY"; const safe = true;');

    const expectations: TestExpectations = {
      file_not_contains: { 'mixed.ts': ['SECRET_KEY', 'dangerous_func'] },
    };

    const result = await runAssertions(expectations, makeContext());

    expect(result.passed).toBe(false);
    expect(result.totalAssertions).toBe(2);
    expect(result.passedAssertions).toBe(1); // dangerous_func 不存在 → pass
    expect(result.score).toBe(0.5);
  });

  it('文件不存在时 vacuously true', async () => {
    const expectations: TestExpectations = {
      file_not_contains: { 'ghost-file.ts': 'anything' },
    };

    const result = await runAssertions(expectations, makeContext());

    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
  });
});

// ============================================================================
// 3. test_pass 断言
// ============================================================================
describe('test_pass 断言', () => {
  it('命令成功时通过', async () => {
    const expectations: TestExpectations = {
      test_pass: 'true',
    };

    const result = await runAssertions(expectations, makeContext());

    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
  });

  it('命令失败时记录失败', async () => {
    const expectations: TestExpectations = {
      test_pass: 'false',
    };

    const result = await runAssertions(expectations, makeContext());

    expect(result.passed).toBe(false);
    expect(result.failures[0].assertion).toBe('test_pass');
    expect(result.score).toBe(0);
  });

  it('命令不存在时失败', async () => {
    const expectations: TestExpectations = {
      test_pass: 'nonexistent-command-xyz-12345',
    };

    const result = await runAssertions(expectations, makeContext());

    expect(result.passed).toBe(false);
    expect(result.failures[0].assertion).toBe('test_pass');
  });
});

// ============================================================================
// 4. tools_any_of 断言
// ============================================================================
describe('tools_any_of 断言', () => {
  it('匹配任一工具时通过', async () => {
    const expectations: TestExpectations = {
      tools_any_of: ['bash', 'list_directory', 'glob'],
    };

    const ctx = makeContext({
      toolExecutions: [makeTool({ tool: 'read_file' }), makeTool({ tool: 'glob' })],
    });

    const result = await runAssertions(expectations, ctx);

    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
  });

  it('无工具匹配时失败', async () => {
    const expectations: TestExpectations = {
      tools_any_of: ['bash', 'list_directory'],
    };

    const ctx = makeContext({
      toolExecutions: [makeTool({ tool: 'read_file' })],
    });

    const result = await runAssertions(expectations, ctx);

    expect(result.passed).toBe(false);
    expect(result.failures[0].assertion).toBe('tools_any_of');
  });

  it('支持 regex 匹配', async () => {
    const expectations: TestExpectations = {
      tools_any_of: ['bash|shell', 'write.*'],
    };

    const ctx = makeContext({
      toolExecutions: [makeTool({ tool: 'write_file' })],
    });

    const result = await runAssertions(expectations, ctx);

    expect(result.passed).toBe(true);
  });

  it('无工具调用时失败', async () => {
    const expectations: TestExpectations = {
      tools_any_of: ['bash'],
    };

    const result = await runAssertions(expectations, makeContext());

    expect(result.passed).toBe(false);
  });
});

// ============================================================================
// 5. 计分逻辑 + 部分分
// ============================================================================
describe('计分逻辑', () => {
  it('全部通过 → score = 1.0', async () => {
    await fs.writeFile(path.join(TEST_DIR, 'score-test.txt'), 'hello world');

    const expectations: TestExpectations = {
      file_exists: ['score-test.txt'],
      file_contains: { 'score-test.txt': 'hello' },
    };

    const result = await runAssertions(expectations, makeContext());

    expect(result.score).toBe(1.0);
    expect(result.passed).toBe(true);
    expect(result.totalAssertions).toBe(2);
    expect(result.passedAssertions).toBe(2);
    expect(result.hasCriticalFailure).toBe(false);
  });

  it('部分通过 → 0 < score < 1', async () => {
    await fs.writeFile(path.join(TEST_DIR, 'partial.txt'), 'abc');

    const expectations: TestExpectations = {
      file_exists: ['partial.txt'],
      file_contains: { 'partial.txt': ['abc', 'xyz'] },
      response_contains: ['something'],
    };

    const ctx = makeContext({ responses: ['something is here'] });

    const result = await runAssertions(expectations, ctx);

    // file_exists(1) + file_contains('abc')(1) + file_contains('xyz')(fail) + response_contains(1) = 3/4
    expect(result.totalAssertions).toBe(4);
    expect(result.passedAssertions).toBe(3);
    expect(result.score).toBeCloseTo(0.75);
  });

  it('no_crash 失败 → hasCriticalFailure → score = 0', async () => {
    const expectations: TestExpectations = {
      no_crash: true,
      response_contains: ['ok'],
    };

    const ctx = makeContext({
      responses: ['ok'],
      errors: ['FATAL: process crashed'],
    });

    const result = await runAssertions(expectations, ctx);

    expect(result.hasCriticalFailure).toBe(true);
    expect(result.score).toBe(0);
    expect(result.failures).toHaveLength(1); // no_crash 失败, response_contains 通过
  });

  it('空 expect → score = 1.0 (vacuous truth)', async () => {
    const expectations: TestExpectations = {};

    const result = await runAssertions(expectations, makeContext());

    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
    expect(result.totalAssertions).toBe(1); // 最小值保底
  });
});

// ============================================================================
// 6. countAssertions 覆盖度 (间接测试)
// ============================================================================
describe('countAssertions 覆盖所有字段', () => {
  it('包含所有断言类型时正确计数', async () => {
    const expectations: TestExpectations = {
      // Tool: 1(tool) + 1(success) + 2(output_contains) + 1(output_not_contains) + 1(min_tool_calls) + 1(tools_any_of) = 7
      tool: 'bash',
      success: true,
      output_contains: ['a', 'b'],
      output_not_contains: ['c'],
      min_tool_calls: 1,
      tools_any_of: ['bash'],
      // File: 1(files_created) + 1(file_exists) + 2(file_contains) + 1(file_not_contains) = 5
      files_created: ['f1.txt'],
      file_exists: ['f2.txt'],
      file_contains: { 'f1.txt': ['x', 'y'] },
      file_not_contains: { 'f2.txt': 'z' },
      // Error: 1(no_crash) + 1(error_handled) = 2
      no_crash: true,
      error_handled: true,
      // Conversation: 1(response_contains) + 1(response_not_contains) + 1(asks_clarification) = 3
      response_contains: ['resp'],
      response_not_contains: ['bad'],
      asks_clarification: true,
      // Turn: 1
      max_turns: 5,
      // Test pass: 1
      test_pass: 'true',
    };

    const ctx = makeContext({
      toolExecutions: [makeTool({ tool: 'bash', output: 'a b' })],
      responses: ['resp 你是指?'],
      turnCount: 3,
    });

    const result = await runAssertions(expectations, ctx);

    // 7 + 5 + 2 + 3 + 1 + 1 = 19
    expect(result.totalAssertions).toBe(19);
  });
});
