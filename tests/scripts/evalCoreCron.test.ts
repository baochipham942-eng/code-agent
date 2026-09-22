// N-EVAL-WAVE8-WALKTHROUGH-FIX / FB-156：周跑发车器必须对准 origin/main，
// 而不是主仓恰好停着的分支。--dry-run 只报「用哪棵树、跑哪个 head」，不 pull 也不建树。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, '../../scripts/eval-core-cron.sh');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function dryRun(repo: string): string {
  return execFileSync('bash', [SCRIPT, '--dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, NEO_EVAL_CORE_REPO: repo, HOME: path.join(repo, '..', 'home') },
  });
}

describe('eval-core-cron.sh --dry-run', () => {
  let root = '';
  let clone = '';
  let originSha = '';

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-core-cron-'));
    fs.mkdirSync(path.join(root, 'home'), { recursive: true });
    const origin = path.join(root, 'origin');
    fs.mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    git(origin, 'config', 'user.email', 'test@example.com');
    git(origin, 'config', 'user.name', 'test');
    fs.writeFileSync(path.join(origin, 'README.md'), 'x\n');
    // 真仓 gitignore 了依赖目录；fixture 不忽略的话，cron 建的 node_modules 软链会把
    // 「工作区干净」检查误判成脏（真实仓不会）。
    fs.writeFileSync(path.join(origin, '.gitignore'), 'node_modules/\nsrc-tauri/target/\n');
    git(origin, 'add', '-A');
    git(origin, 'commit', '-qm', 'init');
    clone = path.join(root, 'code-agent');
    git(root, 'clone', '-q', origin, clone);
    originSha = git(clone, 'rev-parse', '--short', 'origin/main');
  });

  afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('主仓停在 main：就地跑，head 是 origin/main', () => {
    const out = dryRun(clone);
    expect(out).toContain('on_main=yes');
    expect(out).toContain(`tree=${clone}`);
    expect(out).toContain(`head=${originSha} (origin/main)`);
  });

  it('主仓停在别的分支：不切它的分支，改用专用树，head 仍是 origin/main', () => {
    git(clone, 'checkout', '-q', '-b', 'feat/somebody-elses-branch');
    const out = dryRun(clone);
    expect(out).toContain('on_main=no');
    expect(out).toContain(`tree=${path.join(root, 'code-agent-worktrees', 'eval-core-main')}`);
    expect(out).toContain(`head=${originSha} (origin/main)`);
    // dry-run 不建树、不动主仓分支
    expect(fs.existsSync(path.join(root, 'code-agent-worktrees'))).toBe(false);
    expect(git(clone, 'branch', '--show-current')).toBe('feat/somebody-elses-branch');
  });
});

// ============================================================================
// N-EVAL-FAILURE-AUTOHARVEST · 交付③：回流集周跑对比发车器（与本文件同口径：
// --dry-run 只报「用哪棵树、跑哪个 head、哪条命令」，不 pull 也不建树；
// 候选臂 yaml 未配/不存在时 fail-loud 退出，不假跑）。
// ============================================================================

const REFLOW_SCRIPT = path.resolve(__dirname, '../../scripts/eval-reflow-compare-cron.sh');

function reflowDryRun(repo: string, candidate?: string): { out: string; status: number } {
  try {
    const out = execFileSync('bash', [REFLOW_SCRIPT, '--dry-run'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NEO_EVAL_REFLOW_REPO: repo,
        HOME: path.join(repo, '..', 'home'),
        ...(candidate !== undefined ? { NEO_EVAL_REFLOW_CANDIDATE: candidate } : { NEO_EVAL_REFLOW_CANDIDATE: '' }),
      },
    });
    return { out, status: 0 };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string };
    return { out: String(failed.stdout ?? ''), status: failed.status ?? -1 };
  }
}

describe('eval-reflow-compare-cron.sh --dry-run', () => {
  let root = '';
  let clone = '';
  let originSha = '';
  let candidate = '';

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-reflow-cron-'));
    fs.mkdirSync(path.join(root, 'home'), { recursive: true });
    const origin = path.join(root, 'origin');
    fs.mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    git(origin, 'config', 'user.email', 'test@example.com');
    git(origin, 'config', 'user.name', 'test');
    fs.writeFileSync(path.join(origin, 'README.md'), 'x\n');
    // 真仓 gitignore 了依赖目录；fixture 不忽略的话，cron 建的 node_modules 软链会把
    // 「工作区干净」检查误判成脏（真实仓不会）。
    fs.writeFileSync(path.join(origin, '.gitignore'), 'node_modules/\nsrc-tauri/target/\n');
    git(origin, 'add', '-A');
    git(origin, 'commit', '-qm', 'init');
    clone = path.join(root, 'code-agent');
    git(root, 'clone', '-q', origin, clone);
    originSha = git(clone, 'rev-parse', '--short', 'origin/main');
    candidate = path.join(root, 'candidate.yaml');
    fs.writeFileSync(candidate, 'name: candidate\n');
  });

  afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('候选臂未配置 ⇒ fail-loud 退出，不打印将跑的命令', () => {
    const { out, status } = reflowDryRun(clone);
    expect(status).toBe(1);
    expect(out).toContain('NEO_EVAL_REFLOW_CANDIDATE 未配置');
    expect(out).not.toContain('--compare');
  });

  it('候选臂 yaml 不存在 ⇒ fail-loud 退出', () => {
    const { out, status } = reflowDryRun(clone, path.join(root, 'nope.yaml'));
    expect(status).toBe(1);
    expect(out).toContain('候选臂 yaml 不存在');
  });

  it('主仓停在 main：就地跑，命令带 --tags postlaunch 与候选臂', () => {
    const { out, status } = reflowDryRun(clone, candidate);
    expect(status).toBe(0);
    expect(out).toContain('on_main=yes');
    expect(out).toContain(`tree=${clone}`);
    expect(out).toContain(`head=${originSha} (本地已有的 origin/main，可能陈旧)`);
    expect(out).toContain(`--compare ${candidate} --tags postlaunch`);
  });

  it('候选臂相对路径（相对 REPO 解析）⇒ dry-run 打印的命令里是绝对路径（专用树 cwd 下也能解析）', () => {
    // 相对路径统一按 REPO 解析（脚本先 cd REPO，run 入口与 --install 一致）；
    // 打印时必须已绝对化——非 main 时会 cd 进专用树。
    const inRepo = path.join(clone, 'candidate-in-repo.yaml');
    fs.writeFileSync(inRepo, 'name: candidate\n');
    const out = execFileSync('bash', [REFLOW_SCRIPT, '--dry-run'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NEO_EVAL_REFLOW_REPO: clone,
        HOME: path.join(root, 'home-dry-rel'),
        NEO_EVAL_REFLOW_CANDIDATE: 'candidate-in-repo.yaml',
      },
    });
    expect(out).toContain(`--compare ${fs.realpathSync(inRepo)} `);
  });

  it('主仓停在别的分支：不切它的分支，改用专用树，dry-run 不建树', () => {
    git(clone, 'checkout', '-q', '-b', 'feat/somebody-elses-branch');
    const { out, status } = reflowDryRun(clone, candidate);
    expect(status).toBe(0);
    expect(out).toContain('on_main=no');
    expect(out).toContain(`tree=${path.join(root, 'code-agent-worktrees', 'eval-reflow-main')}`);
    expect(out).toContain(`head=${originSha} (本地已有的 origin/main，可能陈旧)`);
    expect(fs.existsSync(path.join(root, 'code-agent-worktrees'))).toBe(false);
    expect(git(clone, 'branch', '--show-current')).toBe('feat/somebody-elses-branch');
    // dry-run 是纯预览：不 fetch（FETCH_HEAD 都不许写，ai-review PR#2024 R6 Nit）
    expect(fs.existsSync(path.join(clone, '.git', 'FETCH_HEAD'))).toBe(false);
  });

  it('--install：候选臂写进 plist 的 EnvironmentVariables（launchd 拿不到交互 shell 环境）；缺候选拒装', () => {
    // launchctl 装炸弹式桩：只记录调用，不碰真 launchd。
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'launchctl'), `#!/bin/bash\necho "$@" >> '${path.join(root, 'launchctl.log')}'\n`);
    fs.chmodSync(path.join(binDir, 'launchctl'), 0o755);
    const env = {
      ...process.env,
      NEO_EVAL_REFLOW_REPO: clone,
      HOME: path.join(root, 'home-install'),
      PATH: `${binDir}:${process.env.PATH}`,
    };
    // 缺候选 ⇒ 拒装，plist 不落
    let failed = false;
    try {
      execFileSync('bash', [REFLOW_SCRIPT, '--install'], { encoding: 'utf8', env });
    } catch { failed = true; }
    expect(failed).toBe(true);

    execFileSync('bash', [REFLOW_SCRIPT, '--install'], {
      encoding: 'utf8',
      env: { ...env, NEO_EVAL_REFLOW_CANDIDATE: candidate },
    });
    const plist = fs.readFileSync(
      path.join(root, 'home-install', 'Library', 'LaunchAgents', 'com.linchen.neo-eval-reflow-compare-weekly.plist'),
      'utf8',
    );
    expect(plist).toContain('<key>NEO_EVAL_REFLOW_CANDIDATE</key>');
    // 无条件 pwd -P 归一化：/var → /private/var 软链被解析，期望值按 realpath 对齐
    expect(plist).toContain(`<string>${fs.realpathSync(candidate)}</string>`);
  });

  it('--install 从仓外用相对路径装：写进 plist 的是绝对路径（launchd 以 REPO 为 cwd）', () => {
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'launchctl'), '#!/bin/bash\nexit 0\n');
    fs.chmodSync(path.join(binDir, 'launchctl'), 0o755);
    // 相对路径统一按 REPO 解析（与直接运行入口同基准，ai-review R7 Nit）：
    // 候选只对 REPO 可解析（写在 clone 里），cwd 在仓外——按 cwd 解析会找不到文件拒装。
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    const inRepoCandidate = path.join(clone, 'install-candidate.yaml');
    fs.writeFileSync(inRepoCandidate, 'name: install-candidate\n');
    const relCandidate = 'install-candidate.yaml';
    execFileSync('bash', [REFLOW_SCRIPT, '--install'], {
      encoding: 'utf8',
      cwd: outside,
      env: {
        ...process.env,
        NEO_EVAL_REFLOW_REPO: clone,
        HOME: path.join(root, 'home-install-rel'),
        PATH: `${binDir}:${process.env.PATH}`,
        NEO_EVAL_REFLOW_CANDIDATE: relCandidate,
      },
    });
    const plist = fs.readFileSync(
      path.join(root, 'home-install-rel', 'Library', 'LaunchAgents', 'com.linchen.neo-eval-reflow-compare-weekly.plist'),
      'utf8',
    );
    // pwd 解析 /var → /private/var 软链：期望值按真实路径对齐
    expect(plist).toContain(`<string>${fs.realpathSync(inRepoCandidate)}</string>`);
    // 负向断言：plist 里不许出现 REPO 前缀拼出来的未归一化形态（含 '..' 或相对串）
    expect(plist).not.toContain('..');
  });

  it('--install 的 launchctl bootstrap 失败 ⇒ 非零退出，不报 installed', () => {
    const binDir = path.join(root, 'bin-fail');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'launchctl'), '#!/bin/bash\nif [ "$1" = bootstrap ]; then exit 1; fi\nexit 0\n');
    fs.chmodSync(path.join(binDir, 'launchctl'), 0o755);
    let status = 0;
    let out: string;
    try {
      out = execFileSync('bash', [REFLOW_SCRIPT, '--install'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          NEO_EVAL_REFLOW_REPO: clone,
          HOME: path.join(root, 'home-install-fail'),
          PATH: `${binDir}:${process.env.PATH}`,
          NEO_EVAL_REFLOW_CANDIDATE: candidate,
        },
      });
    } catch (error) {
      status = (error as { status?: number }).status ?? -1;
      out = String((error as { stdout?: string }).stdout ?? '');
    }
    expect(status).toBe(1);
    expect(out).toContain('launchctl bootstrap 失败');
    expect(out).not.toContain('installed');
  });

  it('专用树被别人的 checkout 占用（无 ownership 标记/有未提交改动）⇒ 拒绝 reset --hard，现场原样保留', () => {
    // 占用者：从 clone 加一棵没有标记的 worktree，并留一个未提交文件
    const occupied = path.join(root, 'code-agent-worktrees', 'eval-reflow-main');
    fs.mkdirSync(path.dirname(occupied), { recursive: true });
    git(clone, 'worktree', 'add', '--detach', occupied, 'origin/main');
    fs.writeFileSync(path.join(occupied, 'SOMEBODY-UNCOMMITTED.txt'), 'not yours\n');

    let status = 0;
    let out: string;
    try {
      out = execFileSync('bash', [REFLOW_SCRIPT], {
        encoding: 'utf8',
        env: {
          ...process.env,
          NEO_EVAL_REFLOW_REPO: clone,
          HOME: path.join(root, 'home-run'),
          NEO_EVAL_REFLOW_CANDIDATE: candidate,
        },
        timeout: 60000,
      });
    } catch (error) {
      status = (error as { status?: number }).status ?? -1;
      out = String((error as { stdout?: string }).stdout ?? '');
    }
    expect(status).toBe(1);
    // 日志里（stdout 被 exec 重定向进日志文件，这里读日志）
    const logDir = path.join(root, 'home-run', '.code-agent', 'eval-reflow-cron');
    const logFile = fs.readdirSync(logDir).filter((name) => name.endsWith('.log') && name !== 'launchd.log')[0];
    const log = fs.readFileSync(path.join(logDir, logFile!), 'utf8');
    expect(log).toContain('缺 .eval-reflow-cron-owned 标记');
    // 占用者的未提交文件必须原样还在
    expect(fs.readFileSync(path.join(occupied, 'SOMEBODY-UNCOMMITTED.txt'), 'utf8')).toBe('not yours\n');
    expect(out).toBe('');
  });

  it('自建专用树带标记时第二周跑不被自己的标记判脏（ownership 标记不算脏）', () => {
    const tree = path.join(root, 'code-agent-worktrees', 'eval-reflow-main');
    // 上一用例占用的外来树先清掉（本用例要验证的是自建树的第二跑）
    if (fs.existsSync(path.join(tree, '.git'))) {
      git(clone, 'worktree', 'remove', '--force', tree);
    }
    const env = {
      ...process.env,
      NEO_EVAL_REFLOW_REPO: clone,
      HOME: path.join(root, 'home-owned'),
      NEO_EVAL_REFLOW_CANDIDATE: candidate,
    };
    const runOnce = () => {
      try {
        execFileSync('bash', [REFLOW_SCRIPT], { encoding: 'utf8', env, timeout: 60000 });
        return 0;
      } catch (error) {
        return (error as { status?: number }).status ?? -1;
      }
    };
    const log = () => {
      const dir = path.join(root, 'home-owned', '.code-agent', 'eval-reflow-cron');
      const name = fs.readdirSync(dir).filter((n) => n.endsWith('.log') && n !== 'launchd.log')[0];
      return fs.readFileSync(path.join(dir, name!), 'utf8');
    };

    // 第一跑：自建树 + 落标记（fixture 仓没有 eval-ci/tsconfig，跑会在 npx 处失败——无所谓，
    // 本用例只钉 ownership 闸；tsx 走 npx 缓存离线可用，失败是即时的）。
    expect(runOnce()).not.toBe(0);
    if (!fs.existsSync(path.join(tree, '.eval-reflow-cron-owned'))) {
      fs.writeFileSync('/tmp/autoharvest-debug-run1.log', `branch=${git(clone, 'branch', '--show-current')}\n` + log());
    }
    expect(fs.existsSync(path.join(tree, '.eval-reflow-cron-owned'))).toBe(true);
    expect(log()).not.toContain('缺 .eval-reflow-cron-owned 标记');
    // 第二跑：标记是未跟踪文件但不算脏 ⇒ 过闸（不被自己的标记判退出）。
    expect(runOnce()).not.toBe(0);
    expect(log()).not.toContain('有未提交改动');
    expect(fs.readFileSync(path.join(tree, '.eval-reflow-cron-owned'), 'utf8')).toBe('');
  });
});
