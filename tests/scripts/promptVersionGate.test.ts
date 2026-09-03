import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const gateSource = join(repoRoot, 'scripts', 'check-prompt-version-bump.sh');
const pathsSource = join(repoRoot, 'scripts', 'lib', 'prompt-change-paths.sh');

let scratch = '';
let schemaFile = '';
let builtinSchemaFile = '';
let versionFile = '';

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: scratch, stdio: 'pipe' });
}

function runGate(): { status: number; output: string } {
  const result = spawnSync('bash', ['scripts/check-prompt-version-bump.sh'], {
    cwd: scratch,
    encoding: 'utf8',
  });
  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'prompt-version-gate-'));
  schemaFile = join(scratch, 'src/host/tools/modules/example/example.schema.ts');
  builtinSchemaFile = join(scratch, 'src/host/plugins/builtin/example/example.schema.ts');
  versionFile = join(scratch, 'src/shared/constants/agent.ts');

  mkdirSync(join(scratch, 'scripts'), { recursive: true });
  mkdirSync(join(scratch, 'scripts/lib'), { recursive: true });
  mkdirSync(join(schemaFile, '..'), { recursive: true });
  mkdirSync(join(builtinSchemaFile, '..'), { recursive: true });
  mkdirSync(join(versionFile, '..'), { recursive: true });
  copyFileSync(gateSource, join(scratch, 'scripts/check-prompt-version-bump.sh'));
  copyFileSync(pathsSource, join(scratch, 'scripts/lib/prompt-change-paths.sh'));

  writeFileSync(
    schemaFile,
    [
      'export const exampleSchema = {',
      '  description: `Example tool.',
      '',
      '**Usage:**',
      '// model-visible example',
      'import model-visible example',
      '  `,',
      '};',
      '',
      '/**',
      ' * source-only comment',
      ' */',
      'export const metadata = 1;',
      '',
    ].join('\n'),
  );
  writeFileSync(versionFile, "export const PROMPT_VERSION = 'sys-v1' as const;\n");
  writeFileSync(builtinSchemaFile, "export const schema = { description: 'Builtin example' };\n");

  git('init');
  git('config', 'user.email', 'prompt-gate-test@example.com');
  git('config', 'user.name', 'Prompt Gate Test');
  git('add', '.');
  git('commit', '--no-verify', '-m', 'baseline');
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('check-prompt-version-bump.sh', () => {
  it.each([
    ['Markdown star prefix', '**Usage:**', '**Usage updated:**'],
    ['slash prefix', '// model-visible example', '// model-visible example updated'],
    ['import prefix', 'import model-visible example', 'import model-visible example updated'],
  ])('多行模板字符串中的 %s 文本改动必须报红', (_label, before, after) => {
    writeFileSync(schemaFile, readFileSync(schemaFile, 'utf8').replace(before, after));
    git('add', schemaFile);

    const result = runGate();

    expect(result.status).toBe(1);
    expect(result.output).toContain('example.schema.ts');
  });

  it('纯 JSDoc 正文改动仍然放行，避免噪音 bump', () => {
    writeFileSync(
      schemaFile,
      readFileSync(schemaFile, 'utf8').replace(' * source-only comment', ' * updated source-only comment'),
    );
    git('add', schemaFile);

    const result = runGate();

    expect(result.status).toBe(0);
    expect(result.output).toBe('');
  });

  it('schema 实质改动与 PROMPT_VERSION bump 同批提交时放行', () => {
    writeFileSync(schemaFile, readFileSync(schemaFile, 'utf8').replace('Example tool.', 'Updated example tool.'));
    writeFileSync(versionFile, "export const PROMPT_VERSION = 'sys-v2' as const;\n");
    git('add', schemaFile, versionFile);

    const result = runGate();

    expect(result.status).toBe(0);
    expect(result.output).toContain("PROMPT_VERSION 已 bump 到 'sys-v2'");
  });

  it('builtin plugin schema 实质改动也必须 bump PROMPT_VERSION', () => {
    writeFileSync(builtinSchemaFile, "export const schema = { description: 'Changed builtin example' };\n");
    git('add', builtinSchemaFile);

    const result = runGate();

    expect(result.status).toBe(1);
    expect(result.output).toContain('src/host/plugins/builtin/example/example.schema.ts');
  });
});
