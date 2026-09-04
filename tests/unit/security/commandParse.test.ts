import { describe, expect, it } from 'vitest';
import { parseShellCommand } from '../../../src/host/security/commandParse';

describe('shared shell command parser', () => {
  it.each([
    ['echo x >> ~/.ssh/authorized_keys', '~/.ssh/authorized_keys'],
    ["sed -i 's/x/y/' src/host/permissions/modes.ts", 'src/host/permissions/modes.ts'],
    ["sudo bash -c 'echo > f'", 'f'],
    ["setsid bash --rcfile /dev/null -c 'printf x > c.md'", 'c.md'],
  ])('extracts concrete write targets: %s', (command, target) => {
    const parsed = parseShellCommand(command);
    expect(parsed.parsingFailed).toBe(false);
    expect(parsed.writeTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: target, uncertain: false }),
    ]));
  });

  it('unwraps the supported launcher chain to the real program', () => {
    const parsed = parseShellCommand("env FOO=bar timeout 2 sudo -u root bash -c 'printf x'");
    expect(parsed).toMatchObject({ parsingFailed: false, uncertain: [] });
    expect(parsed.executions).toEqual([
      expect.objectContaining({
        program: 'printf',
        originalProgram: 'env',
        wrappers: ['env', 'timeout', 'sudo', 'bash'],
      }),
    ]);
  });

  it("xargs shell command is interpreted only at the launcher position", () => {
    expect(parseShellCommand("xargs -0 sh -c 'x'")).toMatchObject({
      parsingFailed: false,
      uncertain: [],
      executions: [expect.objectContaining({ program: 'x', wrappers: ['xargs', 'sh'] })],
    });
  });

  it.each([
    'grep sh file',
    "printf '%s' bash",
    'echo bash',
    'man sh',
    'which bash zsh',
  ])('shell name used as data creates no target or uncertainty: %s', (command) => {
    expect(parseShellCommand(command)).toMatchObject({
      parsingFailed: false,
      uncertain: [],
      writeTargets: [],
    });
  });

  it('keeps fd duplication distinct from quoted and escaped file names', () => {
    expect(parseShellCommand('printf x >&1').writeTargets).toEqual([]);
    expect(parseShellCommand("printf x >'&1'").writeTargets)
      .toEqual([expect.objectContaining({ path: '&1' })]);
    expect(parseShellCommand('printf x >\\&1').writeTargets)
      .toEqual([expect.objectContaining({ path: '&1' })]);
    expect(parseShellCommand('printf x &>file').writeTargets)
      .toEqual([expect.objectContaining({ path: 'file' })]);
  });

  it('fails closed when wrapper recursion exceeds four levels', () => {
    expect(parseShellCommand('env nohup nice command exec printf x')).toMatchObject({
      parsingFailed: true,
      failureReason: 'shell wrapper depth exceeds 4',
    });
  });

  it('marks a variable in command position as uncertain', () => {
    expect(parseShellCommand('$RUNNER --version').uncertain)
      .toContain('dynamic-command-position:${RUNNER}');
  });

  it('extracts an attached cp target-directory option', () => {
    expect(parseShellCommand('cp source --target-directory=dest').writeTargets)
      .toEqual([expect.objectContaining({ path: 'dest', source: 'copy' })]);
  });
});
