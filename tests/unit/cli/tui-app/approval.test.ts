// ============================================================================
// tui-app/approval.ts — 审批卡数据逻辑 单测
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { PermissionRequestData } from '../../../../src/host/tools/types';
import {
  approvalKey,
  approvalOptions,
  approvalTarget,
  SessionAllowList,
} from '../../../../src/cli/tui-app/approval';

function req(overrides: Partial<PermissionRequestData> = {}): PermissionRequestData {
  return {
    type: 'command',
    tool: 'bash',
    details: { command: 'npm install -D marked' },
    ...overrides,
  };
}

describe('approvalKey', () => {
  it('command 取首 token', () => {
    expect(approvalKey(req())).toBe('bash:npm');
    expect(approvalKey(req({ details: { command: '  git   push origin main' } }))).toBe('bash:git');
  });

  it('dangerous_command 同样取首 token', () => {
    expect(approvalKey(req({ type: 'dangerous_command', details: { command: 'rm -rf /tmp/x' } }))).toBe('bash:rm');
  });

  it('非命令类取工具名', () => {
    expect(approvalKey(req({ type: 'file_write', tool: 'write_file', details: { path: '/tmp/a.ts' } }))).toBe('tool:write_file');
  });
});

describe('approvalTarget', () => {
  it('命令原样单行显示，超长截断', () => {
    expect(approvalTarget(req())).toBe('npm install -D marked');
    const long = approvalTarget(req({ details: { command: 'x'.repeat(100) } }));
    expect(long.length).toBe(72);
    expect(long.endsWith('...')).toBe(true);
  });

  it('无 command 时回落 path/url/tool', () => {
    expect(approvalTarget(req({ tool: 'write_file', details: { path: '/tmp/a.ts' } }))).toBe('/tmp/a.ts');
    expect(approvalTarget(req({ tool: 'web_fetch', details: { url: 'https://x.com' } }))).toBe('https://x.com');
  });

  it('多行命令压成单行', () => {
    expect(approvalTarget(req({ details: { command: 'echo a\necho b' } }))).toBe('echo a echo b');
  });
});

describe('approvalOptions', () => {
  it('三选项：once / reject / always（带目标）', () => {
    const options = approvalOptions(req());
    expect(options.map((o) => o.choice)).toEqual(['once', 'reject', 'always']);
    expect(options[2].label).toBe('Always allow: npm');
  });

  it('文件工具 always 显示工具名', () => {
    const options = approvalOptions(req({ tool: 'write_file', details: { path: '/tmp/a.ts' } }));
    expect(options[2].label).toBe('Always allow: write_file');
  });
});

describe('SessionAllowList', () => {
  it('add 后同 key 命中，不同 key 不命中', () => {
    const allow = new SessionAllowList();
    const npmInstall = req();
    expect(allow.has(npmInstall)).toBe(false);
    allow.add(npmInstall);
    expect(allow.has(npmInstall)).toBe(true);
    // 同前缀不同参数 → 命中（前缀授权）
    expect(allow.has(req({ details: { command: 'npm run build' } }))).toBe(true);
    // 不同前缀 → 不命中
    expect(allow.has(req({ details: { command: 'git status' } }))).toBe(false);
    expect(allow.size).toBe(1);
  });
});
