import { beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
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
