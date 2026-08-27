import { describe, expect, it } from 'vitest';
import { validateCommand } from '../../../src/host/security/commandSafety';

describe('commandSafety relative recursive delete evidence', () => {
  it.each([
    'rm -rf ./dist',
    'rm -fr build',
    'rm -r -f .cache',
    'rm --recursive --force output',
  ])('%s is high risk and carries the targeted-delete flag', (command) => {
    expect(validateCommand(command, 'posix')).toMatchObject({
      allowed: true,
      riskLevel: 'high',
      securityFlags: expect.arrayContaining(['recursive_delete_targeted']),
    });
  });
});
