import { describe, expect, it } from 'vitest';
import type { PermissionRequest } from '../../../src/renderer/components/PermissionDialog/types';
import { permissionConsequence, isSafeDefaultDeny } from '../../../src/renderer/components/PermissionDialog/permissionPresentation';
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
