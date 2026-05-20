import { beforeEach, describe, expect, it, vi } from 'vitest';

const databaseMock = {
  listSessions: vi.fn(() => []),
  getMessages: vi.fn(() => []),
  getAllPreferences: vi.fn(() => ({})),
};

vi.mock('../../../../src/main/services/core', () => ({
  getDatabase: () => databaseMock,
}));

function mockFetchJson(body: unknown): void {
  const response = {
    ok: true,
    statusText: 'OK',
    json: async (): Promise<unknown> => body,
  } as Response;

  vi.stubGlobal('fetch', vi.fn(async () => response));
}

function mockFetchText(body: string): void {
  const response = {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async (): Promise<string> => body,
  } as Response;

  vi.stubGlobal('fetch', vi.fn(async () => response));
}

describe('CloudStorageService', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('stores the created gist id from a guarded GitHub response', async () => {
    const { CloudStorageService } = await import('../../../../src/main/services/sync/cloudStorageService');
    const service = new CloudStorageService();
    service.configure({ githubToken: 'token' });
    mockFetchJson({ id: 'gist-1' });

    await expect(service.syncToGist()).resolves.toBe(true);

    expect(service.getConfig().gistId).toBe('gist-1');
  });

  it('returns null when the GitHub gist does not contain the backup file', async () => {
    const { CloudStorageService } = await import('../../../../src/main/services/sync/cloudStorageService');
    const service = new CloudStorageService();
    service.configure({ githubToken: 'token', gistId: 'gist-1' });
    mockFetchJson({ files: {} });

    await expect(service.restoreFromGist()).resolves.toBeNull();
  });

  it('restores GitHub gist backup content without changing the payload', async () => {
    const { CloudStorageService } = await import('../../../../src/main/services/sync/cloudStorageService');
    const service = new CloudStorageService();
    service.configure({ githubToken: 'token', gistId: 'gist-1' });
    const backup = {
      version: '1.0.0',
      exportedAt: 123,
      sessions: [],
      messages: {},
      preferences: { theme: 'dark' },
      knowledge: {},
    };
    mockFetchJson({
      files: {
        'code-agent-backup.json': {
          content: JSON.stringify(backup),
        },
      },
    });

    await expect(service.restoreFromGist()).resolves.toEqual(backup);
  });

  it('restores WebDAV backup content without changing the payload', async () => {
    const { CloudStorageService } = await import('../../../../src/main/services/sync/cloudStorageService');
    const service = new CloudStorageService();
    service.configure({ provider: 'webdav', webdavUrl: 'https://dav.example.test' });
    const backup = {
      version: '1.0.0',
      exportedAt: 456,
      sessions: [],
      messages: {},
      preferences: { locale: 'zh-CN' },
      knowledge: {},
    };
    mockFetchText(JSON.stringify(backup));

    await expect(service.restoreFromWebDAV()).resolves.toEqual(backup);
  });
});
