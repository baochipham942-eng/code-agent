import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getSensitiveSandboxPaths,
  isPathDeniedBySensitiveSandboxPath,
} from '../../../../src/host/sandbox/sensitivePaths';

describe('sensitive sandbox paths', () => {
  it('denies home-level secrets without denying workspace .env files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sensitive-paths-'));
    try {
      const home = path.join(root, 'home');
      const workspace = path.join(home, 'work', 'repo');
      fs.mkdirSync(workspace, { recursive: true });
      fs.writeFileSync(path.join(home, '.env.local'), 'HOME_SECRET=1');
      fs.writeFileSync(path.join(home, 'id_ed25519_agent'), 'PRIVATE KEY');
      fs.writeFileSync(path.join(workspace, '.env'), 'WORKSPACE_OK=1');

      const entries = getSensitiveSandboxPaths({
        homeDir: home,
        env: { CODE_AGENT_DATA_DIR: path.join(root, 'data') },
      });

      expect(entries).toContainEqual({ kind: 'directory', path: path.join(home, '.ssh') });
      expect(entries).toContainEqual({ kind: 'directory', path: path.join(home, '.config', 'gh') });
      expect(entries).toContainEqual({ kind: 'file', path: path.join(home, '.env.local') });
      expect(entries).toContainEqual({ kind: 'file', path: path.join(home, 'id_ed25519_agent') });
      expect(isPathDeniedBySensitiveSandboxPath(path.join(home, '.ssh', 'config'), entries)).toBe(true);
      expect(isPathDeniedBySensitiveSandboxPath(path.join(workspace, '.env'), entries)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('covers production, dev, and explicit CODE_AGENT_DATA_DIR secret files', () => {
    const home = '/Users/tester';
    const explicitDataDir = '/tmp/code-agent-data';
    const entries = getSensitiveSandboxPaths({
      homeDir: home,
      env: { CODE_AGENT_DATA_DIR: explicitDataDir },
    });

    for (const dataDir of [
      explicitDataDir,
      path.join(home, '.code-agent'),
      path.join(home, '.code-agent-dev'),
    ]) {
      expect(entries).toContainEqual({ kind: 'file', path: path.join(dataDir, '.secure-key') });
      expect(entries).toContainEqual({ kind: 'file', path: path.join(dataDir, 'secure-storage.json') });
      expect(entries).toContainEqual({ kind: 'file', path: path.join(dataDir, '.env') });
      expect(entries).toContainEqual({ kind: 'file', path: path.join(dataDir, 'code-agent.db') });
    }
  });
});
