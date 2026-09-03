import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const CHECKER = path.join(REPO_ROOT, 'scripts/check-prompt-gate-evidence.ts');
const TSX = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');
const EVIDENCE = 'docs/eval/prompt-gate-latest.json';
const workspaces: string[] = [];

function write(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function evidence(gitHead: string, promptVersion = 'sys-v1'): Record<string, unknown> {
  return {
    schemaVersion: 1,
    generatedAt: '2026-09-03T00:00:00.000Z',
    gitHead,
    promptVersion,
    passed: true,
    steps: {
      staleScan: { count: 5, passed: true },
      replayEval: { count: 1, passed: true },
      realSmoke: { count: 10, passed: true },
    },
  };
}

function createWorkspace(): { root: string; evidenceHead: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-prompt-evidence-'));
  workspaces.push(root);
  write(root, 'scripts/lib/prompt-change-paths.sh', [
    'PROMPTS_DIR="src/host/prompts/"',
    'TOOL_MODULES_DIR="src/host/tools/modules/"',
    'VERSION_FILE="src/shared/constants/agent.ts"',
    '',
  ].join('\n'));
  write(root, 'src/shared/constants/agent.ts', "export const PROMPT_VERSION = 'sys-v1' as const;\n");
  write(root, 'src/host/prompts/system.ts', "export const prompt = 'initial';\n");
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'neo-test@example.invalid');
  git(root, 'config', 'user.name', 'Neo Test');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture base');
  return { root, evidenceHead: git(root, 'rev-parse', 'HEAD') };
}

function writeEvidence(root: string, value: unknown): void {
  write(root, EVIDENCE, `${JSON.stringify(value, null, 2)}\n`);
}

function run(root: string, baseRef?: string): { status: number; output: string } {
  try {
    const args = [TSX, CHECKER, '--root', root, ...(baseRef ? ['--base-ref', baseRef] : [])];
    const output = execFileSync(process.execPath, args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

afterEach(() => {
  for (const workspace of workspaces.splice(0)) fs.rmSync(workspace, { recursive: true, force: true });
});

describe('prompt gate evidence checker', () => {
  it('passes with matching promptVersion and no prompt input changes after gitHead', () => {
    const { root, evidenceHead } = createWorkspace();
    writeEvidence(root, evidence(evidenceHead));
    expect(run(root)).toMatchObject({ status: 0 });
  });

  it('fails closed when evidence is missing and prints the exact repair action', () => {
    const { root } = createWorkspace();
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(`missing evidence file: ${EVIDENCE}`);
    expect(result.output).toContain(`跑 npm run eval:prompt-gate 后提交 ${EVIDENCE}`);
  });

  it('rejects evidence whose gitHead predates a prompt input change', () => {
    const { root, evidenceHead } = createWorkspace();
    write(root, 'src/host/prompts/system.ts', "export const prompt = 'changed';\n");
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'change prompt');
    writeEvidence(root, evidence(evidenceHead));

    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('evidence is stale after prompt/tool schema changed');
    expect(result.output).toContain('src/host/prompts/system.ts');
  });

  it('rejects evidence from a different PROMPT_VERSION', () => {
    const { root, evidenceHead } = createWorkspace();
    writeEvidence(root, evidence(evidenceHead, 'sys-v0'));

    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('promptVersion mismatch: evidence=sys-v0 current=sys-v1');
  });

  it('rejects a passed evidence step with zero evaluated targets', () => {
    const { root, evidenceHead } = createWorkspace();
    const value = evidence(evidenceHead);
    (value.steps as Record<string, unknown>).realSmoke = { count: 0, passed: true };
    writeEvidence(root, value);

    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('evidence step realSmoke must have passed=true and a positive integer count');
  });

  it('conditional CI/local mode skips unrelated changes but enforces prompt changes', () => {
    const unrelated = createWorkspace();
    write(unrelated.root, 'docs/unrelated.md', '# unrelated\n');
    git(unrelated.root, 'add', '.');
    git(unrelated.root, 'commit', '-qm', 'unrelated docs');
    const skipped = run(unrelated.root, unrelated.evidenceHead);
    expect(skipped).toMatchObject({ status: 0 });
    expect(skipped.output).toContain('check not required');

    const relevant = createWorkspace();
    write(relevant.root, 'src/host/prompts/system.ts', "export const prompt = 'changed';\n");
    git(relevant.root, 'add', '.');
    git(relevant.root, 'commit', '-qm', 'prompt change');
    const blocked = run(relevant.root, relevant.evidenceHead);
    expect(blocked.status).not.toBe(0);
    expect(blocked.output).toContain(`missing evidence file: ${EVIDENCE}`);
  });
});
