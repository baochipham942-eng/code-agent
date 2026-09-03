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

describe('commandSafety force-push flags', () => {
  it.each([
    'git push --force origin main',
    'git push -f origin main',
    'git push -fu origin main',
    'git push --force-with-lease origin main',
  ])('%s is high risk', (command) => {
    expect(validateCommand(command, 'posix')).toMatchObject({
      riskLevel: 'high',
      securityFlags: expect.arrayContaining(['git_force_push']),
    });
  });

  it('keeps a regular push at its existing safe risk level', () => {
    expect(validateCommand('git push origin feature/x', 'posix')).toMatchObject({
      riskLevel: 'safe',
      securityFlags: [],
    });
  });
});
