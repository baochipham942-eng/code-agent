import { describe, expect, it, vi, beforeEach } from 'vitest';

const { execSyncMock, execFileSyncMock } = vi.hoisted(() => ({
  execSyncMock: vi.fn(),
  execFileSyncMock: vi.fn(),
}));

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execSync: execSyncMock,
    execFileSync: execFileSyncMock,
  };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    platform: () => 'darwin',
    homedir: () => '/Users/tester',
  };
});

import { Seatbelt, generateProfile } from '../../../../src/host/sandbox/seatbelt';

describe('seatbelt sensitive deny-read profile', () => {
  beforeEach(() => {
    execSyncMock.mockImplementation((command: string) => {
      if (command.includes('which sandbox-exec')) return '/usr/bin/sandbox-exec\n';
      if (command.includes('sw_vers')) return '15.0\n';
      return '';
    });
    execFileSyncMock.mockReturnValue(Buffer.from(''));
  });

  it('places deny-read rules after allow default and before write confinement', () => {
    const profile = generateProfile({
      allowNetwork: false,
      readPaths: [],
      writePaths: ['/tmp/project'],
      executePaths: [],
      allowProcessExec: true,
      allowProcessFork: true,
      envPassthrough: [],
      customEnv: {},
      workingDirectory: '/tmp/project',
      sensitivePaths: [
        { kind: 'directory', path: '/Users/tester/.ssh' },
        { kind: 'file', path: '/Users/tester/.netrc' },
      ],
    });

    expect(profile.indexOf('(allow default)')).toBeLessThan(profile.indexOf('(deny file-read* (subpath "/Users/tester/.ssh"))'));
    expect(profile.indexOf('(deny file-read* (literal "/Users/tester/.netrc"))')).toBeLessThan(profile.indexOf('(deny file-write*)'));
  });

  it('preflights generated profiles and throws before returning a wrapped command', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('profile syntax invalid');
    });

    expect(() => new Seatbelt().wrapCommand('echo should-not-wrap', {
      workingDirectory: '/tmp/project',
      writePaths: ['/tmp/project'],
    })).toThrow(/sandbox-exec profile preflight failed/);
  });
});
