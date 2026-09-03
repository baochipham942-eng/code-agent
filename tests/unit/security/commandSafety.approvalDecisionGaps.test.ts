import { describe, expect, it } from 'vitest';
import { isKnownSafeCommand, validateCommand } from '../../../src/host/security/commandSafety';

describe('commandSafety approval decision gaps', () => {
  it('keeps npm publish --dry-run read-only without allowing a real publish', () => {
    expect(isKnownSafeCommand('npm publish --dry-run', 'posix')).toBe(true);
    expect(isKnownSafeCommand('npm publish', 'posix')).toBe(false);
  });

  it('only blocks dd when the output points at a device', () => {
    expect(validateCommand('dd if=/dev/zero of=./x.img', 'posix').allowed).toBe(true);
    expect(validateCommand('dd if=x of=/dev/disk2', 'posix')).toMatchObject({
      allowed: false,
      securityFlags: expect.arrayContaining(['dd_to_device']),
    });
  });
});
