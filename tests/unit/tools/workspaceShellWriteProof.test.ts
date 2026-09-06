import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyProvenWorkspaceWrite } from '../../../src/host/tools/workspaceShellWriteProof';

describe('unambiguous workspace write concession', () => {
  let root: string;
  let work: string;
  const classify = (command: string) => classifyProvenWorkspaceWrite(command, {
    workingDirectory: work,
    workspaceRoot: work,
  }, 0);

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'approval-literal-')));
    work = path.join(root, 'work');
    mkdirSync(path.join(work, 'sub'), { recursive: true });
    mkdirSync(path.join(root, 'external', 'child'), { recursive: true });
    mkdirSync(path.join(work, 'd\u00a0'));
    mkdirSync(path.join(root, '"work"'));
    mkdirSync(path.join(root, 'ｗork'));
    symlinkSync(path.join(root, 'external', 'child'), path.join(work, 'link'), 'dir');
    symlinkSync(path.join(work, 'sub'), path.join(work, 'internal-link'), 'dir');
    symlinkSync(path.join(work, 'absent'), path.join(work, 'dangling'));
    writeFileSync(path.join(work, 'file'), 'existing');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each([
    'printf ok > out.txt',
    'printf ok >> out.txt',
    'MODE=1 tee mode.txt',
    'A=1 B=2 tee multi.txt',
    'printf ok > sub/out.txt',
    'printf ok > {{work}}/newfile.txt',
    'printf ok > {{work}}/internal-link/out.txt',
  ])('allows a literal target with a real parent: %s', (command) => {
    expect(classify(command.replaceAll('{{work}}', work))?.decision).toBe('approve');
  });

  it.each([
    ['quotes', 'printf ok > \'{{root}}/"work"/out.txt\''],
    ['unicode-homoglyph', 'printf ok > {{root}}/ｗork/out.txt'],
    ['option-terminator', 'MODE=1 tee -- -/../../outside.txt'],
    ['symlink-parent', 'printf ok > {{work}}/link/../out.txt'],
    ['unicode-whitespace', 'printf ok > {{work}}/d\u00a0/../../outside.txt'],
    ['ordinary-parent', 'printf ok > {{work}}/sub/../out.txt'],
    ['quoted-variable', 'printf ok > "$HOME/.ssh/x"'],
    ['external-tee', 'MODE=1 tee /etc/hosts'],
    ['external-redirect', 'printf ok > ~/.ssh/x'],
    ['quoted-internal', 'printf ok > "{{work}}/out.txt"'],
    ['ansi-c-quote', "printf ok > $'{{work}}/out.txt'"],
    ['escaped-target', 'printf ok > {{work}}/out\\.txt'],
    ['unicode-figure-space', 'printf ok > {{work}}/d\u2007/out.txt'],
    ['unicode-narrow-space', 'printf ok > {{work}}/d\u202f/out.txt'],
    ['external-symlink', 'printf ok > {{work}}/link/out.txt'],
    ['dangling-symlink', 'printf ok > {{work}}/dangling'],
    ['missing-parent', 'printf ok > {{work}}/missing/out.txt'],
    ['parent-is-file', 'printf ok > {{work}}/file/out.txt'],
    ['internal-after-terminator', 'MODE=1 tee -- {{work}}/out.txt'],
    ['leading-hyphen', 'printf ok > -out.txt'],
    ['glob', 'printf ok > {{work}}/*.txt'],
    ['variable', 'MODE=1 tee {{work}}/$FILE'],
  ])('requires confirmation for %s', (_shape, template) => {
    const command = template.replaceAll('{{work}}', work).replaceAll('{{root}}', root);
    // This is the production concession entry point, without an earlier classifier
    // guard masking a mutation in its own predicate.
    expect(classify(command)?.decision).toBe('ask');
  });

  it.each([
    'printf ok > {{work}}/out.txt',
    'printf ok >> {{work}}/out.txt',
    'MODE=1 tee {{work}}/mode.txt',
    'A=1 B=2 tee {{work}}/multi.txt',
  ])('normalizes both the workspace alias and target: %s', (template) => {
    const alias = path.join(root, 'work-alias');
    symlinkSync(work, alias, 'dir');
    for (const workspaceRoot of [alias, work]) {
      for (const targetRoot of [alias, work]) {
        const result = classifyProvenWorkspaceWrite(template.replaceAll('{{work}}', targetRoot), {
          workingDirectory: alias, workspaceRoot,
        }, 0);
        expect(result?.decision).toBe('approve');
      }
    }
  });

  it('does not reuse containment after a directory becomes a symlink', () => {
    const context = { workingDirectory: work, workspaceRoot: work, pathResolutionCache: new Map<string, string>() };
    const command = 'printf ok > sub/out.txt';
    expect(classifyProvenWorkspaceWrite(command, context, 0)?.decision).toBe('approve');
    rmSync(path.join(work, 'sub'), { recursive: true });
    symlinkSync(path.join(root, 'external'), path.join(work, 'sub'), 'dir');
    expect(lstatSync(path.join(work, 'sub')).isSymbolicLink()).toBe(true);
    expect(classifyProvenWorkspaceWrite(command, context, 0)?.decision).toBe('ask');
  });

  it('requires confirmation when the authoritative directory cannot resolve', () => {
    expect(classifyProvenWorkspaceWrite('printf ok > out.txt', {
      workingDirectory: work, workspaceRoot: path.join(root, 'missing'),
    }, 0)?.decision).toBe('ask');
  });
});
