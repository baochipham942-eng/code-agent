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
