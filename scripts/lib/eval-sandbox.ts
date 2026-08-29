import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface EvalSandbox {
  dir: string;
  cleanup(): void;
}

function removeAnswerAssets(dir: string): void {
  const fixedPaths = [
    path.join(dir, '.claude', 'test-cases'),
    path.join(dir, '.code-agent', 'eval-baseline.json'),
    path.join(dir, '.claude', 'test-results'),
    path.join(dir, 'reports'),
  ];
  for (const target of fixedPaths) fs.rmSync(target, { recursive: true, force: true });

  const claudeDir = path.join(dir, '.claude');
  if (!fs.existsSync(claudeDir)) return;
  for (const entry of fs.readdirSync(claudeDir)) {
    if (entry.startsWith('eval-')) {
      fs.rmSync(path.join(claudeDir, entry), { recursive: true, force: true });
    }
  }
}

export function createStrictEvalSandbox(repoDir: string): EvalSandbox {
  if (process.env.CODE_AGENT_EVAL_NO_SANDBOX === 'true') {
    throw new Error('真实评测必须在隔离工作目录中运行，当前关闭设置已被拒绝。');
  }
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
  } catch (error) {
    throw new Error('真实评测需要从 Git 仓库运行，当前目录不符合要求。', { cause: error });
  }

  const parent = process.env.CODE_AGENT_EVAL_TEMP_ROOT?.trim() || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'case-'));
  try {
    const archive = execFileSync('git', ['archive', '--format=tar', 'HEAD'], {
      cwd: repoDir,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1024 * 1024 * 256,
    });
    execFileSync('tar', ['-x', '-C', dir], {
      input: archive,
      stdio: ['pipe', 'ignore', 'ignore'],
      maxBuffer: 1024 * 1024 * 256,
    });
    removeAnswerAssets(dir);
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('无法准备评测工作目录，已拒绝在原目录继续运行。', { cause: error });
  }

  process.env.CODE_AGENT_EVAL_REAL_ROOT ??= path.resolve(repoDir);
  return {
    dir,
    cleanup: () => {
      delete process.env.CODE_AGENT_EVAL_REAL_ROOT;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function cloneEvalSandbox(sourceDir: string): EvalSandbox {
  const parent = process.env.CODE_AGENT_EVAL_TEMP_ROOT?.trim() || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'case-'));
  try {
    fs.cpSync(sourceDir, dir, { recursive: true });
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('无法复制独立的用例工作目录。', { cause: error });
  }
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
