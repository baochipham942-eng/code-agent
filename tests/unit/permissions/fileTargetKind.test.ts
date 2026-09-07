import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveFileTargetKind } from '../../../src/host/permissions/fileTargetKind';

const posix = process.platform !== 'win32';

describe('resolveFileTargetKind', () => {
  const dirs: string[] = [];

  function tmpDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'file-target-kind-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('empty / non-string input is unknown', () => {
    expect(resolveFileTargetKind(undefined)).toBe('unknown');
    expect(resolveFileTargetKind(null)).toBe('unknown');
    expect(resolveFileTargetKind('')).toBe('unknown');
    expect(resolveFileTargetKind('   ')).toBe('unknown');
    expect(resolveFileTargetKind(1)).toBe('unknown');
  });

  it('missing path is unknown, not device', () => {
    const missing = path.join(tmpDir(), 'does-not-exist.md');
    expect(resolveFileTargetKind(missing)).toBe('unknown');
  });

  it('ordinary file is regular', () => {
    const file = path.join(tmpDir(), 'report.md');
    writeFileSync(file, 'payload');
    expect(resolveFileTargetKind(file)).toBe('regular');
  });

  it('directory is regular (not a character device)', () => {
    const dir = tmpDir();
    expect(resolveFileTargetKind(dir)).toBe('regular');
  });

  it.skipIf(!posix)('/dev/null is a character device', () => {
    expect(resolveFileTargetKind('/dev/null')).toBe('device');
  });

  // Windows-side expectations (/dev/null → C:\dev\null → unknown, NUL → device) are not
  // asserted here: this repo's fleet and CI are POSIX, and skipIf-gated tests fail the
  // fast gate. Both cases fail closed to the overwrite warning.
  //
  // #1692 round 1: `/dev/` prefix is not a device predicate.
  it('/dev/shm-shaped ordinary file is not a device', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'dev', 'shm', 'report.md');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'payload');
    expect(resolveFileTargetKind(file)).toBe('regular');
    expect(resolveFileTargetKind('/dev/shm/report.md')).not.toBe('device');
  });

  // #1692 round 2: POSIX file named NUL is a regular file.
  it.skipIf(!posix)('POSIX file named NUL is regular, not a device', () => {
    const file = path.join(tmpDir(), 'NUL');
    writeFileSync(file, 'payload');
    expect(resolveFileTargetKind(file)).toBe('regular');
    expect(resolveFileTargetKind('NUL', path.dirname(file))).toBe('regular');
  });

  // #1692 round 3: backslash folding would treat a POSIX file named `\dev\null` as /dev/null.
  it.skipIf(!posix)('POSIX file whose name is \\dev\\null is regular', () => {
    const file = path.join(tmpDir(), '\\dev\\null');
    writeFileSync(file, 'payload');
    expect(resolveFileTargetKind(file)).toBe('regular');
    expect(resolveFileTargetKind('\\dev\\null', path.dirname(file))).toBe('regular');
  });

  // #1692 round 4 analog: a real file at .../dev/null is regular (Windows C:\dev\null).
  it('resolved .../dev/null regular file is not a device', () => {
    const file = path.join(tmpDir(), 'dev', 'null');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'payload');
    expect(resolveFileTargetKind(file)).toBe('regular');
  });

  it.skipIf(!posix)('symlink to /dev/null is regular (atomic rename replaces the link itself)', () => {
    const link = path.join(tmpDir(), 'link-to-null');
    symlinkSync('/dev/null', link);
    expect(resolveFileTargetKind(link)).toBe('regular');
  });

  it.skipIf(!posix)('trailing-space path classifies the spaced file, not the symlink without the space', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'sink ');
    const link = path.join(dir, 'sink');
    writeFileSync(file, 'payload');
    symlinkSync('/dev/null', link);
    expect(resolveFileTargetKind('sink ', dir)).toBe('regular');
    expect(resolveFileTargetKind(link)).toBe('regular');
  });

  it.skipIf(!posix)('whitespace-padded path is not trimmed into an existing different file', () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, 'report.md'), 'payload');
    // The tool would create a new file literally named ' report.md '; classifying the
    // trimmed name instead would borrow the existing file's kind.
    expect(resolveFileTargetKind(' report.md ', dir)).toBe('unknown');
    expect(resolveFileTargetKind('report.md', dir)).toBe('regular');
  });

  it.skipIf(!posix)('absolute path with symlinked component and .. classifies the lexical target like Write does', () => {
    const dir = tmpDir();
    const link = path.join(dir, 'link');
    symlinkSync('/dev', link);
    // Write resolves lexically: <dir>/link/../null collapses to <dir>/null, a regular
    // file. lstat on the un-normalized path would follow link/.. into /dev and miss
    // the real target. String concat on purpose: path.join would normalize `..` away
    // before the classifier ever sees it.
    const realFile = path.join(dir, 'null');
    writeFileSync(realFile, 'payload');
    expect(resolveFileTargetKind(`${link}/../null`)).toBe('regular');
  });

  it.skipIf(!posix)('write-through mode follows the symlink to the device (Append/read semantics)', () => {
    const dir = tmpDir();
    const link = path.join(dir, 'link-to-null');
    symlinkSync('/dev/null', link);
    expect(resolveFileTargetKind(link, process.cwd(), { writeMode: 'write-through' })).toBe('device');
    expect(resolveFileTargetKind(link)).toBe('regular');
  });

  it.skipIf(!posix)('expandTilde:false (Edit semantics) classifies the literal-~ target, not the home-dir one', () => {
    const dir = tmpDir();
    const workbench = path.join(dir, 'workbench');
    const devDir = path.join(workbench, 'dev');
    mkdirSync(workbench);
    mkdirSync(devDir);
    // Edit resolves '~/../dev/null' literally: <dir>/workbench/~/../dev/null collapses
    // to <dir>/workbench/dev/null — the regular file below. Tilde expansion would
    // instead start from the real home directory and land on a different target.
    writeFileSync(path.join(devDir, 'null'), 'payload');
    expect(resolveFileTargetKind('~/../dev/null', workbench, { expandTilde: false })).toBe('regular');
    expect(resolveFileTargetKind('/dev/null', workbench)).toBe('device');
  });

  it.skipIf(!posix)('write-through mode on a dangling symlink is unknown (nothing to write through to)', () => {
    const link = path.join(tmpDir(), 'dangling');
    symlinkSync(path.join(path.dirname(link), 'missing-target'), link);
    expect(resolveFileTargetKind(link, process.cwd(), { writeMode: 'write-through' })).toBe('unknown');
    expect(resolveFileTargetKind(link)).toBe('regular');
  });

  it.skipIf(!posix)('symlink to a regular file follows to regular', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'report.md');
    const link = path.join(dir, 'link-to-report');
    writeFileSync(file, 'payload');
    symlinkSync(file, link);
    expect(resolveFileTargetKind(link)).toBe('regular');
  });

  it.skipIf(!posix)('dangling symlink is regular (rename replaces the dead link)', () => {
    const link = path.join(tmpDir(), 'dangling');
    symlinkSync(path.join(path.dirname(link), 'missing-target'), link);
    expect(resolveFileTargetKind(link)).toBe('regular');
  });
});
