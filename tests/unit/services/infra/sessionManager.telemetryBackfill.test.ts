import { beforeEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';

const telemetryRows: Array<{ id: string; user_prompt: string; start_time: number }> = [];
const existingRows: Array<{ content: string }> = [];
const insertedMessages: Array<{ sessionId: string; message: Record<string, unknown> }> = [];

const rawDb = {
  prepare: vi.fn((sql: string) => ({
    all: vi.fn(() => sql.includes('FROM telemetry_turns') ? telemetryRows : existingRows),
  })),
};

const dbMock = {
  getDb: vi.fn(() => rawDb),
  addMessage: vi.fn((sessionId: string, message: Record<string, unknown>) => {
    insertedMessages.push({ sessionId, message });
  }),
};

vi.mock('../../../../src/host/platform', () => ({
  AppWindow: { getAllWindows: () => [] },
}));

vi.mock('../../../../src/host/services/core', () => ({
  getDatabase: () => dbMock,
}));

vi.mock('../../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({ clearSession: vi.fn() }),
}));

vi.mock('../../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => null }),
}));

vi.mock('../../../../src/host/services/infra/supabaseService', () => ({
  isSupabaseInitialized: () => false,
  getSupabase: () => null,
}));

async function backfill(sessionId = 'session-url-normalization'): Promise<number> {
  const { SessionManager } = await import('../../../../src/host/services/infra/sessionManager');
  const manager = new SessionManager();
  return (manager as unknown as {
    backfillMissingTelemetryUserPrompts(id: string): number;
  }).backfillMissingTelemetryUserPrompts(sessionId);
}

describe('SessionManager telemetry user prompt backfill', () => {
  beforeEach(() => {
    telemetryRows.length = 0;
    existingRows.length = 0;
    insertedMessages.length = 0;
    vi.clearAllMocks();
  });

  it('keeps one user message when telemetry normalized the same URL with a trailing slash', async () => {
    existingRows.push({ content: '检查 https://example.com 的页面' });
    telemetryRows.push({
      id: 'turn-url-slash',
      user_prompt: '检查 https://example.com/ 的页面',
      start_time: 1_785_600_000_000,
    });

    await expect(backfill()).resolves.toBe(0);

    expect(dbMock.addMessage).not.toHaveBeenCalled();
    expect(existingRows).toHaveLength(1);
    expect(insertedMessages).toHaveLength(0);
  });

  it('uses the same URL canonicalization for unicode and punycode hosts', async () => {
    existingRows.push({ content: '打开 https://例子.测试/path' });
    telemetryRows.push({
      id: 'turn-url-punycode',
      user_prompt: '打开 https://xn--fsqu00a.xn--0zwm56d/path',
      start_time: 1_785_600_000_100,
    });

    await expect(backfill()).resolves.toBe(0);

    expect(dbMock.addMessage).not.toHaveBeenCalled();
    expect(insertedMessages).toHaveLength(0);
  });

  it('still backfills a genuinely different URL prompt', async () => {
    existingRows.push({ content: '检查 https://example.com/' });
    telemetryRows.push({
      id: 'turn-url-different',
      user_prompt: '检查 https://example.org/',
      start_time: 1_785_600_000_200,
    });

    await expect(backfill()).resolves.toBe(1);

    expect(insertedMessages).toEqual([{
      sessionId: 'session-url-normalization',
      message: expect.objectContaining({
        id: 'telemetry-user-turn-url-different',
        role: 'user',
        content: '检查 https://example.org/',
      }),
    }]);
  });

  it('does not backfill an auxiliary meta prompt whose home path was expanded during persistence', async () => {
    existingRows.push({
      content: `调研 React 19.2 并写入 ${homedir()}/react-19.2-summary.md`,
    });
    telemetryRows.push({
      id: 'auxiliary-home-path',
      user_prompt: '调研 React 19.2 并写入 ~/react-19.2-summary.md',
      start_time: 1_785_600_000_300,
    });

    await expect(backfill()).resolves.toBe(0);

    expect(dbMock.addMessage).not.toHaveBeenCalled();
    expect(insertedMessages).toHaveLength(0);
  });
});
