import { describe, expect, it } from 'vitest';
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
    expect(permissionConsequence(request, zh)).toBe('将向工作区外的设备文件 /dev/null 写入。');
    expect(permissionConsequence(request, zh)).not.toContain('可能覆盖现有内容');
  });

  // ai-review #1692：`/dev/` 前缀不能当「设备文件」判据——Linux 上 /dev/shm/<name> 是普通文件。
  // 标题保留全路径无害，但「可能覆盖现有内容」的警告绝不能因为前缀命中就被摘掉。
  it('/dev/shm 下的普通文件：标题可留全路径，但覆盖警告必须保留', () => {
    const request: PermissionRequest = {
      ...baseRequest,
      tool: 'Write',
      type: 'file_write',
      details: { path: '/dev/shm/report.md' },
      boundary: { id: 'file.external_write' },
    };

    const consequence = permissionConsequence(request, zh);
    expect(consequence).toContain('可能覆盖现有内容');
    expect(consequence).not.toContain('设备文件');
  });

  it('titles /dev/stdout with the full path and skips overwrite wording', () => {
    const request: PermissionRequest = {
      ...baseRequest,
      tool: 'Write',
      type: 'file_write',
      details: { path: '/dev/stdout' },
      boundary: { id: 'file.external_write' },
    };

    expect(permissionSummary(request, zh)).toBe('允许写入 /dev/stdout（工作区外）？');
    expect(permissionConsequence(request, zh)).toBe('将向工作区外的设备文件 /dev/stdout 写入。');
    expect(permissionConsequence(request, zh)).not.toContain('可能覆盖现有内容');
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
});
