import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isKnownSafeCommand, validateCommand } from '../../../src/host/security/commandSafety';

describe('commandSafety approval decision gaps', () => {
  it('does not put npm publish --dry-run in the execution-layer safe bypass', () => {
    expect(isKnownSafeCommand('npm publish --dry-run', 'posix')).toBe(false);
    expect(isKnownSafeCommand('npm publish', 'posix')).toBe(false);
  });

  it('only blocks dd when the output points at a device', () => {
    expect(validateCommand('dd if=/dev/zero of=./x.img', 'posix').allowed).toBe(true);
    for (const command of [
      'dd if=x of=/dev/disk2',
      'dd of=/dev/disk2 if=x',
      'timeout 5 dd if=x of=/dev/disk2',
    ]) {
      expect(validateCommand(command, 'posix')).toMatchObject({
        allowed: false,
        securityFlags: expect.arrayContaining(['dd_to_device']),
      });
    }
    expect(validateCommand('add of=/dev/null', 'posix').allowed).toBe(true);
  });

  it('uses resolved workspace paths for system-directory rm while failing closed without context', () => {
    const lexicalWork = fs.mkdtempSync(path.join(os.tmpdir(), 'command-safety-rm-'));
    const realWork = fs.realpathSync.native(lexicalWork);
    fs.mkdirSync(path.join(realWork, 'build'));
    const context = { workingDirectory: lexicalWork, workspaceRoot: lexicalWork };

    try {
      for (const command of [
        `rm -rf ${path.join(lexicalWork, 'build')}`,
        `rm -rf ${path.join(realWork, 'build')}`,
      ]) {
        expect(validateCommand(command, 'posix', context)).toMatchObject({
          allowed: true,
          riskLevel: 'high',
          securityFlags: expect.not.arrayContaining(['system_dir_delete']),
        });
      }

      expect(validateCommand('rm -rf /var/folders/approval-eval/build', 'posix').allowed).toBe(false);
      expect(validateCommand('rm -rf /private/var/folders/approval-eval/build', 'posix').allowed).toBe(false);
      expect(validateCommand('rm -rf /usr/local/lib', 'posix', {
        workingDirectory: '/usr/local',
      }).allowed).toBe(false);

      for (const target of [
        '/var/folders',
        '/private/tmp',
        lexicalWork,
        path.dirname(lexicalWork),
      ]) {
        expect(validateCommand(`rm -rf ${target}`, 'posix', context).allowed).toBe(false);
      }
    } finally {
      fs.rmSync(lexicalWork, { recursive: true, force: true });
    }
  });
});
