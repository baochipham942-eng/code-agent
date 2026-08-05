import { describe, expect, it } from 'vitest';
import { resolveWorkingDirectory } from '../../../src/host/ipc/folderTrust.ipc';

describe('folder trust working directory resolution', () => {
  it('uses the same data-dir work folder as a default web session', async () => {
    expect(await resolveWorkingDirectory(undefined, () => ({
      getWorkingDirectory: () => '/tmp/bootstrap-cwd',
    } as never), {
      CODE_AGENT_WEB_MODE: 'true',
      CODE_AGENT_DATA_DIR: '/tmp/neo-data',
    })).toBe('/tmp/neo-data/work');
  });

  it('keeps an explicit session directory authoritative', async () => {
    expect(await resolveWorkingDirectory(
      { workingDirectory: '/tmp/session-workspace' },
      () => null,
      { CODE_AGENT_WEB_MODE: 'true', CODE_AGENT_DATA_DIR: '/tmp/neo-data' },
    )).toBe('/tmp/session-workspace');
  });

  it('desktop WEB_MODE + sessionId resolves to the session-bound project directory', async () => {
    // 桌面 app 恒 CODE_AGENT_WEB_MODE=true；信任评估对象必须是会话绑定的项目目录，
    // 而不是永远落到 <dataDir>/work。
    expect(await resolveWorkingDirectory(
      { sessionId: 'sess-project-1' },
      () => ({ getWorkingDirectory: () => '/tmp/bootstrap-cwd' } as never),
      { CODE_AGENT_WEB_MODE: 'true', CODE_AGENT_DATA_DIR: '/tmp/neo-data' },
      async (sessionId) => (sessionId === 'sess-project-1' ? '/Users/me/projects/real-app' : null),
    )).toBe('/Users/me/projects/real-app');
  });

  it('falls back to dataDir/work when sessionId cannot be resolved (no silent project-dir leak)', async () => {
    expect(await resolveWorkingDirectory(
      { sessionId: 'sess-missing' },
      () => ({ getWorkingDirectory: () => '/tmp/bootstrap-cwd' } as never),
      { CODE_AGENT_WEB_MODE: 'true', CODE_AGENT_DATA_DIR: '/tmp/neo-data' },
      async () => null,
    )).toBe('/tmp/neo-data/work');
  });

  it('falls back when session exists but has no workingDirectory', async () => {
    expect(await resolveWorkingDirectory(
      { sessionId: 'sess-empty-cwd' },
      () => ({ getWorkingDirectory: () => '/tmp/bootstrap-cwd' } as never),
      { CODE_AGENT_WEB_MODE: 'true', CODE_AGENT_DATA_DIR: '/tmp/neo-data' },
      async () => '   ',
    )).toBe('/tmp/neo-data/work');
  });

  it('explicit workingDirectory wins over sessionId', async () => {
    expect(await resolveWorkingDirectory(
      { sessionId: 'sess-project-1', workingDirectory: '/explicit/path' },
      () => null,
      { CODE_AGENT_WEB_MODE: 'true', CODE_AGENT_DATA_DIR: '/tmp/neo-data' },
      async () => '/Users/me/projects/real-app',
    )).toBe('/explicit/path');
  });

  it('non-web mode without session keeps app-level working directory', async () => {
    expect(await resolveWorkingDirectory(
      undefined,
      () => ({ getWorkingDirectory: () => '/app/level/cwd' } as never),
      { CODE_AGENT_WEB_MODE: 'false' },
    )).toBe('/app/level/cwd');
  });
});
