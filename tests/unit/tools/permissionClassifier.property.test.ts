import { beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { bashCommandRequiresPermission, PermissionClassifier } from '../../../src/host/tools/permissionClassifier';
import { setCommandPolicyRulesForTest } from '../../../src/host/tools/modules/shell/commandPolicy';

const WORD_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_'.split('');
const styles = ['plain', 'single', 'double', 'ansi', 'split', 'mixed', 'fullwidth'] as const;

function respell(token: string, style: typeof styles[number]): string {
  switch (style) {
    case 'single': return `'${token}'`;
    case 'double': return `"${token}"`;
    case 'ansi': return `$'${[...token].map((c) => `\\x${c.charCodeAt(0).toString(16)}`).join('')}'`;
    case 'split': return `${token[0]}''${token.slice(1)}`;
    case 'mixed': return `'${token[0]}'"${token.slice(1)}"`;
    case 'fullwidth': return [...token].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join('');
    default: return token;
  }
}

// Fresh instances avoid cached decisions, and empty user policy forces the real B1 regex path.
const classify = (command: string) => new PermissionClassifier({ enableLlm: false }).classify(
  'Bash', { command }, { workingDirectory: '/tmp', permissionLevel: 'write' },
);

describe('permission classifier regex properties', () => {
  beforeEach(() => setCommandPolicyRulesForTest([]));

  it.each([
    ['node -e "document.querySelector(\'#b\').click()"', false],
    ['python3 -c "btn.press()"', false],
    ['echo "a\nb"', false],
    ['git status\ncat ~/.ssh/id_rsa', true],
    ['git push origin main', true],
    ['"git" push origin main', true],
  ] as const)('preserves shell quoting and boundaries in the preapproval guard: %s', (command, required) => {
    expect(bashCommandRequiresPermission(command, { workingDirectory: '/tmp' })).toBe(required);
  });

  it.each([
    ['chmod', ['-R', '777'], 'deny', '危险权限变更'],
    ['kill', ['-9', '-1'], 'deny', '杀死所有进程'],
    ['git', ['push', '--force'], 'ask', 'git force push'],
    ['git', ['reset', '--hard'], 'ask', 'git hard reset'],
  ] as const)('dangerous regex family remains decisive through generated spelling: %s %s',
    async (program, args, decision, reason) => {
      await fc.assert(fc.asyncProperty(
        fc.array(fc.constantFrom(...WORD_CHARACTERS), { minLength: 1, maxLength: 12 }),
        fc.array(fc.constantFrom(...styles), { minLength: args.length + 1, maxLength: args.length + 1 }),
        fc.integer({ min: 0, max: 9999 }),
        async (suffix, spellings, number) => {
          const words = [program, ...args].map((word, index) => respell(word, spellings[index]));
          const command = [...words, `file${number}_${suffix.join('')}`].join(' ');
          const result = await classify(command);
          expect(result.decision).toBe(decision);
          // A fallback ask or a different guard is not proof that this regex was exercised.
          expect(result.reason).toBe(`危险命令: ${reason}`);
        },
      ), { numRuns: 150, seed: 1637 });
    },
  );

  it('pairs dangerous chmod with ordinary permission changes and safe reads', async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom('644', '755', '600'),
      fc.constantFrom(...styles),
      async (mode, style) => {
        const normal = await classify(`${respell('chmod', style)} ${mode} file2_Aa`);
        expect(normal.decision).toBe('ask');
        expect(normal.reason).not.toContain('危险权限变更');
        expect((await classify(`${respell('ls', style)} file2_Aa`)).decision)
          .toBe(style === 'fullwidth' ? 'ask' : 'approve');
      },
    ), { numRuns: 60, seed: 1637 });
  });

  it('does not approve case variants or Cyrillic lookalikes as known safe executables', async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom('LS', 'Ls', 'lS', 'lѕ', 'сat', 'echо'),
      fc.constantFrom(...styles.filter((style) => style !== 'ansi' && style !== 'fullwidth')),
      async (program, style) => {
        expect((await classify(`${respell(program, style)} file2_Aa`)).decision).toBe('ask');
      },
    ), { numRuns: 60, seed: 1637 });
  });
});

type GeneratedShape = {
  wrapper: 'none' | 'bash' | 'sh' | 'zsh' | 'dash' | 'env' | 'sudo' | 'xargs' | 'command' | 'exec' | 'nohup' | 'setsid' | 'custom';
  pathPrefix: '' | './' | '../' | 'bin/' | '/tmp/' | '/usr/bin/';
  assignment: '' | 'PATH=./bin' | 'LD_PRELOAD=/tmp/evil.so' | 'MODE=1' | 'A=1 B=2';
  shellOption: '' | '-c' | '-lc' | '-ic' | '-i' | '--rcfile ./startup.sh' | '--init-file ./startup.sh' | '-o posix' | '--';
  delimiter: '' | ';' | '&&' | '||' | '\n' | '|' | '# comment\n';
  inner: 'ls' | 'git status' | 'chmod -R 777 ./data' | 'mystery-command' | 'rm -rf /';
};

const generatedShapeArbitrary: fc.Arbitrary<GeneratedShape> = fc.record({
  wrapper: fc.constantFrom<GeneratedShape['wrapper']>(
    'none', 'bash', 'sh', 'zsh', 'dash', 'env', 'sudo', 'xargs', 'command', 'exec', 'nohup', 'setsid', 'custom',
  ),
  pathPrefix: fc.constantFrom<GeneratedShape['pathPrefix']>('', './', '../', 'bin/', '/tmp/', '/usr/bin/'),
  assignment: fc.constantFrom<GeneratedShape['assignment']>('', 'PATH=./bin', 'LD_PRELOAD=/tmp/evil.so', 'MODE=1', 'A=1 B=2'),
  shellOption: fc.constantFrom<GeneratedShape['shellOption']>(
    '', '-c', '-lc', '-ic', '-i', '--rcfile ./startup.sh', '--init-file ./startup.sh', '-o posix', '--',
  ),
  delimiter: fc.constantFrom<GeneratedShape['delimiter']>('', ';', '&&', '||', '\n', '|', '# comment\n'),
  inner: fc.constantFrom<GeneratedShape['inner']>(
    'ls', 'git status', 'chmod -R 777 ./data', 'mystery-command', 'rm -rf /',
  ),
});

function quoteInner(inner: string): string {
  return `'${inner.replaceAll("'", "'\\''")}'`;
}

function renderGeneratedShape(shape: GeneratedShape): string {
  const executable = `${shape.pathPrefix}${shape.wrapper === 'custom' ? 'custom-launcher' : shape.wrapper}`;
  let command: string;
  if (shape.wrapper === 'none') {
    command = `${shape.assignment ? `${shape.assignment} ` : ''}${shape.pathPrefix}${shape.inner}`;
  } else if (shape.wrapper === 'bash' || shape.wrapper === 'sh' || shape.wrapper === 'zsh' || shape.wrapper === 'dash') {
    const option = shape.shellOption || '-c';
    command = `${shape.assignment ? `${shape.assignment} ` : ''}${executable} ${option} ${quoteInner(shape.inner)}`;
  } else {
    command = `${shape.assignment ? `${shape.assignment} ` : ''}${executable}${shape.shellOption ? ` ${shape.shellOption}` : ''} ${shape.inner}`;
  }
  if (!shape.delimiter) return command;
  const suffix = shape.delimiter === '# comment\n' ? 'ls' : 'ls';
  return `${command} ${shape.delimiter}${suffix}`;
}

function fallbackBaselineDecision(command: string): 'approve' | 'deny' | 'ask' {
  if (/rm\s+-rf\s+\/$/.test(command) || /chmod\s+-R\s+777/.test(command)) return 'deny';
  if (command === 'ls' || command === 'git status' || command === 'bash -c \'ls\''
    || command === 'sh -c \'ls\'' || command === 'zsh -c \'ls\'') return 'approve';
  return 'ask';
}

async function baselineDecisions(commands: string[]): Promise<Array<'approve' | 'deny' | 'ask'>> {
  const baseline = process.env.N_BASHAST_BASELINE ?? '/private/tmp/n-bashast-r9-baseline';
  if (!fs.existsSync(path.join(baseline, 'src/host/tools/permissionClassifier.ts'))) {
    return commands.map(fallbackBaselineDecision);
  }
  const runner = [
    "import fs from 'node:fs';",
    "import { PermissionClassifier } from './src/host/tools/permissionClassifier.ts';",
    "import { setCommandPolicyRulesForTest } from './src/host/tools/modules/shell/commandPolicy.ts';",
    "const commands = JSON.parse(fs.readFileSync(0, 'utf8'));",
    'setCommandPolicyRulesForTest([]);',
    'const classifier = new PermissionClassifier({ enableLlm: false });',
    "Promise.all(commands.map((command) => classifier.classify('Bash', { command }, { workingDirectory: '/tmp', permissionLevel: 'execute' }))).then((results) => process.stdout.write(JSON.stringify(results.map(({ decision }) => decision))));",
  ].join('\n');
  const result = spawnSync('npx', ['tsx', '-e', runner], {
    cwd: baseline,
    input: JSON.stringify(commands),
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.status !== 0) throw new Error(`baseline property runner failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as Array<'approve' | 'deny' | 'ask'>;
}

describe('final decision is never looser than the detached origin/main baseline', () => {
  beforeEach(() => setCommandPolicyRulesForTest([]));

  it('covers wrapper, path, assignment, shell-option, delimiter and inner-command dimensions', async () => {
    const shapes = fc.sample(generatedShapeArbitrary, { numRuns: 140, seed: 1637 });
    const commands = shapes.map(renderGeneratedShape);
    const baseline = await baselineDecisions(commands);
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 0, max: commands.length - 1 }),
      async (index) => {
        const result = await new PermissionClassifier({ enableLlm: false }).classify(
          'Bash', { command: commands[index] }, { workingDirectory: '/tmp', permissionLevel: 'execute' },
        );
        // The only forbidden direction is baseline ask/deny becoming approve.
        if (result.decision === 'approve') expect(baseline[index]).toBe('approve');
      },
    ), { numRuns: commands.length, seed: 1637 });
  });
});
