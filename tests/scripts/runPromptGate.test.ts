import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const PRODUCER = path.join(REPO_ROOT, 'scripts/run-prompt-gate.ts');
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

function createWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-prompt-producer-'));
  workspaces.push(root);
  write(root, 'scripts/lib/prompt-change-paths.sh', [
    'PROMPTS_DIR="src/host/prompts/"',
    'TOOL_MODULES_DIR="src/host/tools/modules/"',
    'BUILTIN_PLUGINS_DIR="src/host/plugins/builtin/"',
    'VERSION_FILE="src/shared/constants/agent.ts"',
    '',
  ].join('\n'));
  write(root, 'src/shared/constants/agent.ts', "export const PROMPT_VERSION = 'sys-v7' as const;\n");
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'neo-test@example.invalid');
  git(root, 'config', 'user.name', 'Neo Test');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture base');
  return root;
}

function command(source: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
}

function run(root: string, overrides: Partial<Record<string, string>> = {}): { status: number; output: string } {
  const env = {
    ...process.env,
    PROMPT_GATE_STALE_SCAN_COMMAND: command("console.log('PROMPT_GATE_COUNT=5')"),
    PROMPT_GATE_REPLAY_EVAL_COMMAND: command("console.log('PROMPT_GATE_COUNT=1')"),
    PROMPT_GATE_REAL_SMOKE_COMMAND: command("console.log('PROMPT_GATE_COUNT=10')"),
    ...overrides,
  };
  try {
    const output = execFileSync(process.execPath, [TSX, PRODUCER, '--root', root], {
      cwd: REPO_ROOT,
      env,
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

describe('prompt gate evidence producer', () => {
  it('writes one evidence file only after all three injected commands pass', () => {
    const root = createWorkspace();
    const result = run(root);
    expect(result, result.output).toMatchObject({ status: 0 });
    const value = JSON.parse(fs.readFileSync(path.join(root, EVIDENCE), 'utf8')) as Record<string, unknown>;
    expect(value).toMatchObject({
      schemaVersion: 1,
      gitHead: git(root, 'rev-parse', 'HEAD'),
      promptVersion: 'sys-v7',
      passed: true,
      steps: {
        staleScan: { count: 5, passed: true },
        replayEval: { count: 1, passed: true },
        realSmoke: { count: 10, passed: true },
      },
    });
  });

  it('returns non-zero and writes no evidence when one injected command fails', () => {
    const root = createWorkspace();
    const result = run(root, {
      PROMPT_GATE_REPLAY_EVAL_COMMAND: command('process.exit(9)'),
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('replayEval failed with exit 9');
    expect(fs.existsSync(path.join(root, EVIDENCE))).toBe(false);
  });

  it('returns non-zero and writes no evidence when a passing command evaluates zero targets', () => {
    const root = createWorkspace();
    const result = run(root, {
      PROMPT_GATE_REAL_SMOKE_COMMAND: command("console.log('PROMPT_GATE_COUNT=0')"),
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('realSmoke passed but evaluated zero targets');
    expect(fs.existsSync(path.join(root, EVIDENCE))).toBe(false);
  });
});
