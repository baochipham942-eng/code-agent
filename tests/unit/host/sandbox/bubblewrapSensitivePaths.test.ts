import { describe, expect, it, vi } from 'vitest';
import {
  buildSensitivePathMountArgs,
} from '../../../../src/host/sandbox/bubblewrap';

describe('bubblewrap sensitive path mounts', () => {
  it('covers sensitive directories with tmpfs and sensitive files with 000 placeholders', () => {
    const args = buildSensitivePathMountArgs({
      sensitivePaths: [
        { kind: 'directory', path: '/home/tester/.ssh' },
        { kind: 'file', path: '/home/tester/.netrc' },
      ],
      pathExists: () => true,
      statPath: (p) => ({
        isDirectory: () => p.endsWith('.ssh'),
        isFile: () => p.endsWith('.netrc'),
      }),
      preparePlaceholder: (target) => `/tmp/placeholders/${target.split('/').pop()}`,
    });

    expect(args).toEqual([
      '--tmpfs', '/home/tester/.ssh',
      '--ro-bind', '/tmp/placeholders/.netrc', '/home/tester/.netrc',
    ]);
  });

  it('fails closed when placeholder creation fails', () => {
    expect(() => buildSensitivePathMountArgs({
      sensitivePaths: [{ kind: 'file', path: '/home/tester/.npmrc' }],
      pathExists: () => false,
      statPath: vi.fn(),
      preparePlaceholder: () => {
        throw new Error('chmod failed');
      },
    })).toThrow(/Failed to prepare sensitive path placeholder/);
  });
});
