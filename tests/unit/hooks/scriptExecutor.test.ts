// ============================================================================
// Script Executor Tests — GAP-014: additionalContext / CC 兼容协议解析
// ============================================================================

import { describe, it, expect } from 'vitest';
import { executeScript } from '../../../src/main/hooks/scriptExecutor';
import type { ToolHookContext } from '../../../src/main/protocol/events';

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

describe('executeScript output parsing', () => {
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

  it('treats exit code 2 with stdout as continue with message', async () => {
    const result = await executeScript(
      { command: `bash -c 'echo "proceed with caution"; exit 2'` },
      buildPostToolContext(),
    );

    expect(result.action).toBe('continue');
    expect(result.message).toBe('proceed with caution');
  });

  it('returns allow with no message for empty stdout', async () => {
    const result = await executeScript(
      { command: 'true' },
      buildPostToolContext(),
    );

    expect(result.action).toBe('allow');
    expect(result.message).toBeUndefined();
  });
});
