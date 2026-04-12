// ============================================================================
// Bash Tool Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bashTool } from '../../../../src/main/tools/shell/bash';
import type { ToolContext } from '../../../../src/main/tools/toolRegistry';

// Mock heavy dependencies that are irrelevant to bash core logic
vi.mock('../../../../src/main/tools/shell/dynamicDescription', () => ({
  generateBashDescription: () => Promise.resolve(null),
}));

vi.mock('../../../../src/main/tools/dataFingerprint', () => ({
  extractBashFacts: () => null,
  dataFingerprintStore: { recordFact: () => {} },
}));

vi.mock('../../../../src/main/services/codex/codexSandbox', () => ({
  isCodexSandboxEnabled: () => false,
  runInCodexSandbox: () => Promise.resolve({ success: false }),
}));

vi.mock('../../../../src/main/security/commandSafety', () => ({
  isKnownSafeCommand: () => true,
}));

vi.mock('../../../../src/main/services/infra/shellEnvironment', () => ({
  getShellPath: () => process.env.PATH,
}));

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

const cwd = process.cwd();

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDirectory: cwd,
    ...overrides,
  } as ToolContext;
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('bash tool', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('executes simple command and returns output', async () => {
    const result = await bashTool.execute(
      { command: 'echo "hello"' },
      makeContext()
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('hello');
  });

  it('returns error info for non-zero exit code', async () => {
    const result = await bashTool.execute(
      { command: 'exit 1' },
      makeContext()
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('respects timeout parameter', async () => {
    const result = await bashTool.execute(
      { command: 'sleep 100', timeout: 1000 },
      makeContext()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  }, 10000);

  it('captures stderr output', async () => {
    const result = await bashTool.execute(
      { command: 'echo "err" >&2' },
      makeContext()
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('[stderr]');
    expect(result.output).toContain('err');
  });

  it('handles empty command gracefully', async () => {
    // An empty string passed to bash -c is a no-op that succeeds with no output.
    // The tool should still return successfully (bash itself does not error).
    const result = await bashTool.execute(
      { command: '' },
      makeContext()
    );

    // Empty command: bash executes successfully but produces no meaningful output
    // (only the cwd prefix line). Either outcome is acceptable — the key is no crash.
    expect(result).toBeDefined();
    expect(typeof result.success).toBe('boolean');
  });

  it('includes cwd prefix in output for model consumption', async () => {
    const result = await bashTool.execute(
      { command: 'echo "test"' },
      makeContext()
    );

    expect(result.success).toBe(true);
    // Output should start with [cwd: ...] prefix to anchor model's path awareness
    expect(result.output).toMatch(/\[cwd: .+\]/);
  });
});
