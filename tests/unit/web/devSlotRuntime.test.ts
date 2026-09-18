import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectDevSlotRuntime } from '../../../src/web/devSlotRuntime';
import { devSlotDataDirName } from '../../../src/shared/devSlot';

/** git 探测结果的假实现：gitDir / commonDir 不同 → 工作树。 */
const gitExec =
  (gitDir: string, commonDir: string, fail = false) =>
  (file: string, args: string[]): string => {
    if (file !== 'git') throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    if (fail) throw new Error('git not available');
    if (args.includes('--absolute-git-dir')) return `${gitDir}\n`;
    if (args.includes('--git-common-dir')) return `${commonDir}\n`;
    throw new Error(`unexpected git args: ${args.join(' ')}`);
  };

/** lsof 假实现：按参数区分端口 LISTEN 探测与库文件持有探测。 */
const lsofExec =
  (portPids: Record<number, string>, filePids: string) =>
  (file: string, args: string[]): string => {
    if (file === 'git') throw new Error('no git');
    if (file === 'lsof') {
      const listenIdx = args.findIndex(arg => arg.startsWith('-iTCP:'));
      if (listenIdx >= 0) {
        const port = Number(args[listenIdx].slice('-iTCP:'.length));
        const pids = portPids[port];
        if (!pids) throw new Error('lsof: no match'); // 无匹配 exit 1
        return pids;
      }
      if (filePids) return filePids;
      throw new Error('lsof: no match');
    }
    if (file === 'ps') return `/usr/local/bin/node dist/web/webServer.cjs (pid ${args[args.indexOf('-p') + 1]})\n`;
    throw new Error(`unexpected exec: ${file}`);
  };

describe('detectDevSlotRuntime — git 工作树判定', () => {
  it('git-dir 在 .git/worktrees/ 下（≠ git-common-dir）→ 工作树', () => {
    const runtime = detectDevSlotRuntime({
      anchorDir: '/wt',
      homedir: '/Users/test',
      exec: gitExec('/repo/.git/worktrees/wt', '/repo/.git'),
    });
    expect(runtime.isGitWorktree()).toBe(true);
  });

  it('主检出（仓库根）：common-dir 相对 ".git" 解析后与 git-dir 相同 → 不是工作树', () => {
    // 实测：anchor=主检出根时 --absolute-git-dir=/repo/.git、--git-common-dir=.git
    const runtime = detectDevSlotRuntime({
      anchorDir: '/repo',
      homedir: '/Users/test',
      exec: gitExec('/repo/.git', '.git'),
    });
    expect(runtime.isGitWorktree()).toBe(false);
  });

  it('主检出子目录：common-dir 给相对路径（../../.git）时相对锚点解析，仍判主检出', () => {
    // 实测：anchor=/repo/src/web 时 --absolute-git-dir=/repo/.git、--git-common-dir=../../.git
    const runtime = detectDevSlotRuntime({
      anchorDir: '/repo/src/web',
      homedir: '/Users/test',
      exec: gitExec('/repo/.git', '../../.git'),
    });
    expect(runtime.isGitWorktree()).toBe(false);
  });

  it('工作树子目录：git-dir 落在主仓 .git/worktrees/ 下 → 工作树', () => {
    const runtime = detectDevSlotRuntime({
      anchorDir: '/wt/src/web',
      homedir: '/Users/test',
      exec: gitExec('/repo/.git/worktrees/wt', '/repo/.git'),
    });
    expect(runtime.isGitWorktree()).toBe(true);
  });

  it('git 不可用（打包态/非 git 目录）→ 判主检出语义（false）', () => {
    const runtime = detectDevSlotRuntime({
      anchorDir: '/Applications/Agent Neo Dev.app/Contents/Resources/_up_/dist/web',
      homedir: '/Users/test',
      exec: lsofExec({}, ''),
    });
    expect(runtime.isGitWorktree()).toBe(false);
  });

  it('工作树判定记忆化：重复调用不重复探测', () => {
    let gitCalls = 0;
    const runtime = detectDevSlotRuntime({
      anchorDir: '/repo',
      homedir: '/Users/test',
      exec: (file, args) => {
        if (file === 'git') {
          gitCalls += 1;
          return gitExec('/repo/.git', '/repo/.git')(file, args);
        }
        throw new Error('unexpected');
      },
    });
    expect(runtime.isGitWorktree()).toBe(false);
    expect(runtime.isGitWorktree()).toBe(false);
    expect(gitCalls).toBe(2); // git-dir + common-dir 各一次，第二轮零次
  });
});

describe('detectDevSlotRuntime — 槽位空闲判定', () => {
  it('端口有人 LISTEN → 槽不空闲（即使数据目录没进程持有）', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'devslot-runtime-'));
    const runtime = detectDevSlotRuntime({
      anchorDir: base,
      homedir: base,
      exec: lsofExec({ 8182: '4321\n' }, ''), // 槽 2 端口被占
    });
    expect(runtime.isSlotFree(2)).toBe(false);
    expect(runtime.isSlotFree(3)).toBe(true);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('库文件被活进程持有 → 槽不空闲', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'devslot-runtime-'));
    const dev2 = path.join(base, devSlotDataDirName(2));
    fs.mkdirSync(dev2, { recursive: true });
    fs.writeFileSync(path.join(dev2, 'code-agent.db'), '');
    const runtime = detectDevSlotRuntime({
      anchorDir: base,
      homedir: base,
      exec: lsofExec({}, '8765\n'),
    });
    expect(runtime.isSlotFree(2)).toBe(false);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('数据目录存在但库文件无人持有 → 槽空闲（目录存在 ≠ 占用）', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'devslot-runtime-'));
    const dev3 = path.join(base, devSlotDataDirName(3));
    fs.mkdirSync(dev3, { recursive: true });
    fs.writeFileSync(path.join(dev3, 'code-agent.db'), ''); // 上次干净退出留下的库
    const runtime = detectDevSlotRuntime({
      anchorDir: base,
      homedir: base,
      exec: lsofExec({}, ''), // lsof 全部无匹配（exit 1）
    });
    expect(runtime.isSlotFree(3)).toBe(true);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('占用详情格式：端口与库文件判据各成一行，带 pid 与 command', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'devslot-runtime-'));
    const dev2 = path.join(base, devSlotDataDirName(2));
    fs.mkdirSync(dev2, { recursive: true });
    fs.writeFileSync(path.join(dev2, 'code-agent.db'), '');
    const runtime = detectDevSlotRuntime({
      anchorDir: base,
      homedir: base,
      exec: lsofExec({ 8182: '4321\n4322\n' }, '8765\n'),
    });
    const detail = runtime.describeSlotOccupancy!(2);
    expect(detail).toContain('~/.code-agent-dev2');
    expect(detail).toContain('pid=4321 criterion=tcp-listen:8182');
    expect(detail).toContain('pid=8765 criterion=data-dir-open');
    expect(detail).toContain('command=/usr/local/bin/node');
    fs.rmSync(base, { recursive: true, force: true });
  });
});
