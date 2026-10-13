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
  expect: 'target' | 'uncertain';
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

  it.each(['bash -oposix -c "ls"', 'zsh -opipefail -c "ls"', 'bash -Z -c "ls"'])(
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
