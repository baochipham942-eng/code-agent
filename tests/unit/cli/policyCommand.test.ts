import fs from 'fs';
import os from 'os';
import path from 'path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { policyCommand } from '../../../src/cli/commands/policy';

interface IO {
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
}

function mockProcessIO(): IO {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCodes.push(code ?? 0);
    return undefined;
  }) as never);
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });
  return { stdout, stderr, exitCodes };
}

function makeProgram(project?: string): Command {
  const program = new Command();
  program.exitOverride();
  program.option('-p, --project <path>', '项目目录', project ?? process.cwd());
  program.addCommand(policyCommand);
  return program;
}

function writePolicy(dir: string, data: unknown): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'exec-policy.json');
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  return file;
}

describe('neo policy command', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    // 每个用例用全新的 Command 树，避免 commander 状态串用例
    (policyCommand as unknown as { parent?: Command }).parent = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-cmd-test-'));
    tempDirs.push(dir);
    return dir;
  }

  it('check passes a valid policy with examples that all hit (exit 0)', async () => {
    const io = mockProcessIO();
    const dir = makeTempDir();
    const file = writePolicy(dir, {
      version: 1,
      rules: [
        { pattern: ['git', 'status'], decision: 'allow', createdAt: 1, source: 'user' },
        { pattern: ['git'], decision: 'prompt', createdAt: 1, source: 'user' },
      ],
      examples: [
        { command: 'git status', expect: 'allow' },
        { command: 'git push origin main', expect: 'prompt' },
      ],
    });

    await makeProgram().parseAsync(['node', 'neo', 'policy', 'check', '--file', file]);

    expect(io.exitCodes).toEqual([0]);
    const out = io.stdout.join('\n');
    expect(out).toContain('结果: PASS');
    expect(out).toContain('✓ "git status" → allow（期望 allow）');
    expect(out).toContain('规则 2 条 · 示例 2 条');
  });

  it('check fails on syntax-broken JSON with a clear error (exit 1)', async () => {
    const io = mockProcessIO();
    const file = writePolicy(makeTempDir(), '{ not json !!');

    await makeProgram().parseAsync(['node', 'neo', 'policy', 'check', '--file', file]);

    expect(io.exitCodes).toEqual([1]);
    const out = io.stdout.join('\n');
    expect(out).toContain('[invalid-json]');
    expect(out).toContain('结果: FAIL');
  });

  it('check reports shadow-escalation conflicts (exit 1)', async () => {
    const io = mockProcessIO();
    const file = writePolicy(makeTempDir(), {
      version: 1,
      rules: [
        { pattern: ['git'], decision: 'forbidden', createdAt: 1, source: 'user' },
        { pattern: ['git', 'status'], decision: 'allow', createdAt: 1, source: 'user' },
      ],
    });

    await makeProgram().parseAsync(['node', 'neo', 'policy', 'check', '--file', file]);

    expect(io.exitCodes).toEqual([1]);
    expect(io.stdout.join('\n')).toContain('[shadow-escalation]');
  });

  it('check reports per-item diffs when an example misses its expectation (exit 1)', async () => {
    const io = mockProcessIO();
    const file = writePolicy(makeTempDir(), {
      version: 1,
      rules: [{ pattern: ['git'], decision: 'prompt', createdAt: 1, source: 'user' }],
    });

    await makeProgram().parseAsync([
      'node', 'neo', 'policy', 'check', '--file', file,
      '--expect', 'git status=allow',
      '--expect', 'git push=prompt',
    ]);

    expect(io.exitCodes).toEqual([1]);
    const out = io.stdout.join('\n');
    expect(out).toContain('✗ "git status" → prompt（期望 allow）');
    expect(out).toContain('✓ "git push" → prompt（期望 prompt）');
  });

  it('check --json emits a machine-readable report', async () => {
    const io = mockProcessIO();
    const file = writePolicy(makeTempDir(), {
      version: 1,
      rules: [{ pattern: ['sudo'], decision: 'allow', createdAt: 1, source: 'user' }],
    });

    await makeProgram().parseAsync(['node', 'neo', 'policy', 'check', '--file', file, '--json']);

    expect(io.exitCodes).toEqual([1]);
    const report = JSON.parse(io.stdout.join(''));
    expect(report.status).toBe('fail');
    expect(report.file).toBe(file);
    expect(report.issues[0].code).toBe('banned-prefix-allow');
    expect(report.summary.errors).toBe(1);
  });

  it('resolves the default project policy file via -p/--project', async () => {
    const io = mockProcessIO();
    const project = makeTempDir();
    writePolicy(path.join(project, '.code-agent'), {
      version: 1,
      rules: [{ pattern: ['make', 'build'], decision: 'allow', createdAt: 1, source: 'user' }],
    });

    await makeProgram(project).parseAsync(['node', 'neo', 'policy', 'check']);

    expect(io.exitCodes).toEqual([0]);
    expect(io.stdout.join('\n')).toContain(path.join(project, '.code-agent', 'exec-policy.json'));
  });

  it('falls back to the user-level policy file when the project has none', async () => {
    const io = mockProcessIO();
    const project = makeTempDir();
    const dataDir = makeTempDir();
    vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
    writePolicy(dataDir, {
      version: 1,
      rules: [{ pattern: ['make'], decision: 'allow', createdAt: 1, source: 'user' }],
    });

    await makeProgram(project).parseAsync(['node', 'neo', 'policy', 'check']);

    expect(io.exitCodes).toEqual([0]);
    expect(io.stdout.join('\n')).toContain(path.join(dataDir, 'exec-policy.json'));
  });

  it('exits 0 with a no-policy note when no policy file exists', async () => {
    const io = mockProcessIO();
    vi.stubEnv('CODE_AGENT_DATA_DIR', makeTempDir());

    await makeProgram(makeTempDir()).parseAsync(['node', 'neo', 'policy', 'check']);

    expect(io.exitCodes).toEqual([0]);
    expect(io.stdout.join('\n')).toContain('未找到 exec-policy.json');
  });

  it('exits 1 when an explicit --file does not exist', async () => {
    const io = mockProcessIO();

    await makeProgram().parseAsync(['node', 'neo', 'policy', 'check', '--file', '/no/such/exec-policy.json']);

    expect(io.exitCodes).toEqual([1]);
    expect(io.stderr.join('\n')).toContain('/no/such/exec-policy.json');
  });

  it('explain shows the matching rule and reason (exit 0)', async () => {
    const io = mockProcessIO();
    const file = writePolicy(makeTempDir(), {
      version: 1,
      rules: [
        { pattern: ['git'], decision: 'prompt', createdAt: 1, source: 'user' },
        { pattern: ['git', 'push'], decision: 'prompt', createdAt: 2, source: 'builtin' },
      ],
    });

    await makeProgram().parseAsync(['node', 'neo', 'policy', 'explain', 'git push origin main', '--file', file]);

    expect(io.exitCodes).toEqual([0]);
    const out = io.stdout.join('\n');
    expect(out).toContain('决策: prompt');
    expect(out).toContain('最长前缀命中规则 ["git", "push"]');
  });

  it('explain reports no-match when nothing applies', async () => {
    const io = mockProcessIO();
    const file = writePolicy(makeTempDir(), { version: 1, rules: [] });

    await makeProgram().parseAsync(['node', 'neo', 'policy', 'explain', 'npm test', '--file', file]);

    expect(io.exitCodes).toEqual([0]);
    expect(io.stdout.join('\n')).toContain('决策: no-match');
  });

  it('explain refuses a syntactically broken policy file (exit 1)', async () => {
    const io = mockProcessIO();
    const file = writePolicy(makeTempDir(), '{ broken');

    await makeProgram().parseAsync(['node', 'neo', 'policy', 'explain', 'git status', '--file', file]);

    expect(io.exitCodes).toEqual([1]);
  });

  it('wires policy into the CLI metadataOnly light route (src/cli/index.ts)', () => {
    const indexSource = fs.readFileSync(
      path.join(__dirname, '../../../src/cli/index.ts'),
      'utf-8',
    );
    // metadataOnly 桩列表里有 policy（neo --help 可见，不加载重模块）
    const metadataBlock = indexSource.slice(
      indexSource.indexOf('if (metadataOnly)'),
      indexSource.indexOf("requestedCommand === 'policy'"),
    );
    expect(metadataBlock).toContain("'policy'");
    // policy 走独立轻量分支：只动态 import ./commands/policy，不经过重模块批量加载
    expect(indexSource).toContain("requestedCommand === 'policy'");
    const policyBranch = indexSource.slice(
      indexSource.indexOf("requestedCommand === 'policy'"),
      indexSource.indexOf("requestedCommand !== 'session'"),
    );
    expect(policyBranch).toContain("import('./commands/policy')");
    expect(policyBranch).not.toContain("import('./commands/chat')");
  });
});
