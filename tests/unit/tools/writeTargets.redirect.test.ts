/**
 * N-REDIRECT-FD-DUP：`2>&1` 这类 fd 复制不是写文件。
 *
 * 复现自 09-03 L3 第六程：良性 force-push 题的两张审批卡全部出自 `git remote -v 2>&1`，
 * 写目标解析把 `>` 后的 `&1` 当成了文件名。bash 的判据是 `>&` 后的词整体为数字或单个
 * `-` 才算 fd 复制，其余（`&>file`、`>&12abc`）仍是写目标。
 */
import { describe, expect, it } from 'vitest';
import path from 'path';
import { resolveToolWriteTargets } from '../../../src/host/tools/writeTargets';
import { resolveCanonicalRunPath } from '../../../src/host/runtime/runContext';
import type { ToolDefinition } from '../../../src/shared/contract/tool';

const BASH_TOOL = {
  name: 'Bash',
  description: 'test fixture',
  inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
  outputSchema: { type: 'string' },
  permissionLevel: 'execute',
  requiresPermission: true,
  pathAuthority: [{ kind: 'shell', commandParameter: 'command' }],
} as unknown as ToolDefinition;

const workingDirectory = '/tmp/write-target-redirects';

function resolve(command: string) {
  return resolveToolWriteTargets({ definition: BASH_TOOL, params: { command }, workingDirectory });
}

const outTxt = resolveCanonicalRunPath(path.join(workingDirectory, 'out.txt'));

describe('shell redirect write targets', () => {
  it.each([
    'echo hi 2>&1',
    'git status 2>&1',
    'git remote -v 2>&1 | head',
    'cmd >&2',
    'cmd 2>&-',
  ])('fd 复制不产生写目标：%s', (command) => {
    expect(resolve(command)).toMatchObject({ targets: [], uncertain: [] });
  });

  it.each([
    'echo hi > out.txt',
    'echo hi >> out.txt',
    'cmd &> out.txt',
    'cmd >& out.txt',
  ])('文件重定向仍是写目标：%s', (command) => {
    expect(resolve(command).targets).toContain(outTxt);
  });

  it('`>&` 后不是纯数字或 `-` 时按文件名处理', () => {
    expect(resolve('cmd >&12abc').targets)
      .toContain(resolveCanonicalRunPath(path.join(workingDirectory, '12abc')));
  });
});

/**
 * N-EVAL-POSTLAUNCH-K2 验收⑤：写目标不只在重定向里。
 * `cp a /etc/x` 在 K1 是零写目标——沙盒外的写入既不进权限判定，也不进上线后的越权写信号。
 */
describe('cp / mv / tee 的写目标', () => {
  it.each([
    ['cp a /etc/x', '/etc/x'],
    ['cp -r src /etc/x', '/etc/x'],
    ['mv a /etc/x', '/etc/x'],
    ['tee /etc/x', '/etc/x'],
    ['tee -a /etc/x', '/etc/x'],
    ['echo hi | tee /etc/x', '/etc/x'],
    ['cp a "/etc/x"', '/etc/x'],
    ['cd /tmp && cp a /etc/x', '/etc/x'],
  ])('真阳：%s 写到 %s', (command, expected) => {
    expect(resolve(command).targets).toContain(resolveCanonicalRunPath(expected));
  });

  it.each([
    'cp a ./b',
    'mv a b',
    'tee out.txt',
  ])('真阴：工作目录内的目标不算越权：%s', (command) => {
    const targets = resolve(command).targets;
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target.startsWith(resolveCanonicalRunPath(workingDirectory))).toBe(true);
    }
  });

  it('真阴：只读命令不产生写目标', () => {
    expect(resolve('cat /etc/hosts').targets).toEqual([]);
    expect(resolve('grep -rn cp /etc').targets).toEqual([]);
  });

  it('tee 的每个文件参数都是写目标；cp / mv 只有最后一个', () => {
    expect(resolve('tee /etc/a /etc/b').targets)
      .toEqual(expect.arrayContaining([resolveCanonicalRunPath('/etc/a'), resolveCanonicalRunPath('/etc/b')]));
    expect(resolve('cp /etc/a /etc/b /tmp/dst').targets).not.toContain(resolveCanonicalRunPath('/etc/a'));
  });
});
