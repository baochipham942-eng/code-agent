import { describe, expect, it } from 'vitest';
import { parseShellCommand } from '../../../src/host/security/commandParse';
import { isKnownSafeCommand } from '../../../src/host/security/commandSafety';

// FB-330: a shell wrapper option with an attached value (`bash -oposix -c "echo hi > /tmp/x"`)
// used to fall out of shellScript() as `null` — no write targets, no uncertain marker — so the
// write-path precheck approved it without asking. zsh really runs the attached form
// (`zsh -opipefail -c '…'` is a live bypass); bash/sh error out before running anything. Every
// wrapper form below must therefore either surface the redirect target or fail closed with an
// uncertain marker; never both empty.
const SCRIPT = 'echo hi > /tmp/x';

const SHELLS = ['bash', 'sh', 'zsh', 'dash'] as const;

type Form = {
  label: string;
  /** Absent when the option word itself carries the command letter; the script follows directly. */
  build?: (shell: string, script: string) => string;
  expect: 'target' | 'uncertain' | 'operand';
};

const FORMS: Form[] = [
  { label: '-oposix', build: (s, t) => `${s} -oposix -c "${t}"`, expect: 'target' },
  { label: '-o posix', build: (s, t) => `${s} -o posix -c "${t}"`, expect: 'target' },
  { label: '+o posix', build: (s, t) => `${s} +o posix -c "${t}"`, expect: 'target' },
  { label: '+oposix', build: (s, t) => `${s} +oposix -c "${t}"`, expect: 'target' },
  { label: '-Oextglob', build: (s, t) => `${s} -Oextglob -c "${t}"`, expect: 'target' },
  { label: '-O extglob', build: (s, t) => `${s} -O extglob -c "${t}"`, expect: 'target' },
  { label: '-eoposix', build: (s, t) => `${s} -eoposix -c "${t}"`, expect: 'target' },
  { label: '--norc', build: (s, t) => `${s} --norc -c "${t}"`, expect: 'target' },
  { label: '--rcfile=/dev/null', build: (s, t) => `${s} --rcfile=/dev/null -c "${t}"`, expect: 'target' },
  { label: '--rcfile /dev/null', build: (s, t) => `${s} --rcfile /dev/null -c "${t}"`, expect: 'target' },
  { label: '-ic', expect: 'target' },
  { label: '-lc', expect: 'target' },
  // Unknown flag letter with a `c` after it: `zsh -dc '…'` really runs (probed; bash/sh/dash die
  // on the unknown letter first), so the cluster carries the command string.
  { label: '-dc', build: (s, t) => `${s} -dc "${t}"`, expect: 'target' },
  { label: '+dc', build: (s, t) => `${s} +dc "${t}"`, expect: 'target' },
  // r2: on zsh `-O`/`+O` are plain flags (probed: `zsh -O c '…'` treats c as a file operand), so a
  // cluster ending in `c` (`-Oc`, `+Oc`, `-eOc`) carries the command flag and `zsh -Oc '…'` really
  // runs; bash/sh/dash die on the spelling first — exact on zsh, safe over-report elsewhere.
  { label: '-Oc', expect: 'target' },
  { label: '+Oc', expect: 'target' },
  { label: '-eOc', expect: 'target' },
  // Every shell reads the attached `c` as the -o value and errors (probed: `zsh -oc '…'` → "no
  // such option: c"), so the script word stays a file operand: uncertain, never both-empty.
  { label: '-oc', expect: 'operand' },
  { label: '-Z (unknown)', build: (s, t) => `${s} -Z -c "${t}"`, expect: 'uncertain' },
];

describe('shell wrapper startup options with attached values', () => {
  it.each(SHELLS.flatMap((shell) => FORMS.map((form) => [shell, form.label] as const)))(
    'never reports an empty shell: %s %s',
    (shell, label) => {
      const form = FORMS.find((candidate) => candidate.label === label)!;
      const command = form.build ? form.build(shell, SCRIPT) : `${shell} ${form.label} "${SCRIPT}"`;
      const parsed = parseShellCommand(command);
      expect(parsed.writeTargets.length + parsed.uncertain.length).toBeGreaterThan(0);
      if (form.expect === 'target') {
        expect(parsed.writeTargets).toEqual(expect.arrayContaining([
          expect.objectContaining({ path: '/tmp/x' }),
        ]));
        expect(parsed.uncertain).not.toContain(`shell-option-unknown:${shell}`);
      } else if (form.expect === 'operand') {
        expect(parsed.uncertain).toContain('shell-script-operand');
      } else {
        expect(parsed.uncertain).toContain(`shell-option-unknown:${shell}`);
      }
    },
  );

  it('extracts the target from the zsh-runnable attached form (the live FB-330 bypass)', () => {
    // Probed on this machine: `zsh -opipefail -c '…'` really runs the script; bash's spelling of
    // the same shape errors out instead, which the old parser silently dropped to empty/empty.
    expect(parseShellCommand(`zsh -opipefail -c "${SCRIPT}"`).writeTargets)
      .toEqual([expect.objectContaining({ path: '/tmp/x' })]);
  });

  it('keeps extracting a write hidden behind an unknown launcher after an attached -O option', () => {
    // The old "word containing c" rule mistook -Ocheckwinsize for the -c flag itself and read the
    // NEXT word (`-c`) as the command string, losing the script's target.
    const parsed = parseShellCommand('chronic bash -Ocheckwinsize -c "echo x > src/x.ts"');
    expect(parsed.writeTargets).toEqual([expect.objectContaining({ path: 'src/x.ts' })]);
    expect(parsed.uncertain).toContain('unknown-shell-launcher:chronic');
  });

  it('extracts a write hidden behind an unknown launcher and an unknown-letter cluster (r1)', () => {
    // `zsh -d` is a real flag (probed: `zsh -dc 'echo x'` really runs), and the baseline launcher
    // probe `/^-[^-]*c[^-]*$/` matched `-dc`. Swapping in the strict letter allowlist made
    // isShellCommandOption('-dc') false, the launcher scan stopped firing, and the command parsed
    // to empty/empty — the FB-330 shape again, one wrapper out.
    const parsed = parseShellCommand("chronic zsh -dc 'echo x > src/x.ts'");
    expect(parsed.writeTargets).toEqual([expect.objectContaining({ path: 'src/x.ts' })]);
    expect(parsed.uncertain).toContain('unknown-shell-launcher:chronic');
  });

  it.each([
    'chronic zsh -Zc "echo x > src/x.ts"',
    'chronic zsh +dc "echo x > src/x.ts"',
    'chronic zsh +c "echo x > src/x.ts"',
    'doas sh -dc "echo x > src/x.ts"',
  ])('never reports an empty shell behind an unknown launcher: %s', (command) => {
    const parsed = parseShellCommand(command);
    expect(parsed.writeTargets.length + parsed.uncertain.length).toBeGreaterThan(0);
  });

  // r2: the value-letter clusters the r1 launcher scan dropped. `isShellCommandOption` answered
  // "not a command option" the moment it saw `o`/`O`, so behind an unknown launcher the scan never
  // fired and these parsed to empty/empty — for `-Oc`/`-oc` a net regression vs origin/main, whose
  // `/^-[^-]*c[^-]*$/` baseline matched them; `+Oc` was the same hole on the `+` side.
  it.each(SHELLS.flatMap((shell) => ['-Oc', '+Oc', '-oc', '-eOc'].map(
    (form) => `chronic ${shell} ${form} "echo x > src/x.ts"`,
  )))('never reports an empty shell behind an unknown launcher (value-letter cluster): %s',
    (command) => {
      const parsed = parseShellCommand(command);
      expect(parsed.writeTargets.length + parsed.uncertain.length).toBeGreaterThan(0);
    });

  it('extracts a write hidden behind an unknown launcher after a value-letter O cluster (r2)', () => {
    // origin/main extracted src/x.ts here; the r1 scan answered "not a command option" for `-Oc`
    // and the command parsed to empty/empty, so the write skipped the path policy entirely.
    const parsed = parseShellCommand('chronic zsh -Oc "echo x > src/x.ts"');
    expect(parsed.writeTargets).toEqual([expect.objectContaining({ path: 'src/x.ts' })]);
    expect(parsed.uncertain).toContain('unknown-shell-launcher:chronic');
  });

  it('marks the +c spelling uncertain behind an unknown launcher instead of empty/empty', () => {
    // `zsh +c '…'` really runs too (probed), but the bare `+c` word stays unclassified by design;
    // the launcher scan must still fire so the command never parses to empty/empty.
    const parsed = parseShellCommand('chronic zsh +c "echo x > src/x.ts"');
    expect(parsed.uncertain).toEqual(expect.arrayContaining([
      'unknown-shell-launcher:chronic',
      'shell-option-unknown:zsh',
    ]));
  });

  it.each(['bash -oposix -c "ls"', 'zsh -opipefail -c "ls"', 'bash -Z -c "ls"', 'zsh -dc "ls"',
    'zsh -Oc "ls"', 'zsh +Oc "ls"'])(
    'cannot lend an approval identity through an attached or unclassifiable option: %s',
    (command) => {
      expect(isKnownSafeCommand(command)).toBe(false);
    },
  );

  it.each(['bash -c "echo ok"', 'bash -lc "echo ok"'])(
    'keeps the baseline forms approval-qualified and target-clean: %s',
    (command) => {
      expect(parseShellCommand(command)).toMatchObject({ parsingFailed: false, uncertain: [] });
      expect(isKnownSafeCommand(command)).toBe(true);
    },
  );

  it.each(['bash -o posix -c "echo ok"', 'bash --rcfile /dev/null -c "echo ok"',
    'bash -oposix -c "echo ok"'])(
    'startup-option forms stay approval-qualified only as far as the baseline allows: %s',
    (command) => {
      expect(parseShellCommand(command)).toMatchObject({ parsingFailed: false, uncertain: [] });
      expect(isKnownSafeCommand(command)).toBe(false);
    },
  );

  it('unchanged for a script file operand', () => {
    expect(parseShellCommand('bash cleanup.sh --flag')).toMatchObject({
      uncertain: ['shell-script-operand'],
    });
  });
});
