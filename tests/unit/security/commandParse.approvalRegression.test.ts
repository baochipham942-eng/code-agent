import { describe, expect, it } from 'vitest';
import { parseShellCommand } from '../../../src/host/security/commandParse';
import { isKnownSafeCommand } from '../../../src/host/security/commandSafety';

describe('shared parser automatic approval regressions', () => {
  it.each(['./ls', '/tmp/ls', '../ls', '../bin/ls', 'bin/ls', './git status', '/tmp/git status'])(
    'preserves executable identity and refuses automatic approval: %s', (command) => {
      expect(isKnownSafeCommand(command)).toBe(false);
      expect(parseShellCommand(command).executions[0].program).toBe(command.split(' ')[0]);
    },
  );

  it.each(['ls', 'git status', '/usr/bin/env ls', 'env /bin/bash -c "ls"'])(
    'keeps bare safe commands and basename wrapper recognition: %s', (command) => {
      expect(isKnownSafeCommand(command)).toBe(true);
    },
  );

  it('keeps absolute sudo recognition and the privilege guard', () => {
    expect(parseShellCommand('/usr/bin/sudo ls').executions[0]).toMatchObject({
      program: 'ls', wrappers: ['sudo'],
    });
    expect(isKnownSafeCommand('/usr/bin/sudo ls')).toBe(false);
  });

  it.each(['bash script.sh -c "echo ok"', 'bash -- script.sh -c "echo ok"',
    'bash -l script.sh -c "echo ok"'])(
    'stops shell options at the script operand: %s', (command) => {
      expect(parseShellCommand(command).executions).toEqual([
        expect.objectContaining({ program: 'script.sh', args: ['-c', 'echo ok'] }),
      ]);
      expect(isKnownSafeCommand(command)).toBe(false);
    },
  );

  it('does not whitelist a script operand named like a safe command', () => {
    expect(parseShellCommand('bash ls -c "echo ok"').executions[0].program).toBe('ls');
    expect(isKnownSafeCommand('bash ls -c "echo ok"')).toBe(false);
  });

  it.each(['bash -c "echo ok"', 'bash -lc "echo ok"',
    'bash --rcfile /dev/null -c "echo ok"', 'bash -o posix -c "echo ok"'])(
    'unwraps command strings before any script operand: %s', (command) => {
      expect(parseShellCommand(command).executions).toEqual([
        expect.objectContaining({ program: 'echo', args: ['ok'] }),
      ]);
      expect(isKnownSafeCommand(command)).toBe(true);
    },
  );

  it('distinguishes attached IO numbers from quoted, escaped and separated numeric operands', () => {
    for (const command of ['cp a b 2>&1', 'mv a b 2>&1', 'tee b 2>&1']) {
      expect(parseShellCommand(command).writeTargets.map((target) => target.path)).toEqual(['b']);
    }
    for (const command of ['cp a b 2 > log', "cp a b '2'>log", 'cp a b "2">log',
      'cp a b \\2>log', "cp a b 2''>log"]) {
      expect(parseShellCommand(command).writeTargets.map((target) => target.path)).toContain('2');
    }
    expect(parseShellCommand('cp a b word\\ 2>log').writeTargets.map((target) => target.path))
      .toContain('word 2');
  });

  it('bare newline separates the unsafe second command', () => {
    const command = 'git status\n./cleanup';
    expect(isKnownSafeCommand(command)).toBe(false);
    expect(parseShellCommand(command).executions.map(({ program }) => program))
      .toEqual(['git', './cleanup']);
  });

  it.each(['echo "a\nb"', "echo 'a\nb'", "echo $'a\nb'"])(
    'preserves quoted newlines as one command: %s', (command) => {
      expect(parseShellCommand(command).executions).toHaveLength(1);
      expect(isKnownSafeCommand(command)).toBe(true);
    },
  );

  it.each(['git status; ls', 'git status\nls', 'git status\n', 'git sta\\\ntus'])(
    'keeps safe compounds, final newlines and continuations: %s', (command) => {
      expect(isKnownSafeCommand(command)).toBe(true);
    },
  );

  it('ends comments at a bare newline', () => {
    expect(isKnownSafeCommand('git status # read only\n./cleanup')).toBe(false);
    expect(isKnownSafeCommand('git status # read only\nls')).toBe(true);
    expect(isKnownSafeCommand("git status # '\n./cleanup # '")).toBe(false);
    expect(isKnownSafeCommand("git status # '\nls # '")).toBe(true);
  });

  it.each(['/usr/bin/tee out.txt', '/bin/cp in.txt out.txt', '/bin/sed -i s/a/b/ out.txt'])(
    'retains basename write detection without automatic approval: %s', (command) => {
      expect(parseShellCommand(command).writeTargets.map(({ path }) => path)).toContain('out.txt');
      expect(isKnownSafeCommand(command)).toBe(false);
    },
  );
});
