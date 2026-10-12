import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildSensitivePathMountArgs,
  getBubblewrap,
} from '../../../../src/host/sandbox/bubblewrap';
import { getForbiddenWritePathsUnderRoot } from '../../../../src/host/sandbox/sensitivePaths';

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

  it('overlays forbidden names read-only AFTER the rw bind of the escalated root (DIR-FORBIDDEN)', () => {
    // bwrap 按参数顺序应用挂载：ro-bind 必须排在授权根的 rw --bind 之后，才遮得住子树内的禁写名
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bwrap-dir-deny-'));
    try {
      const hooks = path.join(root, '.git', 'hooks');
      const npmrc = path.join(root, '.npmrc');
      fs.mkdirSync(hooks, { recursive: true });
      fs.writeFileSync(npmrc, 'registry=x');

      const bubblewrap = getBubblewrap();
      vi.spyOn(bubblewrap, 'checkAvailability').mockReturnValue({ available: true });
      const { command } = bubblewrap.wrapCommand('true', {
        readOnlyPaths: [],
        readWritePaths: [root],
        readOnlyOverlayPaths: getForbiddenWritePathsUnderRoot(root),
        envPassthrough: [],
        customEnv: {},
        sensitivePaths: [],
      });

      const bindIndex = command.indexOf(`--bind ${root} ${root}`);
      expect(bindIndex).toBeGreaterThanOrEqual(0);
      for (const overlay of [`--ro-bind ${hooks} ${hooks}`, `--ro-bind ${npmrc} ${npmrc}`]) {
        expect(command.indexOf(overlay), overlay).toBeGreaterThan(bindIndex);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
