import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type {
  CanUseToolFn,
  Logger,
  ToolContext,
} from '../../../../../src/host/protocol/tools';

const { getConfigServiceMock } = vi.hoisted(() => ({
  getConfigServiceMock: vi.fn(),
}));

vi.mock('../../../../../src/host/services/core/configService', () => ({
  getConfigService: () => getConfigServiceMock(),
}));

const {
  routeSourcesMock,
  getAvailableSourcesMock,
  parallelSearchMock,
  serialSearchMock,
  deduplicateResultsMock,
  formatAsTableMock,
  buildSearchPlanMock,
  rankSearchResultDataMock,
} = vi.hoisted(() => ({
  routeSourcesMock: vi.fn(),
  getAvailableSourcesMock: vi.fn(),
  parallelSearchMock: vi.fn(),
  serialSearchMock: vi.fn(),
  deduplicateResultsMock: vi.fn(),
  formatAsTableMock: vi.fn(),
  buildSearchPlanMock: vi.fn(),
  rankSearchResultDataMock: vi.fn(),
}));

vi.mock('../../../../../src/host/tools/web/search', () => ({
  routeSources: (...args: unknown[]) => routeSourcesMock(...args),
  getAvailableSources: (...args: unknown[]) => getAvailableSourcesMock(...args),
  parallelSearch: (...args: unknown[]) => parallelSearchMock(...args),
  serialSearch: (...args: unknown[]) => serialSearchMock(...args),
  deduplicateResults: (...args: unknown[]) => deduplicateResultsMock(...args),
  formatAsTable: (...args: unknown[]) => formatAsTableMock(...args),
  buildSearchPlan: (...args: unknown[]) => buildSearchPlanMock(...args),
  rankSearchResultData: (...args: unknown[]) => rankSearchResultDataMock(...args),
  getCircuitBreakerRemaining: () => 0,
  SEARCH_PROVIDER_SETUP_MESSAGE: [
    '当前没有可用的联网搜索源。',
    '默认 Firecrawl keyless 搜索可能已被环境变量禁用。',
    'Firecrawl Brave Search OpenAI EXA Tavily Perplexity',
  ].join('\n'),
  SEARCH_FAILURE_GUIDANCE: '联网搜索没有拿到可用结果。',
}));

const {
  autoExtractFromResultsMock,
  autoExtractFallbackMock,
} = vi.hoisted(() => ({
  autoExtractFromResultsMock: vi.fn(),
  autoExtractFallbackMock: vi.fn(),
}));

vi.mock('../../../../../src/host/tools/web/search/contentExtractor', () => ({
  autoExtractFromResults: (...args: unknown[]) => autoExtractFromResultsMock(...args),
  autoExtractFallback: (...args: unknown[]) => autoExtractFallbackMock(...args),
}));

import { webSearchModule } from '../../../../../src/host/tools/modules/network/webSearch';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'test-session',
    workingDir: '/tmp/work',
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

function fakeSource(name: string, priority = 3) {
  return { name, priority, isAvailable: vi.fn(), search: vi.fn() };
}

const fakeSources = [
  fakeSource('exa', 3),
  fakeSource('tavily', 4),
];

function makeSearchResult(sources: string[] = ['exa']) {
  const firstSource = sources[0] ?? 'exa';
  return {
    success: true,
    output: '# Search results\n\n- Result One\n  https://example.com/a\n  first snippet',
    result: {
      results: [
        {
          title: 'Result One',
          url: 'https://example.com/a',
          snippet: 'first snippet',
          source: firstSource,
        },
      ],
      sources,
      duration: 42,
    },
  };
}

async function run(args: Record<string, unknown>, ctx = makeCtx(), canUseTool = allowAll) {
  const handler = await webSearchModule.createHandler();
  return handler.execute(args, ctx, canUseTool);
}

beforeEach(() => {
  vi.clearAllMocks();
  getConfigServiceMock.mockReturnValue({ getServiceApiKey: vi.fn(), getSettings: vi.fn(() => ({})) });
  routeSourcesMock.mockReturnValue({ sources: ['exa', 'tavily'], reason: 'technical' });
  getAvailableSourcesMock.mockReturnValue(fakeSources);
  parallelSearchMock.mockResolvedValue(makeSearchResult());
  serialSearchMock.mockResolvedValue(makeSearchResult());
  deduplicateResultsMock.mockImplementation(() => undefined);
  formatAsTableMock.mockReturnValue('### 1. Result One\nfirst snippet\nhttps://example.com/a\n');
  buildSearchPlanMock.mockImplementation((query: string, options: { mode?: 'quick' | 'research' } = {}) => ({
    intent: query.includes('OpenAI Responses API') ? 'official_docs' : 'general',
    maxQueryRewrites: options.mode === 'research' ? 1 : 0,
    expectedSourceTypes: query.includes('OpenAI Responses API') ? ['official', 'documentation'] : ['general'],
    queries: options.mode === 'research' && query.includes('OpenAI Responses API')
      ? [
          { query, purpose: 'primary' },
          { query: `${query} official documentation`, purpose: 'official' },
        ]
      : [{ query, purpose: 'primary' }],
  }));
  rankSearchResultDataMock.mockImplementation((result) => result);
  autoExtractFromResultsMock.mockResolvedValue('---\n# Auto-Extracted Content\n\nextracted');
  autoExtractFallbackMock.mockResolvedValue('---\n# Fetched Page Content\n\nfallback');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('webSearchModule (native)', () => {
  it('rejects missing query before asking permission', async () => {
    const canUseTool = vi.fn(async () => ({ allow: true })) as CanUseToolFn;

    const result = await run({}, makeCtx(), canUseTool);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
    }
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('runs native routing and returns structured result metadata', async () => {
    const result = await run({ query: 'typescript api docs', count: 3 });

    expect(result.ok).toBe(true);
    expect(routeSourcesMock).toHaveBeenCalledWith('typescript api docs', {
      mode: 'quick',
      requestedSources: undefined,
    });
    expect(parallelSearchMock).toHaveBeenCalledTimes(1);
    expect(deduplicateResultsMock).toHaveBeenCalledTimes(1);
    if (result.ok) {
      expect(result.meta?.artifact).toMatchObject({
        kind: 'search',
        sourceTool: 'WebSearch',
        mimeType: 'text/markdown',
        metadata: {
          query: 'typescript api docs',
          mode: 'quick',
          autoExtract: false,
          resultCount: 1,
          sources: ['exa'],
          routingReason: 'technical',
        },
      });
      expect(result.meta?.results).toEqual([
        expect.objectContaining({
          title: 'Result One',
          url: 'https://example.com/a',
        }),
      ]);
      expect(result.meta?.routing).toMatchObject({
        routed: ['exa', 'tavily'],
        reason: 'technical',
        available: ['exa', 'tavily'],
        final: ['exa', 'tavily'],
      });
    }
  });

  it('uses serial search when parallel=false', async () => {
    const result = await run({ query: 'one source', parallel: false });

    expect(result.ok).toBe(true);
    expect(serialSearchMock).toHaveBeenCalledTimes(1);
    expect(parallelSearchMock).not.toHaveBeenCalled();
  });

  it('marks recency as hard-enforced only for providers with request parameters', async () => {
    const recencySources = [
      fakeSource('firecrawl', 1),
      fakeSource('exa', 3),
      fakeSource('brave', 4),
      fakeSource('tavily', 5),
    ];
    getAvailableSourcesMock.mockReturnValue(recencySources);
    routeSourcesMock.mockReturnValue({ sources: ['firecrawl', 'exa', 'brave', 'tavily'], reason: 'recent' });
    parallelSearchMock.mockResolvedValue(makeSearchResult(['firecrawl-keyless', 'exa', 'brave', 'tavily']));

    const result = await run({ query: 'latest releases', recency: 'week' });

    expect(result.ok).toBe(true);
    expect(parallelSearchMock).toHaveBeenCalledWith(
      'latest releases',
      5,
      recencySources,
      expect.anything(),
      undefined,
      'week'
    );
    if (result.ok) {
      expect(result.meta).toMatchObject({
        recencyRequested: true,
        recencyEnforcedBy: ['firecrawl-keyless', 'exa', 'brave', 'tavily'],
        recencyBestEffortBy: [],
      });
      expect((result.meta?.artifact as { metadata?: Record<string, unknown> }).metadata).toMatchObject({
        recencyRequested: true,
        recencyEnforcedBy: ['firecrawl-keyless', 'exa', 'brave', 'tavily'],
        recencyBestEffortBy: [],
      });
    }
  });

  it('marks OpenAI recency as best-effort because it is prompt text only', async () => {
    getAvailableSourcesMock.mockReturnValue([fakeSource('openai', 4)]);
    routeSourcesMock.mockReturnValue({ sources: ['openai'], reason: 'user-specified' });
    serialSearchMock.mockResolvedValue(makeSearchResult(['openai']));

    const result = await run({ query: 'latest docs', sources: ['openai'], recency: 'day' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta).toMatchObject({
        recencyRequested: true,
        recencyEnforcedBy: [],
        recencyBestEffortBy: ['openai'],
      });
    }
  });

  it('does not claim recency enforcement for providers that ignore recency', async () => {
    getAvailableSourcesMock.mockReturnValue([fakeSource('perplexity', 3)]);
    routeSourcesMock.mockReturnValue({ sources: ['perplexity'], reason: 'user-specified' });
    serialSearchMock.mockResolvedValue(makeSearchResult(['perplexity']));

    const result = await run({ query: 'latest summary', sources: ['perplexity'], recency: 'month' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta).toMatchObject({
        recencyRequested: true,
        recencyEnforcedBy: [],
        recencyBestEffortBy: [],
      });
    }
  });

  it('applies table formatting when requested', async () => {
    const result = await run({ query: 'format me', output_format: 'table' });

    expect(result.ok).toBe(true);
    expect(formatAsTableMock).toHaveBeenCalledTimes(1);
    if (result.ok) {
      expect(result.output).toContain('### 1. Result One');
    }
  });

  it('research mode defaults to auto_extract and appends extracted content', async () => {
    const result = await run({ query: 'deep research', mode: 'research' });

    expect(result.ok).toBe(true);
    expect(autoExtractFallbackMock).toHaveBeenCalledTimes(1);
    if (result.ok) {
      expect(result.output).toContain('# Fetched Page Content');
      expect(result.meta?.autoExtract).toBe(true);
    }
  });

  it('runs at most one complementary planned query in research mode', async () => {
    const result = await run({ query: 'OpenAI Responses API web_search parameters', mode: 'research' });

    expect(result.ok).toBe(true);
    expect(parallelSearchMock).toHaveBeenCalledTimes(2);
    expect(parallelSearchMock.mock.calls[0][0]).toBe('OpenAI Responses API web_search parameters');
    expect(parallelSearchMock.mock.calls[1][0]).toBe('OpenAI Responses API web_search parameters official documentation');
    if (result.ok) {
      expect(result.meta?.queryPlan).toMatchObject({
        intent: 'official_docs',
        maxQueryRewrites: 1,
        queries: [
          { query: 'OpenAI Responses API web_search parameters', purpose: 'primary' },
          { query: 'OpenAI Responses API web_search parameters official documentation', purpose: 'official' },
        ],
      });
    }
  });

  it('uses model-backed auto_extract when modelCallback exists', async () => {
    const modelCallback = vi.fn(async () => 'model result');
    const result = await run(
      { query: 'deep research', auto_extract: true },
      makeCtx({ modelCallback }),
    );

    expect(result.ok).toBe(true);
    expect(autoExtractFromResultsMock).toHaveBeenCalledTimes(1);
    expect(autoExtractFallbackMock).not.toHaveBeenCalled();
  });

  it('saves markdown output and returns savedArtifact when save_to is set', async () => {
    const savePath = path.join('/private/tmp', `websearch-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
    try {
      const result = await run({ query: 'save this', save_to: savePath });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain(`Results saved to: ${savePath}`);
        expect(result.meta?.savedArtifact).toMatchObject({
          kind: 'text',
          sourceTool: 'WebSearch',
          path: savePath,
          mimeType: 'text/markdown',
        });
      }
      expect(fs.readFileSync(savePath, 'utf8')).toContain('查询: save this');
    } finally {
      if (fs.existsSync(savePath)) fs.unlinkSync(savePath);
    }
  });

  it('returns NO_SEARCH_SOURCE when no providers are configured', async () => {
    getAvailableSourcesMock.mockReturnValue([]);

    const result = await run({ query: 'anything' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NO_SEARCH_SOURCE');
      expect(result.error).toContain('当前没有可用的联网搜索源');
      expect(result.error).toContain('Firecrawl');
      expect(result.error).toContain('Brave Search');
      expect(result.error).toContain('OpenAI');
      expect(result.error).toContain('EXA');
      expect(result.error).toContain('Tavily');
      expect(result.error).toContain('Perplexity');
    }
  });
});
