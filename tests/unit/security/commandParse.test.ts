import { describe, expect, it } from 'vitest';
import { lenientCommandWords, parseShellCommand } from '../../../src/host/security/commandParse';

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

  it("reads sudo's value-taking options so the wrapped write target survives", () => {
    // -D takes a value; reading it as a boolean flag made `all@debug` the program and lost tee's
    // target entirely — the shape that slipped past Edit(~/.ssh/**).
    expect(parseShellCommand('sudo -D all@debug tee ~/.ssh/authorized_keys')).toMatchObject({
      parsingFailed: false,
      writeTargets: [expect.objectContaining({ path: expect.stringContaining('authorized_keys') })],
    });
  });

  it.each([
    'sudo --not-a-real-option tee ~/.ssh/authorized_keys',
    'sudo -Q tee ~/.ssh/authorized_keys',
    'xargs --unknown-opt tee out.txt',
  ])('fails closed when a wrapper option arity is unknown: %s', (command) => {
    // Guessing "unknown option = boolean flag" is a bypass, not a guess: the next word becomes the
    // program and every write target after it disappears from the path policy.
    expect(parseShellCommand(command)).toMatchObject({ parsingFailed: true });
  });

  it.each([
    ['sudo -D /tmp tee out.txt', 'out.txt'],
    ['sudo -u me tee out.txt', 'out.txt'],
    ['sudo -En tee out.txt', 'out.txt'],
    ['sudo --preserve-env=PATH tee out.txt', 'out.txt'],
    ['nice -5 tee out.txt', 'out.txt'],
    ['xargs -0 tee out.txt', 'out.txt'],
  ])('still reads the wrapped write target for known options: %s', (command, target) => {
    expect(parseShellCommand(command)).toMatchObject({
      parsingFailed: false,
      writeTargets: [expect.objectContaining({ path: target })],
    });
  });

  it.each([
    ['sed -i.pem -e s/a/b/ allowed.txt', 'allowed.txt.pem'],
    ['sed --in-place=.bak -e s/a/b/ allowed.txt', 'allowed.txt.bak'],
  ])('counts the backup file sed -i actually creates: %s', (command, backup) => {
    // A filesystem deny on *.pem has to see allowed.txt.pem, not just allowed.txt.
    expect(parseShellCommand(command).writeTargets.map((t) => t.path))
      .toEqual(['allowed.txt', backup]);
  });

  it('a suffix-less sed -i still yields exactly one target', () => {
    expect(parseShellCommand('sed -i -e s/a/b/ allowed.txt').writeTargets.map((t) => t.path))
      .toEqual(['allowed.txt']);
  });

  it.each([
    'MODE=1 tee src/x.ts',
    'A=1 B=2 tee src/x.ts',
    "MODE=1 sed -i 's/a/b/' src/x.ts",
  ])('strips leading env assignments so the real write target survives: %s', (command) => {
    // Reading MODE=1 as the program loses tee/sed's target and the path deny never fires.
    expect(parseShellCommand(command).writeTargets.map((t) => t.path)).toContain('src/x.ts');
  });

  it('a segment that is only assignments has no program and no target', () => {
    expect(parseShellCommand('MODE=1')).toMatchObject({ writeTargets: [] });
  });

  it('does not treat a shell name used as a plain argument as a launcher', () => {
    expect(parseShellCommand('grep sh file')).toMatchObject({ writeTargets: [], uncertain: [] });
  });

  it('restores a variable anywhere in a word instead of leaking an internal marker', () => {
    const parsed = parseShellCommand('printf x > /tmp/report-$USER.txt');
    expect(parsed.writeTargets).toEqual([
      { path: '/tmp/report-${USER}.txt', source: 'redirect', uncertain: true },
    ]);
    // A path handed to lstatSync must never carry control characters; round 15 crashed on U+0000.
    for (const target of parsed.writeTargets) expect([...target.path].some((c) => c.charCodeAt(0) < 0x20)).toBe(false);
    expect(parseShellCommand('echo $HOME').segments[0].words).toEqual(['echo', '${HOME}']);
  });

  it('decodes ANSI-C quoting before tokenizing so quote boundaries decide identity', () => {
    expect(parseShellCommand("$'ls'").segments[0].words).toEqual(['ls']);
    expect(parseShellCommand("$'\\x6c\\x73' -la").segments[0].words).toEqual(['ls', '-la']);
    expect(parseShellCommand(`$'l'"\\x73"`).segments[0].words).toEqual(['l\\x73']);
    expect(parseShellCommand("echo $'a\\'b'").segments[0].words).toEqual(['echo', "a'b"]);
    expect(parseShellCommand('"$"ls').segments[0].words).toEqual(['${}ls']);
    expect(parseShellCommand(`echo x > $'\\x72'"eport.txt"`).writeTargets)
      .toEqual([{ path: 'report.txt', source: 'redirect', uncertain: false }]);
  });

  it('consumes input redirections and keeps `<` operands as reads of the segment', () => {
    const parsed = parseShellCommand('sort < in.txt > out.txt; cat <<< here; exec 3<&0');
    expect(parsed.parsingFailed).toBe(false);
    expect(parsed.segments.map((segment) => segment.words)).toEqual([['sort'], ['cat'], ['exec']]);
    expect(parsed.segments[0].reads).toEqual([{ path: 'in.txt', uncertain: false }]);
    expect(parsed.writeTargets.map((target) => target.path)).toEqual(['out.txt']);
    expect(parseShellCommand('cat < $FILE').segments[0].reads).toEqual([{ path: '${FILE}', uncertain: true }]);
    // A heredoc delimiter is consumed; its body lines are ordinary lines and only ever add segments.
    expect(parseShellCommand('cat <<EOF\nrm -rf /\nEOF').segments.map((segment) => segment.words[0]))
      .toEqual(['cat', 'rm', 'EOF']);
  });

  it('exposes a lenient token view for risk scans when the strict parse fails', () => {
    expect(parseShellCommand('rm -rf ~/.ssh/id_rsa >| run.log').parsingFailed).toBe(true);
    expect(lenientCommandWords('rm -rf ~/.ssh/id_rsa >| run.log'))
      .toEqual(['rm', '-rf', '~/.ssh/id_rsa', '>', '|', 'run.log']);
    expect(lenientCommandWords('case x in a) rm -rf ~/.ssh/id_rsa;; esac')).toContain('~/.ssh/id_rsa');
    // shell-quote itself throws on `${` — fall back to the canonical whitespace split, still no words lost.
    expect(lenientCommandWords('ls ${')).toEqual(['ls', '${']);
    expect(lenientCommandWords('echo "a b" > $HOME/x')).toEqual(['echo', 'a b', '>', '${HOME}/x']);
  });

  it('keeps each redirection on its own segment', () => {
    const parsed = parseShellCommand('printf x > out.txt; ls; cat y >> log.txt');
    expect(parsed.segments.map((segment) => segment.redirects.map((target) => target.path)))
      .toEqual([['out.txt'], [], ['log.txt']]);
    expect(parsed.writeTargets.map((target) => target.path)).toEqual(['out.txt', 'log.txt']);
  });
});
