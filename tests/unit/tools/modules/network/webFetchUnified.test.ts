import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CanUseToolFn,
  Logger,
  ToolContext,
} from '../../../../../src/main/protocol/tools';

const { fetchDocumentMock } = vi.hoisted(() => ({
  fetchDocumentMock: vi.fn(),
}));

vi.mock('../../../../../src/main/tools/web/fetchDocument', () => ({
  fetchDocument: (...args: unknown[]) => fetchDocumentMock(...args),
}));

const { smartHtmlToTextMock, smartTruncateMock, buildExtractionPromptMock } = vi.hoisted(() => ({
  smartHtmlToTextMock: vi.fn(),
  smartTruncateMock: vi.fn(),
  buildExtractionPromptMock: vi.fn(),
}));

vi.mock('../../../../../src/main/tools/web/htmlUtils', () => ({
  smartHtmlToText: (...args: unknown[]) => smartHtmlToTextMock(...args),
  smartTruncate: (...args: unknown[]) => smartTruncateMock(...args),
  buildExtractionPrompt: (...args: unknown[]) => buildExtractionPromptMock(...args),
}));

const { executeHttpRequestMock } = vi.hoisted(() => ({
  executeHttpRequestMock: vi.fn(),
}));

vi.mock('../../../../../src/main/tools/modules/network/httpRequest', () => ({
  executeHttpRequest: (...args: unknown[]) => executeHttpRequestMock(...args),
}));

import { webFetchUnifiedSchema } from '../../../../../src/main/tools/modules/network/webFetchUnified.schema';
import { webFetchUnifiedModule } from '../../../../../src/main/tools/modules/network/webFetchUnified';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(): ToolContext {
  return {
    sessionId: 'test-session',
    workingDir: process.cwd(),
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    emit: () => void 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchDocumentMock.mockResolvedValue({
    content: '# hello web',
    contentType: 'text/markdown',
    finalUrl: 'https://example.com/docs',
    crossDomainRedirect: false,
    statusCode: 200,
    fromCache: false,
  });
  smartHtmlToTextMock.mockReturnValue('hello html');
  smartTruncateMock.mockImplementation((content: string) => content);
  buildExtractionPromptMock.mockReturnValue('extract prompt');
  executeHttpRequestMock.mockResolvedValue({
    ok: true,
    output: 'HTTP 200 OK\n\n--- Response Body ---\n{"ok":true}',
    meta: {
      status: 200,
      statusText: 'OK',
      duration: 12,
      url: 'https://api.example.com/data',
      method: 'GET',
      contentType: 'application/json',
    },
  });
});

describe('webFetchUnifiedModule', () => {
  it('requires only url in the model-visible schema and defaults action to fetch', () => {
    expect(webFetchUnifiedSchema.inputSchema.required).toEqual(['url']);
    expect(webFetchUnifiedSchema.description).toContain('"action": "fetch"');
    expect(webFetchUnifiedSchema.description).toContain('default action');
  });

  it('rejects missing url before asking for network permission', async () => {
    const canUseTool = vi.fn(async () => ({ allow: true })) as CanUseToolFn;
    const handler = await webFetchUnifiedModule.createHandler();

    const result = await handler.execute({ action: 'request' }, makeCtx(), canUseTool);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('url');
    }
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('rejects fetch without a prompt before asking for network permission', async () => {
    const canUseTool = vi.fn(async () => ({ allow: true })) as CanUseToolFn;
    const handler = await webFetchUnifiedModule.createHandler();

    const result = await handler.execute(
      { action: 'fetch', url: 'https://example.com' },
      makeCtx(),
      canUseTool,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('prompt');
    }
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('adds unified artifact metadata for successful fetches', async () => {
    const canUseTool = vi.fn(async () => ({ allow: true })) as CanUseToolFn;
    const handler = await webFetchUnifiedModule.createHandler();

    const result = await handler.execute(
      { action: 'fetch', url: 'https://example.com/docs', prompt: 'extract' },
      makeCtx(),
      canUseTool,
    );

    expect(result.ok).toBe(true);
    expect(fetchDocumentMock).toHaveBeenCalledWith('https://example.com/docs');
    if (result.ok) {
      expect(result.output).toContain('Fetched content from: https://example.com/docs');
      expect(result.meta).toMatchObject({
        finalUrl: 'https://example.com/docs',
        requestedUrl: 'https://example.com/docs',
        statusCode: 200,
        contentType: 'text/markdown',
        extractionMode: 'markdown',
      });
      expect(result.meta?.artifact).toMatchObject({
        kind: 'web',
        sourceTool: 'WebFetch',
        url: 'https://example.com/docs',
        mimeType: 'text/markdown',
        metadata: expect.objectContaining({
          action: 'fetch',
          finalUrl: 'https://example.com/docs',
          statusCode: 200,
        }),
      });
      expect(result.meta?.artifact).toHaveProperty('artifactId');
    }
  });

  it('defaults missing action to fetch for url+prompt calls', async () => {
    const canUseTool = vi.fn(async () => ({ allow: true })) as CanUseToolFn;
    const handler = await webFetchUnifiedModule.createHandler();

    const result = await handler.execute(
      { url: 'https://example.com/docs', prompt: 'extract' },
      makeCtx(),
      canUseTool,
    );

    expect(result.ok).toBe(true);
    expect(fetchDocumentMock).toHaveBeenCalledWith('https://example.com/docs');
    if (result.ok) {
      expect(result.meta?.artifact).toMatchObject({
        kind: 'web',
        sourceTool: 'WebFetch',
        metadata: expect.objectContaining({
          action: 'fetch',
        }),
      });
    }
  });

  it('uses model extraction for HTML fetches when modelCallback is present', async () => {
    fetchDocumentMock.mockResolvedValue({
      content: '<main>Hello</main>',
      contentType: 'text/html',
      finalUrl: 'https://example.com/page',
      crossDomainRedirect: false,
      statusCode: 200,
      fromCache: false,
    });
    const ctx = {
      ...makeCtx(),
      modelCallback: vi.fn(async () => 'extracted answer with enough detail to pass the fallback guard'),
    } as ToolContext;
    const handler = await webFetchUnifiedModule.createHandler();

    const result = await handler.execute(
      { action: 'fetch', url: 'https://example.com/page', prompt: 'extract' },
      ctx,
      async () => ({ allow: true }),
    );

    expect(result.ok).toBe(true);
    expect(smartHtmlToTextMock).toHaveBeenCalledWith('<main>Hello</main>', 'https://example.com/page');
    expect(ctx.modelCallback).toHaveBeenCalledWith('extract prompt');
    if (result.ok) {
      expect(result.output).toContain('extracted answer');
      expect(result.meta?.usedModel).toBe(true);
      expect(result.meta?.extractionMode).toBe('html');
    }
  });

  it('delegates request action to native http_request and adds web artifact', async () => {
    const canUseTool = vi.fn(async () => ({ allow: true })) as CanUseToolFn;
    const handler = await webFetchUnifiedModule.createHandler();

    const result = await handler.execute(
      { action: 'request', url: 'https://api.example.com/data' },
      makeCtx(),
      canUseTool,
    );

    expect(result.ok).toBe(true);
    expect(executeHttpRequestMock).toHaveBeenCalledTimes(1);
    if (result.ok) {
      expect(result.meta?.artifact).toMatchObject({
        kind: 'web',
        sourceTool: 'WebFetch',
        url: 'https://api.example.com/data',
        mimeType: 'application/http',
        metadata: expect.objectContaining({
          action: 'request',
          status: 200,
          method: 'GET',
        }),
      });
    }
  });
});
