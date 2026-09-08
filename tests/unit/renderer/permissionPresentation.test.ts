import { describe, expect, it } from 'vitest';
import { PermissionRequestReason } from '../../../src/shared/contract/permission';
import type { PermissionRequest } from '../../../src/renderer/components/PermissionDialog/types';
import { permissionConsequence, permissionSummary, isSafeDefaultDeny } from '../../../src/renderer/components/PermissionDialog/permissionPresentation';
import { decisionCardZh } from '../../../src/renderer/i18n/decisionCard';

const baseRequest: PermissionRequest = {
  id: 'permission-test',
  sessionId: 'session-test',
  tool: 'Read',
  type: 'file_read',
  details: { path: '/workspace/README.md' },
};

describe('isSafeDefaultDeny', () => {
  it.each<{
    name: string;
    request: PermissionRequest;
    expected: boolean;
  }>([
    {
      name: '工作区内写入保持允许为默认动作',
      request: {
        ...baseRequest,
        tool: 'Write',
        type: 'file_write',
        boundary: { id: 'file.project_write' },
      },
      expected: false,
    },
    {
      name: '工作区外写入默认拒绝',
      request: {
        ...baseRequest,
        tool: 'Write',
        type: 'file_write',
        boundary: { id: 'file.external_write' },
      },
      expected: true,
    },
    {
      name: '工作区外普通读取不升级为安全默认拒绝',
      request: {
        ...baseRequest,
        boundary: { id: 'file.external_read' },
      },
      expected: false,
    },
    {
      name: '文件删除默认拒绝',
      request: { ...baseRequest, tool: 'Delete', type: 'file_delete' },
      expected: true,
    },
    {
      name: '删除安全标记默认拒绝',
      request: {
        ...baseRequest,
        tool: 'Bash',
        type: 'command',
        details: { command: 'custom-clean', commandSecurityFlags: ['sudo_rm'] },
      },
      expected: true,
    },
    {
      name: 'rm -rf 命令默认拒绝',
      request: {
        ...baseRequest,
        tool: 'Bash',
        type: 'command',
        details: { command: 'rm -rf ./dist' },
      },
      expected: true,
    },
    {
      name: 'high 风险命令默认拒绝',
      request: {
        ...baseRequest,
        tool: 'Bash',
        type: 'command',
        details: { command: 'deploy', commandRiskLevel: 'high' },
      },
      expected: true,
    },
    {
      name: 'critical 风险命令默认拒绝',
      request: {
        ...baseRequest,
        tool: 'Bash',
        type: 'command',
        details: { command: 'sudo command', commandRiskLevel: 'critical' },
      },
      expected: true,
    },
    {
      name: 'warning 显式风险默认拒绝',
      request: { ...baseRequest, dangerLevel: 'warning' },
      expected: true,
    },
    {
      name: 'danger 显式风险默认拒绝',
      request: { ...baseRequest, dangerLevel: 'danger' },
      expected: true,
    },
    {
      name: 'medium 普通命令保持允许为默认动作',
      request: {
        ...baseRequest,
        tool: 'Bash',
        type: 'command',
        details: { command: 'npm test', commandRiskLevel: 'medium' },
      },
      expected: false,
    },
    {
      name: '工作区内普通读取保持允许为默认动作',
      request: baseRequest,
      expected: false,
    },
  ])('$name', ({ request, expected }) => {
    expect(isSafeDefaultDeny(request)).toBe(expected);
  });
});

it('describes unknown command risk without calling it safe', () => {
  const request: PermissionRequest = {
    ...baseRequest,
    tool: 'Bash',
    type: 'command',
    details: { command: './bin/kill -9 12345', commandRiskLevel: 'unknown' },
  };

  expect(permissionConsequence(request, decisionCardZh as never)).toBe('命令风险无法自动判定，需要你确认后才能执行。');
});

it('shows the deterministic command guard reason instead of generic local-risk copy', () => {
  const request: PermissionRequest = {
    ...baseRequest,
    tool: 'Bash',
    type: 'command',
    reason: 'git push 会写入远端，需要用户确认',
    details: { command: 'git push origin feature-x', commandRiskLevel: 'safe' },
    decisionTrace: {
      toolName: 'Bash',
      finalOutcome: 'ask',
      steps: [{
        timestamp: Date.now(),
        layer: 'permission_classifier',
        rule: 'B1: git_remote_or_credential_write',
        result: 'ask',
        reason: 'git push 会写入远端，需要用户确认',
        durationMs: 0,
      }],
      totalDurationMs: 0,
    },
  };

  expect(permissionConsequence(request, decisionCardZh as never)).toBe('命令将写入 Git 远端或远端/凭据配置，需要你确认。');
});

it.each([
  ['git push --force origin main', 'B1: git_remote_or_credential_write'],
  ['chmod 777 ~/.ssh/id_rsa', 'B1: sensitive_credential_read'],
])('keeps high-risk copy primary when %s also matches a deterministic guard', (command, rule) => {
  const request: PermissionRequest = {
    ...baseRequest,
    tool: 'Bash',
    type: 'dangerous_command',
    reason: 'high-risk reason；deterministic supplement',
    details: { command, commandRiskLevel: 'high' },
    decisionTrace: {
      toolName: 'Bash',
      finalOutcome: 'ask',
      steps: [{
        timestamp: Date.now(),
        layer: 'permission_classifier',
        rule,
        result: 'ask',
        reason: 'deterministic supplement',
        durationMs: 0,
      }],
      totalDurationMs: 0,
    },
  };

  expect(permissionConsequence(request, decisionCardZh as never)).toBe('将执行高风险命令，可能覆盖本机系统或项目状态。');
  expect(request.reason).toContain('deterministic supplement');
});

describe('device / special path copy', () => {
  const zh = decisionCardZh as never;

  function writeRequest(
    path: string,
    targetKind?: PermissionRequest['details']['targetKind'],
  ): PermissionRequest {
    return {
      ...baseRequest,
      tool: 'Write',
      type: 'file_write',
      details: { path, ...(targetKind ? { targetKind } : {}) },
      boundary: { id: 'file.external_write' },
    };
  }

  it('titles /dev/null with the full path instead of a bare null basename', () => {
    const request: PermissionRequest = {
      ...baseRequest,
      tool: 'Edit',
      type: 'file_edit',
      details: { path: '/dev/null' },
      boundary: { id: 'file.external_write' },
    };

    const summary = permissionSummary(request, zh);
    expect(summary).toBe('允许编辑 /dev/null（工作区外）？');
    expect(summary).not.toBe('允许编辑 null（工作区外）？');
  });

  it('host-marked device uses the device copy and skips overwrite wording', () => {
    const request = writeRequest('/dev/null', 'device');
    const consequence = permissionConsequence(request, zh);
    expect(consequence).toBe('将向工作区外的设备文件 /dev/null 写入；原子写入会替换该设备节点本身。');
    expect(consequence).toContain('设备文件');
    expect(consequence).not.toContain('可能覆盖现有内容');
  });

  it('host-marked device inside the workspace uses the in-workspace device copy', () => {
    const request: PermissionRequest = {
      ...baseRequest,
      tool: 'Edit',
      type: 'file_edit',
      details: { path: '/dev/null', targetKind: 'device' },
      boundary: { id: 'file.project_write' },
    };
    expect(permissionConsequence(request, zh)).toBe('将写入设备文件 /dev/null；原子写入会替换该设备节点本身。');
  });

  it('Append to a host-marked device shows the write-through copy, not node replacement', () => {
    const request = { ...writeRequest('/dev/null', 'device'), tool: 'Append' };
    const consequence = permissionConsequence(request, zh);
    expect(consequence).toBe('将向设备文件 /dev/null 追加写入，内容直接送达设备。');
    expect(consequence).not.toContain('替换该设备节点');
    expect(consequence).not.toContain('可能覆盖现有内容');
  });

  it.each(['regular', 'unknown', undefined] as const)(
    'targetKind %s fail-closes to the overwrite warning',
    (targetKind) => {
      const request = writeRequest('/dev/null', targetKind);
      const consequence = permissionConsequence(request, zh);
      expect(consequence).toContain('可能覆盖现有内容');
      expect(consequence).not.toContain('设备文件');
    },
  );

  // ai-review #1692 四轮构造法：渲染层不得从原始路径推断设备。
  it.each([
    ['/dev/shm/report.md', '前缀'],
    ['NUL', '裸 Windows 保留名'],
    ['\\dev\\null', '反斜杠归一化'],
    ['C:/dev/null', 'Windows /dev/null 归一化'],
  ])('POSIX/Windows 构造 %s（%s）无 targetKind=device 时必须保留覆盖警告', (path) => {
    const consequence = permissionConsequence(writeRequest(path), zh);
    expect(consequence).toContain('可能覆盖现有内容');
    expect(consequence).not.toContain('设备文件');
  });

  it('titles /dev/stdout with the full path and does not infer a device from the path', () => {
    const request = writeRequest('/dev/stdout');
    expect(permissionSummary(request, zh)).toBe('允许写入 /dev/stdout（工作区外）？');
    expect(permissionConsequence(request, zh)).toContain('可能覆盖现有内容');
    expect(permissionConsequence(request, zh)).not.toContain('设备文件');
  });

  it('keeps basename titles and overwrite wording for ordinary files', () => {
    const inside: PermissionRequest = {
      ...baseRequest,
      tool: 'Edit',
      type: 'file_edit',
      details: { path: '/workspace/src/report.md' },
      boundary: { id: 'file.project_write' },
    };
    expect(permissionSummary(inside, zh)).toBe('允许编辑 report.md？');
    expect(permissionConsequence(inside, zh)).toBe('将写入 /workspace/src/report.md（约 1 个文件），可能覆盖现有内容。');

    const outside: PermissionRequest = {
      ...baseRequest,
      tool: 'Write',
      type: 'file_write',
      details: { path: '/tmp/notes.txt' },
      boundary: { id: 'file.external_write' },
    };
    expect(permissionSummary(outside, zh)).toBe('允许写入 notes.txt（工作区外）？');
    expect(permissionConsequence(outside, zh)).toBe('将在工作区外写入 /tmp/notes.txt（约 1 个文件），可能覆盖现有内容。');
  });

  it('still titles an ordinary file named null by basename', () => {
    const request: PermissionRequest = {
      ...baseRequest,
      tool: 'Edit',
      type: 'file_edit',
      details: { path: '/workspace/src/null' },
      boundary: { id: 'file.project_write' },
    };
    expect(permissionSummary(request, zh)).toBe('允许编辑 null？');
    expect(permissionConsequence(request, zh)).toContain('可能覆盖现有内容');
  });

  it('uncertain write target with a path deny uses the dedicated ask copy', () => {
    const request: PermissionRequest = {
      ...baseRequest,
      tool: 'Bash',
      type: 'command',
      reasonCode: PermissionRequestReason.UncertainWriteTargetWithPathDeny,
      details: { command: 'echo x > "$SSHDIR/authorized_keys"' },
    };
    expect(permissionSummary(request, zh)).toBe('这条命令说不清会写到哪个文件，而你设过禁止写入的路径。');
    expect(permissionConsequence(request, zh)).toBe('允许的话，它可能写到那些被禁止的位置。拒绝则什么都不写。');
  });

  it('deletion plus uncertain write target still shows the deletion consequence', () => {
    const request: PermissionRequest = {
      ...baseRequest,
      tool: 'Bash',
      type: 'command',
      reasonCode: PermissionRequestReason.UncertainWriteTargetWithPathDeny,
      details: {
        command: 'rm -rf /tmp/projects/foo > "$LOG/out"',
        affectedPath: '/tmp/projects/foo',
        affectedFileCount: 3,
      },
    };
    expect(permissionConsequence(request, zh)).toBe('将永久删除 /tmp/projects/foo（约 3 个文件），不进回收站。');
  });
});
