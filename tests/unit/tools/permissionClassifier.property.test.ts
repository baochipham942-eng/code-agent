import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
        // ANSI-C is decoded before shell-quote ever sees it, so `$'\\x6c\\x73'` is the word `ls`
        // while the glued `$'\\x6c'"\\x73"` stays `l\\x73`. Only fullwidth remains unverifiable.
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
  inner: 'ls' | 'git status' | 'chmod -R 777 ./data' | 'mystery-command' | 'rm -rf /' | "'${}ls'" | "$'ls'" | `$'l'"\\x73"` | 'echo ok#tag';
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
    'ls', 'git status', 'chmod -R 777 ./data', 'mystery-command', 'rm -rf /', "'${}ls'", "$'ls'", `$'l'"\\x73"`, 'echo ok#tag',
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

// The baseline is a detached checkout of origin/main made once per file. N_BASHAST_BASELINE may
// name an existing checkout for local iteration; nothing is picked up implicitly, because a cached
// checkout that is no longer origin/main satisfies an existence check and silently compares against
// the wrong thing. CI clones are shallow and carry no origin/main ref, so fetch it first.
let ownedBaseline: string | undefined;

function baselineCheckout(): string {
  if (process.env.N_BASHAST_BASELINE) return process.env.N_BASHAST_BASELINE;
  if (ownedBaseline) return ownedBaseline;
  const git = (...args: string[]) => spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf8' });
  if (git('rev-parse', '--verify', '--quiet', 'origin/main').status !== 0) {
    const fetch = git('fetch', '--depth=1', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    if (fetch.status !== 0) throw new Error(`origin/main is not available for the baseline: ${fetch.stderr}`);
  }
  const checkoutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n-bashast-baseline-'));
  const checkout = git('worktree', 'add', '--detach', checkoutDir, 'origin/main');
  if (checkout.status !== 0) {
    throw new Error(`detached origin/main baseline checkout failed: ${checkout.stderr}`);
  }
  fs.symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(checkoutDir, 'node_modules'), 'junction');
  ownedBaseline = checkoutDir;
  return ownedBaseline;
}

afterAll(() => {
  if (ownedBaseline) spawnSync('git', ['worktree', 'remove', '--force', ownedBaseline], { cwd: process.cwd() });
});

async function baselineDecisions(commands: string[], workingDirectory = '/tmp'): Promise<Array<'approve' | 'deny' | 'ask'>> {
  const runner = [
    "import fs from 'node:fs';",
    "import { PermissionClassifier } from './src/host/tools/permissionClassifier.ts';",
    "import { setCommandPolicyRulesForTest } from './src/host/tools/modules/shell/commandPolicy.ts';",
    "const commands = JSON.parse(fs.readFileSync(0, 'utf8'));",
    'setCommandPolicyRulesForTest([]);',
    'const classifier = new PermissionClassifier({ enableLlm: false });',
    `Promise.all(commands.map((command) => classifier.classify('Bash', { command }, { workingDirectory: ${JSON.stringify(workingDirectory)}, permissionLevel: 'execute' }))).then((results) => process.stdout.write(JSON.stringify(results.map(({ decision }) => decision))));`,
  ].join('\n');
  const result = spawnSync('npx', ['tsx', '-e', runner], {
    cwd: baselineCheckout(),
    input: JSON.stringify(commands),
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.status !== 0) throw new Error(`baseline property runner failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as Array<'approve' | 'deny' | 'ask'>;
}

// approve < ask < deny. The invariant is "never looser than baseline" on the whole order, not just
// on approve: a baseline `deny` decaying into an approvable `ask` is a loosening too, and round 7
// (outputRedirectionAsk) plus round 13 (parseFailureAsk) were both exactly that shape.
const STRICTNESS = { approve: 0, ask: 1, deny: 2 } as const;

// Random sampling alone cannot be trusted to reach a specific spelling: the six dimensions span
// ~221k combinations and we draw 140. Every shape a reviewer has already found is therefore pinned
// here and compared against the baseline on every run; the sampled shapes stay as a coarse net for
// shapes nobody has thought of yet.
const KNOWN_SHAPES = [
  './ls',
  'PATH=./bin ls',
  "./bash -c 'ls'",
  'PATH=./bin; ls',
  "./bash -c 'cd .'",
  "bash --rcfile ./startup.sh -ic 'ls'",
  'echo ok#tag; ./cleanup',
  `$'l'"\\x73"`,
  './env ls',
  `bash -c './bash -c "ls"'`,
  "bash --init-file ./startup.sh -i 'ls'",
  'echo ok#tag; echo x > out.txt',
  'echo foo\\ #tag; ./cleanup',
  "chronic bash -c 'chmod -R 777 ./data'",
  `$'\\x6c'"\\x73"`,
  `$'\\x6c\\x73'`,
  // Round 15 and the marker post-mortem: shell-quote reports `$'ls'`, `"$"ls`, `$"ls"` and the lone `$`
  // through the very same empty-key callback, and a variable in the middle of a word cannot be
  // restored from a marker. These pin the family that four rounds of heuristics kept re-opening.
  '"$"ls',
  '$"ls"',
  "echo $'a\\'b'",
  '$\\x6c\\x73',
  'printf x > /tmp/report-$USER.txt',
  "printf x > $'\\0'",
  "$'ls' > out.txt",
  'cd . > out.txt',
  'echo x >> ~/.aws/credentials',
  'cd ~/.ssh; echo x > authorized_keys',
  // Round 16: input plumbing must not erase the words the credential rules read.
  'rm -rf ~/.ssh/id_rsa < README.md',
  'rm -rf ~/.ssh/id_rsa <<< x',
  'rm -rf ~/.ssh/id_rsa <<EOF',
  'cat < ~/.ssh/id_rsa',
  'sort < in.txt > out.txt',
  'wc -l < README.md',
  // Round 17: operators the parser leaves unstructured must still hand the deny rules their words.
  'rm -rf ~/.ssh/id_rsa >| run.log',
  'case x in a) rm -rf ~/.ssh/id_rsa;; esac',
  'rm -rf ~/.ssh/id_rsa; ls >| x',
  '(rm -rf ~/.ssh/id_rsa)',
  'cat <(rm -rf ~/.ssh/id_rsa)',
  'ls ${',
  // Round 18: $HOME-spelled operands are uncertain to the parser, not to the path resolver.
  'cat < "$HOME/.ssh/id_rsa"',
  'cat < $HOME/.ssh/id_rsa',
  'echo x > "$HOME/.aws/credentials"',
  'echo x >> $HOME/.ssh/authorized_keys',
];

// Under /tmp the critical-path rm rule fires before anything else and masks weaker rules; a real
// workspace cwd is where round 16's deny→ask actually showed. Compare known shapes in both.
const KNOWN_SHAPE_CWDS = ['/tmp', process.cwd()];

describe('final decision is never looser than the detached origin/main baseline', () => {
  const knownBaseline = new Map<string, 'approve' | 'deny' | 'ask'>();
  beforeAll(async () => {
    for (const cwd of KNOWN_SHAPE_CWDS) {
      const decisions = await baselineDecisions(KNOWN_SHAPES, cwd);
      KNOWN_SHAPES.forEach((command, index) => knownBaseline.set(`${cwd}\u0000${command}`, decisions[index]));
    }
  }, 240_000);
  beforeEach(() => setCommandPolicyRulesForTest([]));

  // Sampling indices with replacement does not guarantee every known shape is compared, and these
  // are exactly the shapes we already know can regress. Walk them one by one.
  it.each(KNOWN_SHAPE_CWDS.flatMap((cwd) => KNOWN_SHAPES.map((command) => [command, cwd] as const)))(
    'never loosens the baseline for a known shape: %s (cwd %s)', async (command, cwd) => {
      const baseline = knownBaseline.get(`${cwd}\u0000${command}`);
      if (!baseline) throw new Error(`no baseline decision recorded for ${command} in ${cwd}`);
      const result = await new PermissionClassifier({ enableLlm: false }).classify(
        'Bash', { command }, { workingDirectory: cwd, permissionLevel: 'execute' },
      );
      expect(STRICTNESS[result.decision]).toBeGreaterThanOrEqual(STRICTNESS[baseline]);
    }, 120_000);

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
        expect(STRICTNESS[result.decision]).toBeGreaterThanOrEqual(STRICTNESS[baseline[index]]);
      },
    ), { numRuns: commands.length, seed: 1637 });
  });
});
