import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import {
  buildSensitivePathMountArgs,
  getBubblewrap,
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

  it('mounts /tmp tmpfs before binding a nested npmHome', () => {
    const npmHome = fs.mkdtempSync('/tmp/neo-npm-mount-order-');
    try {
      const bubblewrap = getBubblewrap();
      vi.spyOn(bubblewrap, 'checkAvailability').mockReturnValue({ available: true });
      const { command } = bubblewrap.wrapCommand('true', {
        readOnlyPaths: [],
        readWritePaths: [npmHome],
        tmpfsPaths: ['/tmp'],
        envPassthrough: [],
        customEnv: {},
        sensitivePaths: [],
      });

      const tmpfsIndex = command.indexOf('--tmpfs /tmp');
      const npmHomeBindIndex = command.indexOf(`--bind ${npmHome} ${npmHome}`);
      expect(tmpfsIndex).toBeGreaterThanOrEqual(0);
      expect(npmHomeBindIndex).toBeGreaterThan(tmpfsIndex);
    } finally {
      fs.rmSync(npmHome, { recursive: true, force: true });
    }
  });
});
