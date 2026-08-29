import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStrictEvalSandbox } from '../../../scripts/lib/eval-sandbox';

const previousNoSandbox = process.env.CODE_AGENT_EVAL_NO_SANDBOX;
const previousTempRoot = process.env.CODE_AGENT_EVAL_TEMP_ROOT;
const roots: string[] = [];

function makeRepository(commit = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-sandbox-source-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.claude', 'test-cases'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'eval-private'), { recursive: true });
  fs.mkdirSync(path.join(root, '.code-agent'), { recursive: true });
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(root, 'safe.txt'), 'safe');
  fs.writeFileSync(path.join(root, '.claude', 'test-cases', 'answers.yaml'), 'secret');
  fs.writeFileSync(path.join(root, '.claude', 'eval-private', 'assertions.json'), '{}');
  fs.writeFileSync(path.join(root, '.code-agent', 'eval-baseline.json'), '{}');
  fs.writeFileSync(path.join(root, 'reports', 'previous.md'), 'secret');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  if (commit) {
    execFileSync('git', ['-c', 'user.name=Eval Test', '-c', 'user.email=eval@test.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
  }
  return root;
}

afterEach(() => {
  if (previousNoSandbox === undefined) delete process.env.CODE_AGENT_EVAL_NO_SANDBOX;
  else process.env.CODE_AGENT_EVAL_NO_SANDBOX = previousNoSandbox;
  if (previousTempRoot === undefined) delete process.env.CODE_AGENT_EVAL_TEMP_ROOT;
  else process.env.CODE_AGENT_EVAL_TEMP_ROOT = previousTempRoot;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('strict evaluation sandbox', () => {
  it('keeps source files while removing test answers, baselines, eval assets, and reports', () => {
    const repository = makeRepository();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-sandbox-output-'));
    roots.push(tempRoot);
    process.env.CODE_AGENT_EVAL_TEMP_ROOT = tempRoot;

    const sandbox = createStrictEvalSandbox(repository);
    expect(fs.readFileSync(path.join(sandbox.dir, 'safe.txt'), 'utf8')).toBe('safe');
    expect(fs.existsSync(path.join(sandbox.dir, '.claude', 'test-cases'))).toBe(false);
    expect(fs.existsSync(path.join(sandbox.dir, '.claude', 'eval-private'))).toBe(false);
    expect(fs.existsSync(path.join(sandbox.dir, '.code-agent', 'eval-baseline.json'))).toBe(false);
    expect(fs.existsSync(path.join(sandbox.dir, 'reports'))).toBe(false);
    sandbox.cleanup();
  });

  it('fails closed when bypass is requested, the directory is not Git, or archive cannot be built', () => {
    const repository = makeRepository();
    process.env.CODE_AGENT_EVAL_NO_SANDBOX = 'true';
    expect(() => createStrictEvalSandbox(repository)).toThrow(/已被拒绝/);

    delete process.env.CODE_AGENT_EVAL_NO_SANDBOX;
    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-not-git-'));
    roots.push(plainDir);
    expect(() => createStrictEvalSandbox(plainDir)).toThrow(/Git 仓库/);

    const repositoryWithoutCommit = makeRepository(false);
    expect(() => createStrictEvalSandbox(repositoryWithoutCommit)).toThrow(/拒绝在原目录/);
  });
});
