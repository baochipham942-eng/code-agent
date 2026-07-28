import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const { globMock, loggerInfoMock } = vi.hoisted(() => ({
  globMock: vi.fn(),
  loggerInfoMock: vi.fn(),
}));

vi.mock('glob', () => ({
  glob: (...args: unknown[]) => globMock(...args),
}));

vi.mock('../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: loggerInfoMock,
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { buildRepoMap } from '../../src/host/context/repoMap/repoMapBuilder';

let tempRoot: string | undefined;

beforeEach(() => {
  globMock.mockReset();
  globMock.mockResolvedValue([]);
  loggerInfoMock.mockReset();
});

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe('buildRepoMap home directory guard', () => {
  it('returns an empty map without calling glob for the home directory', async () => {
    const entries = await buildRepoMap({ rootDir: homedir() });

    expect(entries.size).toBe(0);
    expect(globMock).not.toHaveBeenCalled();
    expect(loggerInfoMock).toHaveBeenCalledWith(
      expect.stringContaining('skipped broad root'),
    );
  });

  it('still indexes source files in a normal project directory', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'repo-map-home-guard-'));
    await writeFile(
      join(tempRoot, 'index.ts'),
      'export function greet(name: string) { return `hello ${name}`; }\n',
    );
    globMock.mockResolvedValue(['index.ts']);

    const entries = await buildRepoMap({ rootDir: tempRoot });

    expect(globMock).toHaveBeenCalledTimes(1);
    expect(entries.get('index.ts')).toMatchObject({
      relativePath: 'index.ts',
      symbols: [
        {
          name: 'greet',
          kind: 'function',
          exported: true,
          signature: 'name: string',
          line: 1,
        },
      ],
    });
  });
});
