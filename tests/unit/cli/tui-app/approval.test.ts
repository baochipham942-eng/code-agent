// ============================================================================
// tui-app/approval.ts — 审批卡数据逻辑 单测（P1 扩充版）
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { PermissionRequestData } from '../../../../src/host/tools/types';
import {
  approvalKey,
  approvalOptions,
  approvalTarget,
  editDiffPreview,
  SessionAllowList,
  writeChangeSummary,
} from '../../../../src/cli/tui-app/approval';

function req(overrides: Partial<PermissionRequestData> = {}): PermissionRequestData {
  return {
    type: 'command',
    tool: 'bash',
    details: { command: 'npm install -D marked' },
    ...overrides,
  };
}

function editReq(overrides: Partial<PermissionRequestData> = {}): PermissionRequestData {
  return {
    type: 'file_edit',
    tool: 'edit_file',
    details: { path: '/tmp/a.ts', oldString: 'const a = 1;\nconst b = 2;', newString: 'const a = 2;\nconst b = 2;\nconst c = 3;' },
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

describe('approvalOptions（P1 扩充）', () => {
  it('命令类：once / always / never / reject / reject-feedback', () => {
    const options = approvalOptions(req());
    expect(options.map((o) => o.choice)).toEqual(['once', 'always', 'never', 'reject', 'reject-feedback']);
    expect(options[1].label).toBe('Always allow: npm');
    expect(options[2].label).toBe('Never allow: npm');
  });

  it('编辑类：第二位插 Allow all edits this session', () => {
    const options = approvalOptions(editReq());
    expect(options.map((o) => o.choice)).toEqual([
      'once', 'session-edits', 'always', 'never', 'reject', 'reject-feedback',
    ]);
    expect(options[2].label).toBe('Always allow: edit_file');
  });

  it('文件工具 always/never 显示工具名', () => {
    const options = approvalOptions(req({ type: 'file_write', tool: 'write_file', details: { path: '/tmp/a.ts', contentLength: 10 } }));
    expect(options.map((o) => o.choice)).toContain('session-edits');
    expect(options.find((o) => o.choice === 'always')?.label).toBe('Always allow: write_file');
    expect(options.find((o) => o.choice === 'never')?.label).toBe('Never allow: write_file');
  });
});

describe('writeChangeSummary / editDiffPreview', () => {
  it('edit 摘要 +N -M lines；write 摘要 N bytes', () => {
    expect(writeChangeSummary(editReq())).toBe('+3 -2 lines');
    expect(writeChangeSummary(req({
      type: 'file_write', tool: 'write_file', details: { path: '/a', contentLength: 128 },
    }))).toBe('128 bytes new content');
    expect(writeChangeSummary(req())).toBeNull();
  });

  it('editDiffPreview：oldString → - 块，newString → + 块，超 maxLines 截断', () => {
    const preview = editDiffPreview(editReq());
    expect(preview).toMatchObject({
      removedLines: ['const a = 1;', 'const b = 2;'],
      addedLines: ['const a = 2;', 'const b = 2;', 'const c = 3;'],
      removedTotal: 2,
      addedTotal: 3,
      truncated: false,
    });
    const big = editDiffPreview(editReq({
      details: { oldString: Array.from({ length: 10 }, (_, i) => `old${i}`).join('\n'), newString: 'new' },
    }));
    expect(big?.removedLines).toHaveLength(8);
    expect(big?.truncated).toBe(true);
    expect(editDiffPreview(req())).toBeNull();
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

  it('never：deny 后同 key isDenied，且不误伤放行集合', () => {
    const allow = new SessionAllowList();
    const npmInstall = req();
    expect(allow.isDenied(npmInstall)).toBe(false);
    allow.deny(npmInstall);
    expect(allow.isDenied(npmInstall)).toBe(true);
    expect(allow.isDenied(req({ details: { command: 'npm test' } }))).toBe(true);
    expect(allow.isDenied(req({ details: { command: 'git status' } }))).toBe(false);
    expect(allow.has(npmInstall)).toBe(false);
  });

  it('addAllEdits：放行全部编辑类，不影响命令类', () => {
    const allow = new SessionAllowList();
    allow.addAllEdits();
    expect(allow.has(editReq())).toBe(true);
    expect(allow.has(req({ type: 'file_write', tool: 'write_file', details: { path: '/x' } }))).toBe(true);
    expect(allow.has(req())).toBe(false);
  });
});
