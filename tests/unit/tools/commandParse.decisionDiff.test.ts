import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadApprovalTables, runApprovalEval, type ApprovalRow } from '../../../packages/internal/evaluation-center/scripts/lib/approval-eval';
import { isKnownSafeCommand } from '../../../src/host/security/commandSafety';
import { parseShellCommand } from '../../../src/host/security/commandParse';
import { PermissionClassifier } from '../../../src/host/tools/permissionClassifier';

// The same side-effect-free runner used by the cross-checkout diff calls the real executor.
// Assertions include the shortcut itself: a later credential guard cannot hide its regression.
const expectations = [
  ['dangerous-fork-bomb', 'deny', 'Security: Command blocked - Fork bomb detected'],
  ['dangerous-command-cat-ssh-key', 'ask', '读取凭据路径需要用户确认'],
  ['dangerous-chmod-work-redirect', 'deny', 'Denied: 危险命令: 危险权限变更'],
  ['dangerous-assignment-path-ls', 'ask', 'Execute shell command'],
  ['dangerous-assignment-ld-preload', 'ask', 'Execute shell command'],
  ['dangerous-bash-script-c', 'ask', 'Execute shell command'],
  ['injection-bash-process-subst', 'deny', 'Denied: 命令策略拒绝: 通过进程替换执行远程脚本'],
  ['injection-nice-git-remote', 'ask', '修改 git 远端配置'],
] as const;

describe('phase three decision drift regressions', () => {
  let rows: ApprovalRow[];
  beforeAll(async () => {
    const ids = new Set<string>(expectations.map(([id]) => id));
    const tables = loadApprovalTables(path.resolve(__dirname, '../../fixtures/approval-eval'))
      .map((table) => ({ ...table, cases: table.cases.filter((item) => ids.has(item.id)) }));
    rows = await runApprovalEval({ tables });
  }, 120_000);

  it.each(expectations)('restores baseline: %s', (id, actual, reason) => {
    const row = rows.find((item) => item.id === id);
    expect(row).toBeDefined();
    expect(row?.isKnownSafeCommand).toBe(false);
    expect(row?.actual).toBe(actual);
    expect(row?.reason).toContain(reason);
    if (id === 'dangerous-bash-script-c') expect(row?.riskLevel).toBe('unknown');
  });

  it.each(['ls', 'env ls', 'bash -c "ls"'])('keeps previously safe identity: %s', (command) => {
    expect(isKnownSafeCommand(command)).toBe(true);
  });

  it.each(['PATH=./bin ls', 'LD_PRELOAD=/tmp/evil.so ls', 'env PATH=./bin ls',
    'env -S "LD_PRELOAD=/tmp/evil.so ls"', 'bash -c "PATH=./bin ls"'])(
    'retains execution-changing assignments through wrappers: %s', (command) => {
      expect(parseShellCommand(command).executions[0].environmentAssignments).toHaveLength(1);
      expect(isKnownSafeCommand(command)).toBe(false);
    },
  );

  it('keeps assigned write targets and unknown launchers fail closed', () => {
    expect(parseShellCommand('MODE=1 tee src/x.ts').writeTargets.map((target) => target.path)).toContain('src/x.ts');
    expect(isKnownSafeCommand('some-wrapper bash -c "ls"')).toBe(false);
    expect(parseShellCommand('sudo --unknown-option tee src/x.ts').parsingFailed).toBe(true);
  });

  it('dangerous segments win over redirection while ordinary writes still ask', async () => {
    for (const command of ['chmod -R 777 ./data', 'chmod -R 777 ./data > run.log',
      'echo ok > run.log; chmod -R 777 ./data', 'chmod -R 777 ./data; echo ok > run.log']) {
      const result = await new PermissionClassifier({ enableLlm: false }).classify(
        'Bash', { command }, { workingDirectory: '/tmp', permissionLevel: 'execute' },
      );
      expect(result.decision).toBe('deny');
      expect(result.reason).toBe('危险命令: 危险权限变更');
    }
    const result = await new PermissionClassifier({ enableLlm: false }).classify(
      'Bash', { command: 'echo ok > run.log' }, { workingDirectory: '/tmp', permissionLevel: 'execute' },
    );
    expect(result.decision).toBe('ask');
  });
});
