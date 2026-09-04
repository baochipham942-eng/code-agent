import { describe, expect, it } from 'vitest';
import { parseShellCommand } from '../../../src/host/security/commandParse';

describe('shared shell command parser', () => {
  it.each([
    ['echo x >> ~/.ssh/authorized_keys', '~/.ssh/authorized_keys'],
    ["sed -i 's/x/y/' src/host/permissions/modes.ts", 'src/host/permissions/modes.ts'],
    ["sudo bash -c 'echo > f'", 'f'],
    [`env -S "bash -c 'echo x > src/x.ts'"`, 'src/x.ts'],
    [`env --split-string "bash -c 'echo x > src/long.ts'"`, 'src/long.ts'],
    [`env --split-string="bash -c 'echo x > src/attached.ts'"`, 'src/attached.ts'],
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

  it('fails closed when env split-string cannot be parsed as literal argv', () => {
    expect(parseShellCommand(`env -S 'bash $RUNNER'`)).toMatchObject({
      parsingFailed: true,
      failureReason: 'env --split-string contains a non-literal word',
    });
  });

  it.each([
    "chronic bash -c 'echo x > src/x.ts'",
    "pueue add sh -c 'echo x > src/x.ts'",
    "some-wrapper --flag bash -lc 'echo x > src/x.ts'",
  ])('keeps extracting write targets hidden behind an unknown launcher: %s', (command) => {
    const parsed = parseShellCommand(command);
    // The target has to reach the path policy, or Edit(src/**) / denied_paths never fire.
    expect(parsed.writeTargets).toEqual([expect.objectContaining({ path: 'src/x.ts' })]);
    // Still uncertain: we cannot know what the launcher itself does beyond running the shell.
    expect(parsed.uncertain.some((reason) => reason.startsWith('unknown-shell-launcher:'))).toBe(true);
  });

  it('a known wrapper reaches the same target without the unknown-launcher marker', () => {
    const parsed = parseShellCommand("doas -u me sh -c 'echo x > src/x.ts'");
    expect(parsed.writeTargets).toEqual([expect.objectContaining({ path: 'src/x.ts' })]);
    expect(parsed.uncertain.some((reason) => reason.startsWith('unknown-shell-launcher:'))).toBe(false);
  });

  it('does not treat a shell name used as a plain argument as a launcher', () => {
    expect(parseShellCommand('grep sh file')).toMatchObject({ writeTargets: [], uncertain: [] });
  });
});
