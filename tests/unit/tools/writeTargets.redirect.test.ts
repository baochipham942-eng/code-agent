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

  it.each(["printf x >'&1'", 'printf x >\\&1'])(
    '引号或转义后的 &1 是文件名：%s',
    (command) => {
      expect(resolve(command).targets)
        .toContain(resolveCanonicalRunPath(path.join(workingDirectory, '&1')));
    },
  );

  it.each([
    ["sudo bash -c 'echo > f'", 'f'],
    ["setsid bash --rcfile /dev/null -c 'printf x > c.md'", 'c.md'],
    ["sed -i 's/x/y/' src/host/permissions/modes.ts", 'src/host/permissions/modes.ts'],
    ['printf x | tee report.txt', 'report.txt'],
    ['cp source.txt copied.txt', 'copied.txt'],
    ['mv source.txt moved.txt', 'moved.txt'],
  ])('共享解析器提取包装器与写工具目标：%s', (command, target) => {
    expect(resolve(command).targets)
      .toContain(resolveCanonicalRunPath(path.join(workingDirectory, target)));
  });

  it.each(['grep sh file', "printf '%s' bash", 'man sh', 'which bash zsh'])(
    'shell 名作为普通参数不制造 uncertain：%s',
    (command) => {
      expect(resolve(command)).toMatchObject({ targets: [], uncertain: [] });
    },
  );
});
