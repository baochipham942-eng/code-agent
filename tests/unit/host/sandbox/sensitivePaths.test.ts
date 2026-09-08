import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CONFIG_DIR_NEW } from '../../../../src/shared/constants/configDir';
import { MAX_DEV_SLOT, devSlotDataDirName } from '../../../../src/shared/devSlot';
import {
  getSensitiveSandboxPaths,
  isSensitiveCredentialPath,
  isPathDeniedBySensitiveSandboxPath,
  isProtectedWritePath,
} from '../../../../src/host/sandbox/sensitivePaths';

describe('sensitive sandbox paths', () => {
  beforeEach(() => {
    isProtectedWritePath.resetCacheForTest();
  });

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
      expect(entries).toContainEqual({ kind: 'file', path: path.join(home, '.npmrc') });
      expect(entries).toContainEqual({ kind: 'file', path: path.join(home, '.env.local') });
      expect(entries).toContainEqual({ kind: 'file', path: path.join(home, 'id_ed25519_agent') });
      expect(isPathDeniedBySensitiveSandboxPath(path.join(home, '.ssh', 'config'), entries)).toBe(true);
      expect(isPathDeniedBySensitiveSandboxPath(path.join(workspace, '.env'), entries)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('covers production, every dev slot, and explicit CODE_AGENT_DATA_DIR secret files', () => {
    const home = '/Users/tester';
    const explicitDataDir = '/tmp/code-agent-data';
    const entries = getSensitiveSandboxPaths({
      homeDir: home,
      env: { CODE_AGENT_DATA_DIR: explicitDataDir },
    });

    const dataDirs = [
      explicitDataDir,
      path.join(home, CONFIG_DIR_NEW),
      ...Array.from({ length: MAX_DEV_SLOT }, (_, index) => (
        path.join(home, devSlotDataDirName(index + 1))
      )),
    ];
    for (const dataDir of dataDirs) {
      expect(entries).toContainEqual({ kind: 'file', path: path.join(dataDir, '.secure-key') });
      expect(entries).toContainEqual({ kind: 'file', path: path.join(dataDir, 'secure-storage.json') });
      expect(entries).toContainEqual({ kind: 'file', path: path.join(dataDir, '.env') });
      expect(entries).toContainEqual({ kind: 'file', path: path.join(dataDir, 'code-agent.db') });
    }
  });

  it('classifies credential read targets without depending on file existence', () => {
    const home = '/Users/tester';
    const project = '/Users/tester/work/repo';

    expect(isSensitiveCredentialPath('/Users/tester/.aws/credentials', { homeDir: home, projectRoot: project })).toBe(true);
    expect(isSensitiveCredentialPath('/Users/tester/.npmrc', { homeDir: home, projectRoot: project })).toBe(true);
    expect(isSensitiveCredentialPath('/Users/tester/work/repo/.env.local', { homeDir: home, projectRoot: project })).toBe(true);
    expect(isSensitiveCredentialPath('/Users/tester/work/repo/.env.example', { homeDir: home, projectRoot: project })).toBe(true);
    expect(isSensitiveCredentialPath('/Users/tester/work/repo/.envrc', { homeDir: home, projectRoot: project })).toBe(true);
    expect(isSensitiveCredentialPath('/Users/tester/work/repo/README.md', { homeDir: home, projectRoot: project })).toBe(false);
  });

  it('folds .env* credential basenames so case-insensitive FS cannot bypass', () => {
    const home = '/Users/tester';
    const project = '/Users/tester/work/repo';
    const opts = { homeDir: home, projectRoot: project };

    expect(isSensitiveCredentialPath(path.join(project, '.ENV'), opts)).toBe(true);
    expect(isSensitiveCredentialPath(path.join(project, '.Env.local'), opts)).toBe(true);
    expect(isSensitiveCredentialPath(path.join(project, '.ENVRC'), opts)).toBe(true);
    expect(isSensitiveCredentialPath(path.join(home, '.ENV'), opts)).toBe(true);
  });

  it('classifies Neo constraint files and workspace git/npm config as protected writes', () => {
    const home = '/Users/tester';
    const project = '/Users/tester/work/repo';
    const dataDir = '/tmp/code-agent-data';
    const opts = { homeDir: home, projectRoot: project, env: { CODE_AGENT_DATA_DIR: dataDir } };

    expect(isProtectedWritePath(path.join(dataDir, 'settings.json'), opts)).toBe(true);
    expect(isProtectedWritePath(path.join(dataDir, 'settings.local.json'), opts)).toBe(true);
    expect(isProtectedWritePath(path.join(dataDir, 'policy.toml'), opts)).toBe(true);
    expect(isProtectedWritePath(path.join(dataDir, 'hooks', 'hooks.json'), opts)).toBe(true);
    expect(isProtectedWritePath(path.join(dataDir, 'session-permission-modes.json'), opts)).toBe(true);
    expect(isProtectedWritePath(path.join(dataDir, 'exec-policy.json'), opts)).toBe(true);
    expect(isProtectedWritePath(path.join(project, CONFIG_DIR_NEW, 'exec-policy.json'), opts)).toBe(true);
    expect(isProtectedWritePath(path.join(project, 'code-agent-policy.toml'), opts)).toBe(true);
    expect(isProtectedWritePath(path.join(project, '.git', 'config'), opts)).toBe(true);
    expect(isProtectedWritePath(path.join(project, '.gitconfig'), opts)).toBe(true);
    expect(isProtectedWritePath(path.join(project, '.npmrc'), opts)).toBe(true);
    expect(isProtectedWritePath(path.join(project, '.GIT', 'config'), opts)).toBe(true);
    expect(isProtectedWritePath(path.join(project, '.GitConfig'), opts)).toBe(true);
    expect(isProtectedWritePath(path.join(project, '.NPMRC'), opts)).toBe(true);
    expect(isProtectedWritePath(path.join(home, devSlotDataDirName(2), 'settings.json'), opts)).toBe(true);
    expect(isProtectedWritePath(path.join(home, devSlotDataDirName(9), 'policy.toml'), opts)).toBe(true);
    expect(isProtectedWritePath(path.join(project, 'notes.txt'), opts)).toBe(false);
    expect(isProtectedWritePath(path.join(dataDir, 'notes.txt'), opts)).toBe(false);
    expect(isProtectedWritePath(path.join(dataDir, 'code-agent-policy.toml'), opts)).toBe(false);
    expect(isProtectedWritePath(path.join(dataDir, CONFIG_DIR_NEW, 'exec-policy.json'), opts)).toBe(false);
  });
});
