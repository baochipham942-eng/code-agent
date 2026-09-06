/**
 * N-REDIRECT-FD-DUP：`2>&1` 这类 fd 复制不是写文件。
 *
 * 复现自 09-03 L3 第六程：良性 force-push 题的两张审批卡全部出自 `git remote -v 2>&1`，
 * 写目标解析把 `>` 后的 `&1` 当成了文件名。bash 的判据是 `>&` 后的词整体为数字或单个
 * `-` 才算 fd 复制，其余（`&>file`、`>&12abc`）仍是写目标。
 */
import { describe, expect, it } from 'vitest';
import path from 'path';
import { resolveToolWriteTargets, staticShellCommandShape } from '../../../src/host/tools/writeTargets';
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
  it('静态词形保留 Unicode 可执行名，不做命令匹配用的 NFKC/零宽折叠', () => {
    expect(staticShellCommandShape('MODE=1 t​ee /tmp/outside.txt')).toEqual({
      words: ['MODE=1', 't​ee', '/tmp/outside.txt'],
      leadingAssignmentCount: 1,
    });
    expect(staticShellCommandShape('M""ODE=1 tee /tmp/outside.txt')).toEqual({
      words: ['MODE=1', 'tee', '/tmp/outside.txt'],
      leadingAssignmentCount: 0,
    });
  });

  it('ANSI-C 路径转义只解码转义，不规范化相邻 Unicode', () => {
    expect(resolve("printf ok > /tmp/$'\\x72'ｅport.txt").targets)
      .toContain(resolveCanonicalRunPath('/tmp/rｅport.txt'));
  });

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

  it('按 shell 词语义解码部分引号与转义后的重定向目标', () => {
    expect(resolve('echo hi > "/tmp"/outside.txt').targets)
      .toContain(resolveCanonicalRunPath('/tmp/outside.txt'));
    expect(resolve('echo hi > /tmp/outside\\ file.txt').targets)
      .toContain(resolveCanonicalRunPath('/tmp/outside file.txt'));
    expect(resolve('echo hi > /tmp/ｗork/out.txt').targets)
      .toContain(resolveCanonicalRunPath('/tmp/ｗork/out.txt'));
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
    ['MODE=1 tee /etc/x', '/etc/x'],
    ['A=1 B=2 tee /etc/x', '/etc/x'],
    ['MODE=1 t""ee /etc/x', '/etc/x'],
    ['tee "/etc"/x', '/etc/x'],
    ['tee /etc/escaped\\ file', '/etc/escaped file'],
    ['tee \'/tmp/"work"/out.txt\'', '/tmp/"work"/out.txt'],
    ['tee -- -/../../outside.txt', '/tmp/outside.txt'],
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

  it('紧贴重定向符的 fd 前缀不算操作数：带 stderr 重定向时真目标不能丢（ai-review #1650 第 2 轮①）', () => {
    // 修之前：`2` 被当成 cp 的最后一个操作数 ⇒ 真目标 /tmp/report.txt 整个漏掉，
    // 而 `2` 解析到工作目录内 ⇒ 越权写信号也不响。是漏判，不是保守。
    expect(resolve('cp ./a /tmp/report.txt 2>&1').targets)
      .toEqual([resolveCanonicalRunPath('/tmp/report.txt')]);
    expect(resolve('mv ./a /tmp/report.txt 2>&1').targets)
      .toEqual([resolveCanonicalRunPath('/tmp/report.txt')]);
    // tee 那边是多出一个假目标 `2`，也一并没了
    expect(resolve('tee /tmp/log 2>&1').targets)
      .toEqual([resolveCanonicalRunPath('/tmp/log')]);
    // 真阴：数字与 `>` 之间有空格时，按 bash 它就是普通操作数，仍要当写目标
    expect(resolve('cp a b 2 > /tmp/x').targets)
      .toContain(resolveCanonicalRunPath(path.join(workingDirectory, '2')));
  });

  it('多行命令：换行是命令边界，第 2 行起的写目标不能丢（ai-review #1650 第 3 轮）', () => {
    // 修之前：canonicalizeCommand 把换行压成空格，tokenizer 又把 '\n' 当普通空白，
    // 整段粘成一条 `printf ready cp ./a /tmp/report.txt`，首词是 printf ⇒ 零写目标，
    // 越权写信号不响、安全维照过。
    expect(resolve('printf ready\ncp ./a /tmp/report.txt').targets)
      .toEqual([resolveCanonicalRunPath('/tmp/report.txt')]);
    expect(resolve('echo one\necho two\nmv ./x /tmp/y').targets)
      .toEqual([resolveCanonicalRunPath('/tmp/y')]);
    // 同一段里重定向与 cp 各在一行，两个都要拿到
    expect(resolve('echo hi > /tmp/r1\ncp ./a /tmp/r2').targets)
      .toEqual([resolveCanonicalRunPath('/tmp/r1'), resolveCanonicalRunPath('/tmp/r2')].sort());
    // 真阴：反斜杠续行仍是一条命令，目标照旧解析得出（别把续行当成命令边界）
    expect(resolve('cp ./a \\\n/tmp/cont.txt').targets)
      .toEqual([resolveCanonicalRunPath('/tmp/cont.txt')]);
    // 真阴：第 2 行写在工作区内，不该被当成越权
    expect(resolve('printf ready\ncp ./a ./b').targets)
      .toEqual([resolveCanonicalRunPath(path.join(workingDirectory, 'b'))]);
  });

  it('已知边界：heredoc 正文里的命令仍会被当成命令（保守多判，不漏判）', () => {
    // ponytail: 不做 heredoc 体追踪。多判的代价是多一次审批 / 多一条信号，
    // 漏判的代价是真写到工作区外没人看见——两边不对称，选保守那边。
    expect(resolve('cat <<EOF\ncp ./a /tmp/evil\nEOF').targets)
      .toContain(resolveCanonicalRunPath('/tmp/evil'));
  });

  it('tee 的每个文件参数都是写目标；cp / mv 只有最后一个', () => {
    expect(resolve('tee /etc/a /etc/b').targets)
      .toEqual(expect.arrayContaining([resolveCanonicalRunPath('/etc/a'), resolveCanonicalRunPath('/etc/b')]));
    expect(resolve('cp /etc/a /etc/b /tmp/dst').targets).not.toContain(resolveCanonicalRunPath('/etc/a'));
  });
});
