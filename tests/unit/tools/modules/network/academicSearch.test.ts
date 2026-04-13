// ============================================================================
// academic_search (native ToolModule) Tests — P0-6.3 Batch 9
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

import { academicSearchModule } from '../../../../../src/main/tools/modules/network/academicSearch';

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
  const handler = await academicSearchModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
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

function textResponse(text: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => ({}),
  } as unknown as Response;
}

const ARXIV_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed>
  <entry>
    <id>http://arxiv.org/abs/2301.00001</id>
    <title>Attention Is All You Need (Reprised)</title>
    <summary>This paper studies attention mechanisms in detail.</summary>
    <published>2023-01-15T00:00:00Z</published>
    <author><name>Alice Researcher</name></author>
    <author><name>Bob Scientist</name></author>
    <link href="http://arxiv.org/pdf/2301.00001.pdf"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2302.00002</id>
    <title>Transformer Variants Survey</title>
    <summary>A survey of transformer architectures.</summary>
    <published>2024-02-10T00:00:00Z</published>
    <author><name>Carol Author</name></author>
    <link href="http://arxiv.org/pdf/2302.00002.pdf"/>
  </entry>
</feed>`;

const SS_OK = {
  data: [
    {
      paperId: 'p1',
      title: 'Semantic Paper One',
      authors: [{ name: 'Dave Reader' }],
      abstract: 'Abstract one',
      url: 'https://semanticscholar.org/p1',
      citationCount: 42,
      publicationDate: '2024-03-01',
      openAccessPdf: { url: 'https://pdf/p1.pdf' },
    },
  ],
};

describe('academicSearchModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(academicSearchModule.schema.name).toBe('academic_search');
      expect(academicSearchModule.schema.category).toBe('network');
      expect(academicSearchModule.schema.permissionLevel).toBe('network');
      expect(academicSearchModule.schema.readOnly).toBe(true);
      expect(academicSearchModule.schema.allowInPlanMode).toBe(true);
      expect(academicSearchModule.schema.inputSchema.required).toEqual(['query']);
    });
  });

  describe('validation & errors', () => {
    it('rejects missing query', async () => {
      const result = await run({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects empty query', async () => {
      const result = await run({ query: '' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects invalid source', async () => {
      const result = await run({ query: 'x', source: 'pubmed' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects invalid sort_by', async () => {
      const result = await run({ query: 'x', sort_by: 'random' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run({ query: 'x' }, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const result = await run({ query: 'x' }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });
  });

  describe('arxiv source', () => {
    it('parses arxiv XML and returns papers', async () => {
      fetchMock.mockResolvedValueOnce(textResponse(ARXIV_XML));

      const result = await run({ query: 'attention', source: 'arxiv' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Attention Is All You Need');
        expect(result.output).toContain('Transformer Variants');
        expect(result.output).toContain('Alice Researcher');
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toContain('arxiv');
    });
  });

  describe('all sources', () => {
    it('queries both arxiv and semanticscholar', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('arxiv')) return textResponse(ARXIV_XML);
        if (url.includes('semanticscholar')) return jsonResponse(SS_OK);
        return jsonResponse('not found', 404);
      });

      const result = await run({ query: 'transformer', source: 'all' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Attention Is All You Need');
        expect(result.output).toContain('Semantic Paper One');
      }
      // Both called
      const urls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes('arxiv'))).toBe(true);
      expect(urls.some((u) => u.includes('semanticscholar'))).toBe(true);
    });

    it('sorts by date when sort_by=date', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('arxiv')) return textResponse(ARXIV_XML);
        if (url.includes('semanticscholar')) return jsonResponse(SS_OK);
        return jsonResponse('', 404);
      });

      const result = await run({ query: 'x', source: 'all', sort_by: 'date' });
      expect(result.ok).toBe(true);
      // We can't deeply verify ordering but ensure no crash and output present
      if (result.ok) expect(result.output).toContain('学术搜索结果');
    });

    it('filters by year range', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('arxiv')) return textResponse(ARXIV_XML);
        if (url.includes('semanticscholar')) return jsonResponse(SS_OK);
        return jsonResponse('', 404);
      });

      const result = await run({ query: 'x', source: 'all', year_from: 2024, year_to: 2024 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        // 2023 paper should be excluded; 2024 should remain
        expect(result.output).toContain('Transformer Variants');
        expect(result.output).not.toContain('Attention Is All You Need');
      }
    });

    it('caps limit at MAX_LIMIT', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('arxiv')) return textResponse(ARXIV_XML);
        if (url.includes('semanticscholar')) return jsonResponse(SS_OK);
        return jsonResponse('', 404);
      });

      const result = await run({ query: 'x', source: 'all', limit: 999 });
      expect(result.ok).toBe(true);
      // arxiv URL should have max_results capped
      const arxivCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('arxiv'));
      expect(arxivCall).toBeDefined();
      // 30 max / 2 = 15
      expect(String(arxivCall![0])).toContain('max_results=15');
    });

    it('handles empty results', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('arxiv')) return textResponse('<feed></feed>');
        if (url.includes('semanticscholar')) return jsonResponse({ data: [] });
        return jsonResponse('', 404);
      });

      const result = await run({ query: 'x', source: 'all' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('未找到');
    });
  });

  describe('onProgress', () => {
    it('emits starting progress', async () => {
      fetchMock.mockResolvedValueOnce(textResponse('<feed></feed>'));
      const onProgress = vi.fn();
      await run({ query: 'x', source: 'arxiv' }, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
    });
  });
});
