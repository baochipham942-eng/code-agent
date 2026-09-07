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

  it('an IO number split from its operator by a line continuation does not replace the write target', () => {
    expect(resolve('cp source.txt target.txt 2\\\n>&1').targets)
      .toEqual([resolveCanonicalRunPath(path.join(workingDirectory, 'target.txt'))]);
  });

  it('a background & followed by a redirect does not swallow the next command\'s write target', () => {
    expect(resolve('echo ok & > /dev/null cp source.txt target.txt').targets)
      .toContain(resolveCanonicalRunPath(path.join(workingDirectory, 'target.txt')));
  });

  it.each(['grep sh file', "printf '%s' bash", 'man sh', 'which bash zsh'])(
    'shell 名作为普通参数不制造 uncertain：%s',
    (command) => {
      expect(resolve(command)).toMatchObject({ targets: [], uncertain: [] });
    },
  );
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
    expect(resolve('cp a b 2\\\n2>&1').targets)
      .toEqual([resolveCanonicalRunPath(path.join(workingDirectory, 'b'))]);
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

/**
 * PR #1709 复审①（ENABLE2 修复轮 1）：重定向目标的分词不走 canonicalizeCommand——
 * 它去引号（安全匹配面要的形状），会把带空格的引号目标截成另一个路径：
 * `echo x > "/tmp/eval-sandbox escape.txt"` 曾解析成 /tmp/eval-sandbox（界外写当界内放行），
 * `printf '%s\n' '>/outside/file'` 的字符串字面量反向被当成写目标。
 * 修法：折续行 + 切未转义换行后，原文喂引号/转义感知的分词器，目标经 shellWordValue 词法值化。
 */
describe('引号/转义目标的词法保真（PR #1709 复审①）', () => {
  it('带空格的双引号目标解析为完整路径，不截断（越界形状才能被界外判接住）', () => {
    expect(resolve('echo x > "/etc/has space.txt"').targets)
      .toEqual([resolveCanonicalRunPath('/etc/has space.txt')]);
    expect(resolve('echo x > "/tmp/write-target-redirects/has space.txt"').targets)
      .toEqual([resolveCanonicalRunPath('/tmp/write-target-redirects/has space.txt')]);
  });

  it('单引号目标含空格同样保真', () => {
    expect(resolve("echo x > '/etc/single quoted.txt'").targets)
      .toEqual([resolveCanonicalRunPath('/etc/single quoted.txt')]);
  });

  it('反斜杠转义空格是同一个词（bash 词义 `\\ ` = 空格），不截断', () => {
    expect(resolve('echo x > /etc/has\\ space.txt').targets)
      .toEqual([resolveCanonicalRunPath('/etc/has space.txt')]);
  });

  it('字符串字面量里的 `>` 不是重定向（printf 误判修复）', () => {
    expect(resolve("printf '%s\\n' '>/outside/file'")).toMatchObject({ targets: [], uncertain: [] });
    expect(resolve('echo "a > b"')).toMatchObject({ targets: [], uncertain: [] });
  });

  it('命令名带引号/转义仍认得出（PR #1709 复审②：`c"p"` 丢目标会削弱 WRITE_OWNERSHIP_CONFLICT）', () => {
    expect(resolve('c"p" a /etc/x').targets).toEqual([resolveCanonicalRunPath('/etc/x')]);
    expect(resolve('c\\p a /etc/x').targets).toEqual([resolveCanonicalRunPath('/etc/x')]);
    expect(resolve('m"v" a /etc/x').targets).toEqual([resolveCanonicalRunPath('/etc/x')]);
    expect(resolve('tee "/tmp/t1"').targets).toEqual([resolveCanonicalRunPath('/tmp/t1')]);
  });

  it('带引号的尾部选项不遮蔽真实写目标（PR #1709 复审③：`cp src /outside/x "-f"`）', () => {
    // 修复前：`"-f"` 带引号不被选项过滤 ⇒ 混进操作数 ⇒ cp 的「最后一个操作数」被顶成 -f，
    // 真实目标 /etc/x 整个漏判。
    expect(resolve('cp src /etc/x "-f"').targets).toEqual([resolveCanonicalRunPath('/etc/x')]);
    expect(resolve('mv src /etc/x "-i"').targets).toEqual([resolveCanonicalRunPath('/etc/x')]);
    expect(resolve('tee "-a" /etc/x').targets).toEqual([resolveCanonicalRunPath('/etc/x')]);
    // 真阴：引号包的路径操作数不能误滤（值化后是 / 开头不是 - 开头）
    expect(resolve('cp src "/etc/has space.txt"').targets)
      .toEqual([resolveCanonicalRunPath('/etc/has space.txt')]);
  });

  it('bash -c 内嵌脚本的重定向目标不丢（PR #1709 复审④①：保引号后内层整段被引号包住）', () => {
    expect(resolve("bash -c 'echo x > /etc/owned.txt'").targets)
      .toEqual([resolveCanonicalRunPath('/etc/owned.txt')]);
    expect(resolve("bash -lc 'cp a /etc/x'").targets)
      .toEqual([resolveCanonicalRunPath('/etc/x')]);
    expect(resolve('sh -c "echo x > /etc/y"').targets)
      .toEqual([resolveCanonicalRunPath('/etc/y')]);
    // 真阴：bash 出现在非命令位不递归
    expect(resolve("echo 'bash -c x'").targets).toEqual([]);
  });

  it('包装前缀后的 bash -c 不丢目标（PR #1709 复审⑤二裁维持：env/sudo/timeout/nohup 系）', () => {
    expect(resolve("env bash -c 'echo x > /etc/owned.txt'").targets)
      .toEqual([resolveCanonicalRunPath('/etc/owned.txt')]);
    expect(resolve("sudo bash -c 'echo x > /etc/owned.txt'").targets)
      .toEqual([resolveCanonicalRunPath('/etc/owned.txt')]);
    expect(resolve("timeout 5 bash -c 'echo x > /etc/owned.txt'").targets)
      .toEqual([resolveCanonicalRunPath('/etc/owned.txt')]);
    expect(resolve("env FOO=1 bash -c 'echo x > /etc/owned.txt'").targets)
      .toEqual([resolveCanonicalRunPath('/etc/owned.txt')]);
    expect(resolve("nohup sh -c 'cp a /etc/x'").targets)
      .toEqual([resolveCanonicalRunPath('/etc/x')]);
  });

  it('eval 字面脚本的写目标不丢（PR #1709 复审⑥：内建，剩余参数空格拼接后执行）', () => {
    expect(resolve("eval 'echo x > /etc/owned.txt'").targets)
      .toEqual([resolveCanonicalRunPath('/etc/owned.txt')]);
    // eval 的拼接语义：分段给的脚本拼起来仍是一条命令
    expect(resolve("eval echo x '>' /etc/y").targets)
      .toEqual([resolveCanonicalRunPath('/etc/y')]);
    // 包装前缀 + eval 组合
    expect(resolve("env eval 'cp a /etc/z'").targets)
      .toEqual([resolveCanonicalRunPath('/etc/z')]);
    // 真阴：eval 作数据不递归
    expect(resolve("echo 'eval x'").targets).toEqual([]);
  });

  it('单引号路径里的字面反斜杠不丢（PR #1709 复审④②：值化只许做一遍）', () => {
    expect(resolve("cp src '/tmp/a\\b.txt'").targets)
      .toEqual([resolveCanonicalRunPath('/tmp/a\\b.txt')]);
  });

  it('嵌套脚本解析失败仍保住已识别的写目标（ai-review 第 46 轮：失败不许清空视图）', () => {
    // `(true)` 让内层解析失败；基线从分号前的 cp 提得到目标，候选一度返回空 ⇒
    // 工作区边界检查整个不触发。解析失败只该让视图变宽（多报），不该让它变空。
    expect(resolve("bash -c 'cp source.txt /etc/owned46.txt; (true)'").targets)
      .toEqual([resolveCanonicalRunPath('/etc/owned46.txt')]);
    // 对照：不带失败尾巴时本来就有
    expect(resolve("bash -c 'cp source.txt /etc/owned46.txt; true'").targets)
      .toEqual([resolveCanonicalRunPath('/etc/owned46.txt')]);
    // 对照：不经嵌套脚本时本来就有
    expect(resolve('cp source.txt /etc/owned46.txt; (true)').targets)
      .toEqual([resolveCanonicalRunPath('/etc/owned46.txt')]);
  });
});
