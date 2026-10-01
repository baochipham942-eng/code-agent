// ============================================================================
// Script Executor Tests — GAP-014: additionalContext / CC 兼容协议解析
// ============================================================================

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const spillTestRoot = path.join(os.tmpdir(), `neo-hook-outputbudget-test-${process.pid}`);
const spillState = vi.hoisted(() => ({ fail: false }));

vi.mock('../../../src/host/config/configPaths', async () => {
  const osMod = await import('os');
  const pathMod = await import('path');
  return {
    getUserConfigDir: () => pathMod.join(osMod.tmpdir(), `neo-hook-outputbudget-test-${process.pid}`),
  };
});

vi.mock('../../../src/host/utils/toolResultSpill', async (importOriginal) => {
  type SpillModule = typeof import('../../../src/host/utils/toolResultSpill');
  const actual = await importOriginal<SpillModule>();
  return {
    ...actual,
    spillToolResultArchive: (options: Parameters<SpillModule['spillToolResultArchive']>[0]) => (
      spillState.fail ? null : actual.spillToolResultArchive(options)
    ),
  };
});

import { executeScript } from '../../../src/host/hooks/scriptExecutor';
import type { HookExecutionResult, ToolHookContext } from '../../../src/host/protocol/events';
import { estimateTokens } from '../../../src/host/context/tokenEstimator';
import { HOOK_OUTPUT_BUDGET, TOOL_RESULT_SPILL } from '../../../src/shared/constants';

function buildPostToolContext(): ToolHookContext {
  return {
    event: 'PostToolUse',
    sessionId: 'test-session',
    timestamp: Date.now(),
    workingDirectory: process.cwd(),
    toolName: 'write_file',
    toolInput: '{"file_path": "/tmp/test.ts"}',
    toolOutput: 'File written',
  };
}

function buildSessionStartContext() {
  return {
    event: 'SessionStart' as const,
    sessionId: 'test-session',
    timestamp: Date.now(),
    workingDirectory: process.cwd(),
  };
}

function readSpilledHookOutput(): string {
  const dir = path.join(spillTestRoot, 'tmp', 'test-session', 'tool-results');
  const files = fs.readdirSync(dir).filter((file) => file.endsWith('.txt'));
  expect(files).toHaveLength(1);
  return fs.readFileSync(path.join(dir, files[0]), 'utf-8');
}

function buildOutputScript(output: string, exitCode = 0, stream: 'stdout' | 'stderr' = 'stdout') {
  fs.mkdirSync(spillTestRoot, { recursive: true });
  const outputFile = path.join(spillTestRoot, 'hook-script-output.txt');
  fs.writeFileSync(outputFile, output, 'utf-8');
  return {
    command: `node -e 'process.${stream}.write(require("fs").readFileSync(process.env.HOOK_TEST_OUTPUT)); process.exitCode = ${exitCode}'`,
    env: { HOOK_TEST_OUTPUT: outputFile },
  };
}

function expectBudgetedOutput(result: HookExecutionResult, fullOutput: string): void {
  expect(result.message).toBeDefined();
  const message = result.message!;
  const markerIndex = message.indexOf(TOOL_RESULT_SPILL.NOTICE_MARKER);
  expect(markerIndex).toBeGreaterThan(0);
  const preview = message.slice(0, markerIndex);
  const notice = message.slice(markerIndex);
  expect(estimateTokens(preview)).toBeLessThanOrEqual(HOOK_OUTPUT_BUDGET.DEFAULT_TOKENS);
  expect(estimateTokens(message)).toBeLessThanOrEqual(
    HOOK_OUTPUT_BUDGET.DEFAULT_TOKENS + estimateTokens(notice),
  );
  expect(message.split(TOOL_RESULT_SPILL.NOTICE_MARKER)).toHaveLength(2);
  expect(readSpilledHookOutput()).toBe(fullOutput);
}

function buildLargeOutput(): string {
  const head = 'HOOK-OUTPUT-HEAD\n';
  const tail = '\nHOOK-OUTPUT-TAIL';
  const row = 'hook preview words '.repeat(5) + '\n';
  const middleSize = 200000 - head.length - tail.length;
  return head + row.repeat(Math.ceil(middleSize / row.length)).slice(0, middleSize) + tail;
}

describe('executeScript output parsing', () => {
  beforeEach(() => {
    spillState.fail = false;
    fs.rmSync(spillTestRoot, { recursive: true, force: true });
  });

  afterAll(() => {
    fs.rmSync(spillTestRoot, { recursive: true, force: true });
  });

  it('treats plain text stdout as an allow message', async () => {
    const result = await executeScript(
      { command: `echo "lint passed"` },
      buildPostToolContext(),
    );

    expect(result.action).toBe('allow');
    expect(result.message).toBe('lint passed');
  });

  it('parses legacy JSON action/message format', async () => {
    const result = await executeScript(
      { command: `echo '{"action": "block", "message": "stop right there"}'` },
      buildPostToolContext(),
    );

    expect(result.action).toBe('block');
    expect(result.message).toBe('stop right there');
  });

  it('maps top-level additionalContext to message (GAP-014)', async () => {
    const result = await executeScript(
      { command: `echo '{"additionalContext": "lint failed: missing semicolon at line 3"}'` },
      buildPostToolContext(),
    );

    expect(result.action).toBe('allow');
    expect(result.message).toBe('lint failed: missing semicolon at line 3');
  });

  it('maps Claude Code hookSpecificOutput.additionalContext to message (GAP-014)', async () => {
    const result = await executeScript(
      {
        command: `echo '{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "type error in foo.ts"}}'`,
      },
      buildPostToolContext(),
    );

    expect(result.action).toBe('allow');
    expect(result.message).toBe('type error in foo.ts');
  });

  it('maps Claude Code decision/reason format to block (GAP-014)', async () => {
    const result = await executeScript(
      { command: `echo '{"decision": "block", "reason": "tests are failing"}'` },
      buildPostToolContext(),
    );

    expect(result.action).toBe('block');
    expect(result.message).toBe('tests are failing');
  });

  it('prefers explicit message over additionalContext when both present', async () => {
    const result = await executeScript(
      { command: `echo '{"message": "primary", "additionalContext": "secondary"}'` },
      buildPostToolContext(),
    );

    expect(result.message).toBe('primary');
  });

  it('treats exit code 1 with stdout as block (lint failure pattern)', async () => {
    const result = await executeScript(
      { command: `bash -c 'echo "3 lint errors found"; exit 1'` },
      buildPostToolContext(),
    );

    expect(result.action).toBe('block');
    expect(result.message).toBe('3 lint errors found');
  });

  it('blocks exit code 2 using stderr instead of stdout', async () => {
    const result = await executeScript(
      { command: `bash -c 'echo "stdout is not the reason"; echo "blocked by policy" >&2; exit 2'` },
      buildPostToolContext(),
    );

    expect(result.action).toBe('block');
    expect(result.message).toBe('blocked by policy');
  });

  it.each([1, 2, 3])('keeps explicit JSON decisions above exit %s', async (code) => {
    const result = await executeScript(
      { command: `echo '{"action":"continue","modifiedInput":"safe"}'; exit ${code}` },
      buildPostToolContext(),
    );
    expect(result.action).toBe('continue');
    expect(result.modifiedInput).toBe('safe');
  });

  it('does not let arbitrary JSON allow a failing script', async () => {
    const result = await executeScript(
      { command: `echo '{"message":"diagnostic"}'; exit 3` }, buildPostToolContext(),
    );
    expect(result.action).toBe('error');
  });

  it('does not let a non-string action smuggle past a failing exit code', async () => {
    const result = await executeScript(
      { command: `echo '{"action":["block"]}'; exit 1` }, buildPostToolContext(),
    );
    expect(result.action).toBe('block');
  });

  it('returns allow with no message for empty stdout', async () => {
    const result = await executeScript(
      { command: 'true' },
      buildPostToolContext(),
    );

    expect(result.action).toBe('allow');
    expect(result.message).toBeUndefined();
  });

  it('spills and budgets 200 KB plain stdout on PostToolUse', async () => {
    const output = buildLargeOutput();
    const result = await executeScript(
      buildOutputScript(output),
      buildPostToolContext(),
    );

    expect(result.action).toBe('allow');
    expect(result.message!.length).toBeLessThan(output.length / 2);
    expectBudgetedOutput(result, output);
    expect(result.message).toContain('HOOK-OUTPUT-HEAD');
    expect(result.message).toContain('HOOK-OUTPUT-TAIL');
  });

  it.each([
    ['message', 'block'],
    ['additionalContext', 'continue'],
    ['nested additionalContext', 'continue'],
    ['reason', 'block'],
  ])('spills and budgets oversize JSON %s without changing action', async (field, action) => {
    const output = buildLargeOutput();
    const json = field === 'reason'
      ? { decision: 'block', reason: output }
      : field === 'nested additionalContext'
        ? { action, hookSpecificOutput: { additionalContext: output } }
        : { action, [field]: output };
    const result = await executeScript(buildOutputScript(JSON.stringify(json)), buildPostToolContext());

    expect(result.action).toBe(action);
    expectBudgetedOutput(result, output);
  });

  it('uses the larger SessionStart budget while PostToolUse truncates', async () => {
    const output = 'word '.repeat(8000).trim();
    const options = buildOutputScript(output);
    const sessionStart = await executeScript(options, buildSessionStartContext());
    const postTool = await executeScript(options, buildPostToolContext());

    expect(estimateTokens(sessionStart.message!)).toBeGreaterThan(HOOK_OUTPUT_BUDGET.DEFAULT_TOKENS);
    expect(estimateTokens(output)).toBeLessThanOrEqual(HOOK_OUTPUT_BUDGET.SESSION_START_TOKENS);
    expect(sessionStart.message).toBe(output);
    expectBudgetedOutput(postTool, output);
  });

  it('falls back to a plain truncation marker when spilling fails', async () => {
    spillState.fail = true;
    const output = buildLargeOutput();
    const result = await executeScript(
      buildOutputScript(output),
      buildPostToolContext(),
    );

    expect(result.action).toBe('allow');
    const marker = `[hook output truncated to ${HOOK_OUTPUT_BUDGET.DEFAULT_TOKENS} tokens]`;
    expect(result.message).toContain(marker);
    expect(result.message).not.toContain(TOOL_RESULT_SPILL.NOTICE_MARKER);
    expect(estimateTokens(result.message!)).toBeLessThanOrEqual(
      HOOK_OUTPUT_BUDGET.DEFAULT_TOKENS + estimateTokens(marker),
    );
    expect(result.message).toContain('HOOK-OUTPUT-HEAD');
    expect(result.message).toContain('HOOK-OUTPUT-TAIL');
    expect(fs.existsSync(path.join(spillTestRoot, 'tmp'))).toBe(false);
  });

  it('budgets oversize stdout on exit code 1 while preserving block action', async () => {
    const output = buildLargeOutput();
    const result = await executeScript(
      buildOutputScript(output, 1),
      buildPostToolContext(),
    );

    expect(result.action).toBe('block');
    expectBudgetedOutput(result, output);
  });

  it.each([1, 2])('budgets oversize block stream on exit code %s while preserving block action', async (code) => {
    const output = buildLargeOutput();
    const stream = code === 1 ? 'stdout' : 'stderr';
    const result = await executeScript(buildOutputScript(output, code, stream), buildPostToolContext());

    expect(result.action).toBe('block');
    expectBudgetedOutput(result, output);
  });

  it('budgets an explicit JSON decision on a nonzero exit', async () => {
    const output = buildLargeOutput();
    const result = await executeScript(
      buildOutputScript(JSON.stringify({ action: 'continue', message: output }), 2),
      buildPostToolContext(),
    );

    expect(result.action).toBe('continue');
    expectBudgetedOutput(result, output);
  });

  it.each(['message', 'additionalContext'])('preserves under-budget JSON %s byte-identically', async (field) => {
    const output = '  unicode 中文 🚀\n\tspacing  \n';
    const result = await executeScript(
      buildOutputScript(JSON.stringify({ [field]: output })),
      buildPostToolContext(),
    );

    expect(result.message).toBe(output);
    expect(fs.existsSync(path.join(spillTestRoot, 'tmp'))).toBe(false);
  });
});
