// ============================================================================
// jira (native ToolModule) Tests — P0-6.3 Batch 9
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

const getIntegrationMock = vi.fn();

vi.mock('../../../../../src/main/services', () => ({
  getConfigService: () => ({
    getIntegration: getIntegrationMock,
  }),
}));

import { jiraModule } from '../../../../../src/main/tools/modules/network/jira';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: process.cwd(),
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

async function run(
  args: Record<string, unknown>,
  ctx: ToolContext = makeCtx(),
  canUseTool: CanUseToolFn = allowAll,
  onProgress?: (p: { stage: string }) => void,
) {
  const handler = await jiraModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

const fetchMock = vi.fn();

beforeEach(() => {
  getIntegrationMock.mockReset();
  fetchMock.mockReset();
  // Provide a default valid jira config
  getIntegrationMock.mockReturnValue({
    baseUrl: 'https://example.atlassian.net',
    email: 'tester@example.com',
    apiToken: 'tok-123',
  });
  vi.stubGlobal('fetch', fetchMock);
  // Ensure env doesn't override config
  delete process.env.JIRA_BASE_URL;
  delete process.env.JIRA_EMAIL;
  delete process.env.JIRA_API_TOKEN;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

describe('jiraModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(jiraModule.schema.name).toBe('jira');
      expect(jiraModule.schema.category).toBe('network');
      expect(jiraModule.schema.permissionLevel).toBe('network');
      expect(jiraModule.schema.readOnly).toBe(false);
      expect(jiraModule.schema.allowInPlanMode).toBe(false);
      expect(jiraModule.schema.inputSchema.required).toEqual(['action']);
    });
  });

  describe('validation & errors', () => {
    it('rejects missing action', async () => {
      const result = await run({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects unknown action', async () => {
      const result = await run({ action: 'destroy' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run({ action: 'query' }, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const result = await run({ action: 'query' }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });

    it('returns AUTH_REQUIRED when no jira config', async () => {
      getIntegrationMock.mockReturnValue(null);
      const result = await run({ action: 'query' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('AUTH_REQUIRED');
    });
  });

  describe('query action', () => {
    it('queries issues and formats output', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          total: 2,
          issues: [
            {
              key: 'PROJ-1',
              fields: {
                summary: 'First issue',
                status: { name: 'In Progress' },
                issuetype: { name: 'Bug' },
                priority: { name: 'High' },
                assignee: { displayName: 'Alice' },
                created: '2025-01-01T00:00:00.000Z',
              },
            },
            {
              key: 'PROJ-2',
              fields: {
                summary: 'Second issue',
                status: { name: 'Done' },
                issuetype: { name: 'Task' },
                priority: { name: 'Medium' },
                assignee: { displayName: 'Bob' },
                created: '2025-01-02T00:00:00.000Z',
              },
            },
          ],
        }),
      );

      const result = await run({ action: 'query', project: 'PROJ' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('PROJ-1');
        expect(result.output).toContain('PROJ-2');
        expect(result.output).toContain('First issue');
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('/rest/api/3/search');
      expect(url).toContain('project');
    });

    it('returns 401 as AUTH_REQUIRED', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse('unauthorized', 401));
      const result = await run({ action: 'query' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('AUTH_REQUIRED');
    });

    it('returns 403 as AUTH_REQUIRED', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse('forbidden', 403));
      const result = await run({ action: 'query' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('AUTH_REQUIRED');
    });

    it('returns 500 as NETWORK_ERROR', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse('boom', 500));
      const result = await run({ action: 'query' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('NETWORK_ERROR');
    });

    it('handles empty issues result', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ total: 0, issues: [] }));
      const result = await run({ action: 'query' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('未找到');
    });
  });

  describe('get action', () => {
    it('rejects missing issue_key', async () => {
      const result = await run({ action: 'get' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('formats single issue', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          key: 'PROJ-42',
          fields: {
            summary: 'Login bug',
            status: { name: 'Open' },
            issuetype: { name: 'Bug' },
            priority: { name: 'High' },
            assignee: { displayName: 'Alice' },
            reporter: { displayName: 'Bob' },
            created: '2025-01-01',
            updated: '2025-01-02',
            description: 'Detailed description here',
            labels: ['urgent', 'login'],
          },
        }),
      );

      const result = await run({ action: 'get', issue_key: 'PROJ-42' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('PROJ-42');
        expect(result.output).toContain('Login bug');
        expect(result.output).toContain('Detailed description');
        expect(result.output).toContain('urgent, login');
      }
    });
  });

  describe('create action', () => {
    it('rejects missing project/summary', async () => {
      const result = await run({ action: 'create' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('creates issue and returns key/url', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ key: 'PROJ-99', id: '10001', self: 'https://example.atlassian.net/rest/api/3/issue/10001' }),
      );

      const result = await run({
        action: 'create',
        project: 'PROJ',
        summary: 'New ticket',
        description: 'desc',
        priority: 'High',
        labels: ['x'],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('PROJ-99');
        expect(result.output).toContain('https://example.atlassian.net/browse/PROJ-99');
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const opts = fetchMock.mock.calls[0][1] as RequestInit;
      expect(opts.method).toBe('POST');
    });
  });

  describe('onProgress', () => {
    it('emits starting progress', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ total: 0, issues: [] }));
      const onProgress = vi.fn();
      await run({ action: 'query' }, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
    });
  });
});
