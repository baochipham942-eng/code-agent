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
import type { ToolHookContext } from '../../../src/host/protocol/events';
import { estimateTokens } from '../../../src/host/context/tokenEstimator';
import { HOOK_OUTPUT_BUDGET } from '../../../src/shared/constants';

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
    const result = await executeScript(
      { command: `node -e 'process.stdout.write("x".repeat(200000))'` },
      buildPostToolContext(),
    );

    expect(result.action).toBe('allow');
    expect(result.message!.length).toBeLessThan(30000);
    expect(result.message).toContain('[Full output saved to:');
    expect(estimateTokens(result.message!.split('\n[Full output saved to:')[0])).toBeLessThanOrEqual(
      HOOK_OUTPUT_BUDGET.DEFAULT_TOKENS + 20,
    );
    expect(readSpilledHookOutput()).toBe('x'.repeat(200000));
  });

  it.each([
    ['message', `node -e 'process.stdout.write(JSON.stringify({action:"block",message:"x".repeat(200000)}))'`, 'block'],
    ['additionalContext', `node -e 'process.stdout.write(JSON.stringify({action:"continue",additionalContext:"x".repeat(200000)}))'`, 'continue'],
  ])('spills and budgets oversize JSON %s without changing action', async (_field, command, action) => {
    const result = await executeScript({ command }, buildPostToolContext());

    expect(result.action).toBe(action);
    expect(result.message).toContain('[Full output saved to:');
    expect(readSpilledHookOutput()).toContain('x'.repeat(200000));
  });

  it('uses the larger SessionStart budget while PostToolUse truncates', async () => {
    const command = `node -e 'process.stdout.write("word ".repeat(8000))'`;
    const sessionStart = await executeScript({ command }, buildSessionStartContext());
    const postTool = await executeScript({ command }, buildPostToolContext());

    expect(estimateTokens(sessionStart.message!)).toBeGreaterThan(HOOK_OUTPUT_BUDGET.DEFAULT_TOKENS);
    expect(sessionStart.message).toBe('word '.repeat(8000).trim());
    expect(postTool.message).toContain('[Full output saved to:');
    expect(estimateTokens(postTool.message!.split('\n[Full output saved to:')[0])).toBeLessThanOrEqual(
      HOOK_OUTPUT_BUDGET.DEFAULT_TOKENS + 20,
    );
  });

  it('falls back to a plain truncation marker when spilling fails', async () => {
    spillState.fail = true;
    const result = await executeScript(
      { command: `node -e 'process.stdout.write("x".repeat(200000))'` },
      buildPostToolContext(),
    );

    expect(result.action).toBe('allow');
    expect(result.message).toContain(`[hook output truncated to ${HOOK_OUTPUT_BUDGET.DEFAULT_TOKENS} tokens]`);
    expect(result.message).not.toContain('[Full output saved to:');
  });

  it('budgets oversize stdout on exit code 1 while preserving block action', async () => {
    const result = await executeScript(
      { command: `bash -c "node -e 'process.stdout.write(String.fromCharCode(120).repeat(200000))'; exit 1"` },
      buildPostToolContext(),
    );

    expect(result.action).toBe('block');
    expect(result.message).toContain('[Full output saved to:');
    expect(readSpilledHookOutput()).toBe('x'.repeat(200000));
  });
});
