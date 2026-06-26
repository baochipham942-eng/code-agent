import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { classifyPermission, getPermissionClassifier } from '../../../src/host/tools/permissionClassifier';
import { setCommandPolicyRulesForTest } from '../../../src/host/tools/modules/shell/commandPolicy';

describe('PermissionClassifier', () => {
  beforeEach(() => {
    getPermissionClassifier().clearCache();
    setCommandPolicyRulesForTest([]);
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

  it('auto-approves internal delegation tools', async () => {
    for (const toolName of ['Task', 'spawn_agent', 'AgentSpawn']) {
      const result = await classifyPermission(
        toolName,
        { prompt: 'return ok', subagent_type: 'coder' },
        { workingDirectory: '/tmp/comate-zulu-demo', permissionLevel: 'execute' },
      );

      expect(result.decision).toBe('approve');
      expect(result.reason).toContain('内部委派工具');
    }
  });

  it('auto-approves Process observation actions but asks for control actions', async () => {
    const observation = await classifyPermission(
      'Process',
      { action: 'list' },
      { workingDirectory: '/tmp/comate-zulu-demo', permissionLevel: 'execute' },
    );
    const control = await classifyPermission(
      'Process',
      { action: 'kill', session_id: 'task-1' },
      { workingDirectory: '/tmp/comate-zulu-demo', permissionLevel: 'execute' },
    );

    expect(observation.decision).toBe('approve');
    expect(observation.reason).toContain('观察类');
    expect(control.decision).toBe('ask');
    expect(control.reason).toContain('控制类');
  });

  it('honors command policy DSL deny before allow', async () => {
    setCommandPolicyRulesForTest([
      { action: 'allow', kind: 'prefix', pattern: 'npm' },
      { action: 'deny', kind: 'exact', pattern: 'npm install lodash' },
    ]);

    const result = await classifyPermission(
      'bash',
      { command: 'npm install lodash' },
      { workingDirectory: '/tmp/comate-zulu-demo', permissionLevel: 'execute' },
    );

    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('User command policy denied');
  });

  it('does not let a user allow rule override command hard blocks', async () => {
    setCommandPolicyRulesForTest([{ action: 'allow', kind: 'glob', pattern: '*' }]);

    const result = await classifyPermission(
      'bash',
      { command: ':(){ :|:& };:' },
      { workingDirectory: '/tmp/comate-zulu-demo', permissionLevel: 'execute' },
    );

    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('Fork bomb');
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

  describe('dangerous rm — long/short/mixed flags all deny', () => {
    it.each([
      'rm -rf /',
      'rm -fr /',
      'rm --recursive --force /',
      'rm --recursive /',
      'rm -r --force /',
      'rm -rf ~',
      'rm --recursive ~/Library',
      'rm --recursive --force *',
    ])('denies: %s', async (command) => {
      const result = await classifyPermission(
        'bash',
        { command },
        { workingDirectory: '/tmp/comate-zulu-demo', permissionLevel: 'execute' },
      );
      expect(result.decision).toBe('deny');
    });
  });
});
