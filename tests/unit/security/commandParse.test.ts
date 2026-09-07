import { describe, expect, it } from 'vitest';
import { lenientCommandWords, parseShellCommand } from '../../../src/host/security/commandParse';
import { decodeAnsiCQuotedBody } from '../../../src/host/security/canonicalizeCommand';

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

  it('a suffix-less GNU sed -i gains the BSD suffix reading as an extra target', () => {
    // GNU reads `sed -i -e s/a/b/ allowed.txt` as in-place with no backup. BSD `-i` consumes the
    // next word as the suffix — even `-e` (probe on macOS: the command writes `allowed.txt-e`).
    // The union keeps both: the GNU target and the BSD backup.
    expect(parseShellCommand('sed -i -e s/a/b/ allowed.txt').writeTargets.map((t) => t.path))
      .toEqual(['allowed.txt', 'allowed.txt-e']);
  });

  it('sees the backup a BSD separate-suffix sed -i creates', () => {
    // BSD probe: `sed -i .bak -e 's/x/y/' allowed.txt` rewrites allowed.txt and creates
    // allowed.txt.bak; GNU reads `.bak` as an in-place file instead — the union covers both.
    expect(parseShellCommand("sed -i .bak -e 's/x/y/' allowed.txt").writeTargets.map((t) => t.path))
      .toEqual(['.bak', 'allowed.txt', 'allowed.txt.bak']);
  });

  // Round 34: `--` ends the option region, so a `-`-leading word after it is a real write target
  // (real bash probe: `cp -- source.txt '-locked.txt'` creates `-locked.txt`; `tee --` likewise).
  it.each([
    ['cp -- source.txt -locked.txt', ['-locked.txt']],
    ['mv -- source.txt -locked.txt', ['-locked.txt']],
    ['tee -- -locked.txt', ['-locked.txt']],
    ['cp -t dir -- -src.txt', ['dir']],
  ])('honors the -- option terminator instead of filtering real targets: %s', (command, targets) => {
    expect(parseShellCommand(command)).toMatchObject({
      parsingFailed: false,
      writeTargets: targets.map((target) => expect.objectContaining({ path: target })),
    });
  });

  // Round 34: attached value options carry the script, so the file after them is the edit target
  // (real bash probe: `sed -i.bak -e's/x/y/' target.txt` rewrites target.txt and keeps target.txt.bak;
  // `-f'build/script.sed'` reads the script file but never writes it).
  it.each([
    ["sed -i.bak -e's/x/y/' src/x.ts", ['src/x.ts', 'src/x.ts.bak']],
    ["sed -i.bak -f'build/script.sed' src/x.ts", ['src/x.ts', 'src/x.ts.bak']],
    ["sed --in-place=.bak --expression='s/x/y/' src/x.ts", ['src/x.ts', 'src/x.ts.bak']],
    ["sed -i '' -e's/x/y/' src/x.ts", ['src/x.ts']],
  ])('reads attached sed script options without losing the edit target: %s', (command, targets) => {
    expect(parseShellCommand(command).writeTargets.map((t) => t.path)).toEqual(targets);
  });

  it.each([
    'cp --bogus-opt source.txt target.txt',
    'tee --bogus out.txt',
    "sed -i.bak --bogus 's/x/y/' src/x.ts",
    "sed -i.bak -e's/x/y/' --out-of-place src/x.ts",
  ])('fails closed when a write-command option arity is unknown: %s', (command) => {
    // Same rule as the wrapper allowlists: guessing the unknown option as a flag lets its value
    // swallow the real write target, so the scan must not return certain-but-wrong targets.
    expect(parseShellCommand(command)).toMatchObject({ parsingFailed: true });
  });

  it('does not fail a non-in-place sed on unknown options — stdout writes nothing', () => {
    expect(parseShellCommand("sed --bogus 's/x/y/' src/x.ts")).toMatchObject({
      parsingFailed: false,
      writeTargets: [],
    });
  });

  // Round 35: `-l` takes a value on GNU but is a bare flag on BSD — an unresolvable arity
  // conflict must fail closed whenever an in-place marker exists anywhere in argv; a truncated
  // scan can never prove `-i` is absent (`sed -H -i '' …` still rewrites the file on BSD).
  it.each([
    "sed -l -i '' -e 's/x/y/' src/x.ts",
    "sed -i.bak -l 80 's/x/y/' src/x.ts",
  ])('fails closed when in-place sed carries an option of unresolvable arity: %s', (command) => {
    expect(parseShellCommand(command)).toMatchObject({ parsingFailed: true });
  });

  it('reads BSD sed -H as a flag and keeps the in-place target', () => {
    // macOS sed documents -H (enhanced regex); BSD probe: `sed -H -i '' -e 's/x/y/' f` rewrites f.
    expect(parseShellCommand("sed -H -i '' -e 's/x/y/' src/x.ts")).toMatchObject({
      parsingFailed: false,
      writeTargets: [expect.objectContaining({ path: 'src/x.ts' })],
    });
  });

  // Rounds 38-41: a word-free command (bare `2>&1`, redirect-only `> out.txt`) is legal bash and
  // still carries its list terminator. Keeping the segment preserves every control-flow boundary:
  // a backgrounded `&` stays visible to the cwd walk, a pipe keeps the next segment's pipeline
  // membership, and a `;` keeps the two lists apart so a later `&` cannot scope over an earlier cd.
  it.each([
    ['cd /tmp && 2>&1 & cat .ssh/id_rsa', ['&&', '&', null]],
    ['cd /tmp && > out.txt & cat .ssh/id_rsa', ['&&', '&', null]],
    ['2>&1 | cd /tmp; cat .ssh/id_rsa', ['|', ';', null]],
    ['cd ~ && 2>&1; cat .ssh/id_rsa & echo ok', ['&&', ';', '&', null]],
  ])('keeps a word-free segment and its list terminator: %s', (command, terminators) => {
    const parsed = parseShellCommand(command);
    expect(parsed.parsingFailed).toBe(false);
    expect(parsed.segments.map((segment) => segment.terminator)).toEqual(terminators);
  });

  it('still extracts the write target of a redirect-only command', () => {
    expect(parseShellCommand('> out.txt').writeTargets.map((t) => t.path)).toEqual(['out.txt']);
  });

  it.each([
    'echo hi 2>&1',
    'echo hi; ',
    '> out.txt',
    'echo ok\nls',
    'echo ok;\nls',
  ])('does not fail commands whose dropped empties carry no background boundary: %s', (command) => {
    expect(parseShellCommand(command)).toMatchObject({ parsingFailed: false });
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
    // A heredoc body is its command's stdin and cannot be told apart from commands here: the
    // strict parse fails (round 33) and risk scans fall back to lenientCommandWords() — the
    // delimiter is consumed either way, and no word of the body is lost.
    const heredoc = parseShellCommand('cat <<EOF\nrm -rf /\nEOF');
    expect(heredoc.parsingFailed).toBe(true);
    expect(heredoc.failureReason).toBe('here-document body is not separable from commands');
    expect(lenientCommandWords('cat <<EOF\nrm -rf /\nEOF')).toEqual(expect.arrayContaining(['rm', '-rf', '/']));
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

  it('decodes ANSI-C escapes only: whitespace and Unicode stay part of the word identity', () => {
    expect(parseShellCommand("l$' 's").segments[0].words).toEqual(['l s']);
    expect(parseShellCommand("echo $'a  b\\tc'").segments[0].words).toEqual(['echo', 'a  b\tc']);
    expect(parseShellCommand("$'ｌｓ'").segments[0].words).toEqual(['ｌｓ']);
    expect(parseShellCommand("l$'\\u200b's").segments[0].words).toEqual(['l\u200bs']);
    expect(parseShellCommand("printf x > $'a b.txt'").writeTargets)
      .toEqual([{ path: 'a b.txt', source: 'redirect', uncertain: false }]);
    expect(decodeAnsiCQuotedBody("\\x6c\\x73 \\'x\\'")).toEqual({ text: "ls 'x'" });
    expect(decodeAnsiCQuotedBody('abc\\')).toMatchObject({ failureReason: 'trailing escape in ANSI-C quoted word' });
  });

  it('treats only bash whitespace as a word boundary, never JS `\\s` extras like U+00A0', () => {
    // bash: `ok\u00a0#tag` is one word, `#` inside a word is literal, so `./cleanup` really runs.
    const nbsp = parseShellCommand('echo ok\u00a0#tag; ./cleanup');
    expect(nbsp.executions.map((e) => e.program)).toEqual(['echo', './cleanup']);
    expect(nbsp.segments[0].words).toEqual(['echo', 'ok\u00a0#tag']);
    expect(parseShellCommand('echo ok\u000b#tag; ./cleanup').executions.map((e) => e.program)).toEqual(['echo', './cleanup']);
    expect(parseShellCommand('echo a\u00a0b\u3000c').segments[0].words).toEqual(['echo', 'a\u00a0b\u3000c']);
    // A bare carriage return is a word byte to bash as well — no `\\\r` form is ever a
    // continuation, `\<LF>` alone is (round 31).
    expect(parseShellCommand('echo ok\r#tag; ./cleanup').executions.map((e) => e.program)).toEqual(['echo', './cleanup']);
    expect(parseShellCommand('echo a\rb').segments[0].words).toEqual(['echo', 'a\rb']);
    // A real space before `#` does start a comment; bash never reaches `./cleanup` here.
    expect(parseShellCommand('echo ok #tag; ./cleanup').executions.map((e) => e.program)).toEqual(['echo']);
  });

  // Rounds 20–22 were three members of one family, so pin the whole family: every character JS `\\s`
  // matches that bash does not split on, in every position where it could reach shell-quote.
  const NON_BASH_WHITESPACE = Array.from({ length: 0x10000 }, (_, code) => String.fromCharCode(code))
    .filter((character) => /\s/.test(character) && !/[ \t\n]/.test(character));

  it.each(NON_BASH_WHITESPACE.map((character) => [`U+${character.charCodeAt(0).toString(16).padStart(4, '0')}`, character]))(
    'a JS-whitespace byte bash does not split on stays inside the word: %s', (_label, ws) => {
      expect(parseShellCommand(`echo a${ws}b`).segments[0].words).toEqual(['echo', `a${ws}b`]);
      expect(parseShellCommand(`echo a\\${ws}b`).segments[0].words).toEqual(['echo', `a${ws}b`]);
      expect(parseShellCommand(`ls${ws}/run-task`).segments[0].words).toEqual([`ls${ws}/run-task`]);
      expect(parseShellCommand(`ls\\${ws}/run-task`).segments[0].words).toEqual([`ls${ws}/run-task`]);
      const comment = parseShellCommand(`echo ok${ws}#tag; ./cleanup`);
      expect(comment.executions.map((e) => e.program)).toEqual(['echo', './cleanup']);
      expect(comment.segments[0].words).toEqual(['echo', `ok${ws}#tag`]);
    },
  );

  it('tells `&>file` apart from a background `&` followed by a redirect on the next command', () => {
    expect(parseShellCommand('printf x &> out.txt').writeTargets.map((t) => t.path)).toEqual(['out.txt']);
    expect(parseShellCommand('printf x &>> out.txt').writeTargets.map((t) => t.path)).toEqual(['out.txt']);
    const spaced = parseShellCommand('echo ok & > /dev/null cp source.txt target.txt');
    expect(spaced.segments.map((segment) => segment.words)).toEqual([['echo', 'ok'], ['cp', 'source.txt', 'target.txt']]);
    expect(spaced.writeTargets.map((t) => t.path)).toEqual(['/dev/null', 'target.txt']);
  });

  it('reads an IO number across a line continuation before the redirect operator', () => {
    for (const command of ['cp source.txt target.txt 2\\\n>&1', 'cp source.txt target.txt 2\\\n\\\n>&1']) {
      const parsed = parseShellCommand(command);
      expect(parsed.parsingFailed).toBe(false);
      expect(parsed.writeTargets).toEqual([{ path: 'target.txt', source: 'copy', uncertain: false }]);
    }
    expect(parseShellCommand('echo x 2\\\n> err.log').writeTargets.map((t) => t.path)).toEqual(['err.log']);
    // A quoted or space-separated digit is still an operand, not an IO number.
    expect(parseShellCommand("echo x '2'> two.txt").segments[0].words).toEqual(['echo', 'x', '2']);
    expect(parseShellCommand('echo x 2 > two.txt').segments[0].words).toEqual(['echo', 'x', '2']);
    // `\<CR>` is an escaped word byte to bash, not half a continuation: the digit stays an operand
    // and `>&1` starts a new line, so the copy destination is the literal `2\r` file. Real bash
    // (3.2, probe): cp reports `2\r: Not a directory`; the old expectation `target.txt` was the
    // round-24 house rule, which round 31 overturned.
    const crlf = parseShellCommand('cp source.txt target.txt 2\\\r\n>&1');
    expect(crlf.parsingFailed).toBe(false);
    expect(crlf.segments[0].words).toEqual(['cp', 'source.txt', 'target.txt', '2\r']);
    expect(crlf.writeTargets).toEqual([{ path: '2\r', source: 'copy', uncertain: false }]);
  });

  it('消除未引号续行后再解析所有前瞻形态', () => {
    expect(parseShellCommand('cp a b 2\\\n2>&1').segments[0].words).toEqual(['cp', 'a', 'b']);
    // `2\<LF>&1`（探针 02）——上一版这里多打了一个 `>`，测的是 `2>>&1`
    const opFold = parseShellCommand('cp a b 2\\\n>&1');
    expect(opFold.parsingFailed).toBe(false);
    expect(opFold.writeTargets.map((t) => t.path)).toEqual(['b']);
    expect(parseShellCommand('cp a b \\\n2>&1').writeTargets.map((t) => t.path)).toEqual(['b']);
    expect(parseShellCommand('$\\\n\'ls\'').segments[0].words).toEqual(['ls']);
    const ampFold = parseShellCommand('printf x &\\\n> out.txt');
    expect(ampFold.segments).toHaveLength(1);
    expect(ampFold.writeTargets.map((t) => t.path)).toEqual(['out.txt']);
    expect(parseShellCommand('echo ok \\\n#tag; ./cleanup').executions.map((e) => e.program)).toEqual(['echo']);
    const wordHash = parseShellCommand('echo ok\\\n#tag; ./cleanup');
    expect(wordHash.segments[0].words).toEqual(['echo', 'ok#tag']);
    expect(wordHash.segments[1].words).toEqual(['./cleanup']);
    expect(parseShellCommand("echo 'a\\\nb'").segments[0].words).toEqual(['echo', 'a\\\nb']);
    expect(parseShellCommand('echo "a\\\nb"').segments[0].words).toEqual(['echo', 'ab']);
    // `\<LF>` folds, then `\<CR>` is a word byte and the LF after it a separator: bash runs
    // `ls\r` and `-la` as two commands (probe: `-la: command not found`).
    const crlfAfterFold = parseShellCommand("ls\\\n\\\r\n-la");
    expect(crlfAfterFold.segments[0].words).toEqual(['ls\r']);
    expect(crlfAfterFold.segments[1].words).toEqual(['-la']);
  });

  // Round 31: `\<CR>` is never a continuation byte. Real bash (3.2, probes): the escaped CR
  // stays inside the word, the LF after it is the command boundary — so a CRLF cannot splice
  // two commands into one, and a redirect's IO number cannot be smuggled across it.
  it('`\\<CR>` 是词内字节，LF 才是命令边界（真 bash 核对）', () => {
    const parsed = parseShellCommand('echo ok\\\r\ncp source.txt target.txt');
    expect(parsed.parsingFailed).toBe(false);
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[0].words).toEqual(['echo', 'ok\r']);
    expect(parsed.segments[1].words).toEqual(['cp', 'source.txt', 'target.txt']);
    expect(parsed.writeTargets).toEqual([{ path: 'target.txt', source: 'copy', uncertain: false }]);
    // Contrast with round 27's `$\\<LF>'ls'`: there the fold makes it an ANSI-C opener; across a
    // `\\<CR><LF>` bash keeps `$\r` a word and `'ls'` starts the next line (probe: word `$\r`).
    // The lone `$` carries the round-15 empty-key marker, like `"$"ls` above.
    const dollarCrlf = parseShellCommand("echo $\\\r\n'ls'");
    expect(dollarCrlf.segments[0].words).toEqual(['echo', '${}\r']);
    expect(dollarCrlf.segments[1].words).toEqual(['ls']);
  });

  // 折叠这一遍自身的引号/注释保真度，逐条先在真 bash（3.2.57，set -- + printf %q 打词）核过：
  // `\'` 不开引号、`\\<LF>` 是分隔符不是续行、注释在裸换行处结束（不折叠进去）、ANSI-C 内 `\'`
  // 不闭合且 `\<LF>` 原样保留、`$""` 按双引号折叠。
  it('折叠保持引号与注释状态不漂移（真 bash 核对）', () => {
    // bash: `set -- don\'t e\<LF>f` → 词 don't、ef
    expect(parseShellCommand("set -- don\\'t e\\\nf").segments[0].words).toEqual(['set', '--', "don't", 'ef']);
    // bash: `$'a\'b' c\<LF>d` → 词 a'b、cd（ANSI-C 内转义引号不闭合）
    expect(parseShellCommand("$'a\\'b' c\\\nd").segments[0].words).toEqual(["a'b", 'cd']);
    // `\'` 在前不污染后续折叠：IO 数字照样合成（bash: `…; set -- x y 2\<LF>>&1` → 词 x、y）
    const afterEscQuote = parseShellCommand("echo a\\'b c; cp x y 2\\\n2>&1");
    expect(afterEscQuote.segments[1].words).toEqual(['cp', 'x', 'y']);
    expect(afterEscQuote.writeTargets.map((t) => t.path)).toEqual(['y']);
    // 注释在裸换行处结束，第二行是真命令（bash 实跑 `t: command not found` 与 SIDE）
    expect(parseShellCommand("echo hi # don't\\\nt; echo SIDE").executions.map((e) => e.program)).toEqual(['echo', 't', 'echo']);
    expect(parseShellCommand('echo hi # c\\\necho SIDE').executions.map((e) => e.program)).toEqual(['echo', 'echo']);
    // `\\` 是转义反斜杠：后面的换行是命令分隔符，不是续行（bash: 词 a\ + 第二行 echo SIDE）
    const doubleBackslash = parseShellCommand('a\\\\\necho SIDE');
    expect(doubleBackslash.segments[0].words).toEqual(['a\\']);
    expect(doubleBackslash.segments[1].words).toEqual(['echo', 'SIDE']);
    // `$"…"` 按双引号折叠（bash: 词 ab）；双引号内 `\"` 不闭合（bash: 词 x"yz）
    expect(parseShellCommand('set -- $"a\\\nb"').segments[0].words).toEqual(['set', '--', 'ab']);
    expect(parseShellCommand('set -- "x\\"y\\\nz"').segments[0].words).toEqual(['set', '--', 'x"yz']);
    // ANSI-C 里 `\<LF>` 原样保留：词含换行不拆（bash 词是 a\+LF+b；解码器对未命名转义丢反斜杠是既有行为）
    expect(parseShellCommand("echo $'a\\\nb'").segments[0].words).toEqual(['echo', 'a\nb']);
    // `\<CR>` 不是续行的一半：真 bash 3.2 判词为 `a\r`，LF 之后 `b` 是独立命令（探针实跑核对）
    const crlfWord = parseShellCommand('set -- a\\\r\nb');
    expect(crlfWord.segments[0].words).toEqual(['set', '--', 'a\r']);
    expect(crlfWord.segments[1].words).toEqual(['b']);
    // 第 27 轮：`$\<LF>'` 折叠后才相邻，ANSI-C 开引号要在折叠后的相邻关系上认。
    // 真 bash 实跑词恰为 [cp source.txt target.txt]（`22>&1` 是 IO 数字），写目标 target.txt。
    const foldedAnsiOpener = parseShellCommand("echo $\\\n'a\\'b'; cp source.txt target.txt 2\\\n2>&1 # '");
    expect(foldedAnsiOpener.segments[0].words).toEqual(['echo', "a'b"]);
    expect(foldedAnsiOpener.writeTargets).toEqual([{ path: 'target.txt', source: 'copy', uncertain: false }]);
    expect(foldedAnsiOpener.parsingFailed).toBe(false);
    expect(foldedAnsiOpener.uncertain).toEqual([]);
  });

  it('keeps each redirection on its own segment', () => {
    const parsed = parseShellCommand('printf x > out.txt; ls; cat y >> log.txt');
    expect(parsed.segments.map((segment) => segment.redirects.map((target) => target.path)))
      .toEqual([['out.txt'], [], ['log.txt']]);
    expect(parsed.writeTargets.map((target) => target.path)).toEqual(['out.txt', 'log.txt']);
  });

  // 第 32 轮：后台/管道/`||` 段的 cd 不传播 cwd。真 bash（3.2.57）用家目录/`/tmp` 两份探针文件
  // 核过：`cd /tmp & cat f`、`cd /tmp | cat f`、`cd /nonexistent || cat f`、`cd /tmp &<LF>cat f` 读的
  // 都是家目录的 f；`|&` 本机 bash 3.2 不支持，用 zsh 交叉核对（bash4+ 同义 `2>&1 |`，管道两成员
  // 都在子 shell 里）同样读家目录。只有 `;`、`&&`、换行之后才读 /tmp 的 f。
  it('terminator 逐段记录段后分隔符，末段为 null（真 bash 核对）', () => {
    expect(parseShellCommand('cd /tmp; cat x').segments.map((s) => s.terminator)).toEqual([';', null]);
    expect(parseShellCommand('cd /tmp && cat x').segments.map((s) => s.terminator)).toEqual(['&&', null]);
    expect(parseShellCommand('cd /tmp\ncat x').segments.map((s) => s.terminator)).toEqual(['\n', null]);
    expect(parseShellCommand('cd /tmp & cat x').segments.map((s) => s.terminator)).toEqual(['&', null]);
    expect(parseShellCommand('cd /tmp | cat x').segments.map((s) => s.terminator)).toEqual(['|', null]);
    expect(parseShellCommand('cd /tmp |& cat x').segments.map((s) => s.terminator)).toEqual(['|&', null]);
    expect(parseShellCommand('cd /nonexistent || cat x').segments.map((s) => s.terminator)).toEqual(['||', null]);
    // 后台 `&` 已把段封掉，其后的换行只是空段分隔，不覆盖 terminator。
    expect(parseShellCommand('cd /tmp &\ncat x').segments.map((s) => s.terminator)).toEqual(['&', null]);
    // 混排链上每段记自己紧跟的分隔符。
    expect(parseShellCommand('a; b & c | d && e || f |& g').segments.map((s) => s.terminator))
      .toEqual([';', '&', '|', '&&', '||', '|&', null]);
    expect(parseShellCommand('cd x').segments.map((s) => s.terminator)).toEqual([null]);
  });
});
