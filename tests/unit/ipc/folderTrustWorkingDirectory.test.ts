import { describe, expect, it } from 'vitest';
import { resolveWorkingDirectory } from '../../../src/host/ipc/folderTrust.ipc';

describe('folder trust working directory resolution', () => {
  it('uses the same data-dir work folder as a default web session', () => {
    expect(resolveWorkingDirectory(undefined, () => ({
      getWorkingDirectory: () => '/tmp/bootstrap-cwd',
    } as never), {
      CODE_AGENT_WEB_MODE: 'true',
      CODE_AGENT_DATA_DIR: '/tmp/neo-data',
    })).toBe('/tmp/neo-data/work');
  });

  it('keeps an explicit session directory authoritative', () => {
    expect(resolveWorkingDirectory(
      { workingDirectory: '/tmp/session-workspace' },
      () => null,
      { CODE_AGENT_WEB_MODE: 'true', CODE_AGENT_DATA_DIR: '/tmp/neo-data' },
    )).toBe('/tmp/session-workspace');
  });
});
