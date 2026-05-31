import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { classifyPermission, getPermissionClassifier } from '../../../src/main/tools/permissionClassifier';

describe('PermissionClassifier', () => {
  beforeEach(() => {
    getPermissionClassifier().clearCache();
  });

  it('asks before reading Claude global memory files', async () => {
    const result = await classifyPermission(
      'Read',
      { file_path: '~/.claude/context/memory/global/daily/2026-04-20.md' },
      { workingDirectory: '/tmp/comate-zulu-demo', permissionLevel: 'read' },
    );

    expect(result.decision).toBe('ask');
    expect(result.reason).toContain('私人记忆目录');
  });

  it('asks before reading Codex memory files', async () => {
    const result = await classifyPermission(
      'Read',
      { file_path: '~/.codex/memories/soul.md lines 1-40' },
      { workingDirectory: '/tmp/comate-zulu-demo', permissionLevel: 'read' },
    );

    expect(result.decision).toBe('ask');
    expect(result.reason).toContain('.codex/memories');
  });

  it('still auto-approves normal project reads', async () => {
    const result = await classifyPermission(
      'Read',
      { file_path: 'README.md' },
      { workingDirectory: '/tmp/comate-zulu-demo', permissionLevel: 'read' },
    );

    expect(result.decision).toBe('approve');
    expect(result.reason).toContain('只读工具');
  });

  it('asks before running package-manager commands that may mutate dependencies or run scripts', async () => {
    const result = await classifyPermission(
      'bash',
      { command: 'npm install lodash' },
      { workingDirectory: '/tmp/comate-zulu-demo', permissionLevel: 'execute' },
    );

    expect(result.decision).toBe('ask');
    expect(result.reason).toContain('包管理器命令');
    expect(result.traceStep?.rule).toBe('B3: package_manager');
  });

  it('does not reuse a safe npm-run cache decision for a different package script', async () => {
    const safe = await classifyPermission(
      'bash',
      { command: 'npm run typecheck' },
      { workingDirectory: '/tmp/comate-zulu-demo', permissionLevel: 'execute' },
    );
    const risky = await classifyPermission(
      'bash',
      { command: 'npm run postinstall' },
      { workingDirectory: '/tmp/comate-zulu-demo', permissionLevel: 'execute' },
    );

    expect(safe.decision).toBe('approve');
    expect(risky.decision).toBe('ask');
    expect(risky.cached).toBe(false);
  });
});
