import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type {
  CanUseToolFn,
  Logger,
  ToolContext,
} from '../../../../../src/main/protocol/tools';

const { getConfigServiceMock } = vi.hoisted(() => ({
  getConfigServiceMock: vi.fn(),
}));

vi.mock('../../../../../src/main/services/core/configService', () => ({
  getConfigService: () => getConfigServiceMock(),
}));

const {
  routeSourcesMock,
  getAvailableSourcesMock,
  parallelSearchMock,
  serialSearchMock,
  deduplicateResultsMock,
  formatAsTableMock,
} = vi.hoisted(() => ({
  routeSourcesMock: vi.fn(),
  getAvailableSourcesMock: vi.fn(),
  parallelSearchMock: vi.fn(),
  serialSearchMock: vi.fn(),
  deduplicateResultsMock: vi.fn(),
  formatAsTableMock: vi.fn(),
}));

vi.mock('../../../../../src/main/tools/web/search', () => ({
  routeSources: (...args: unknown[]) => routeSourcesMock(...args),
  getAvailableSources: (...args: unknown[]) => getAvailableSourcesMock(...args),
  parallelSearch: (...args: unknown[]) => parallelSearchMock(...args),
  serialSearch: (...args: unknown[]) => serialSearchMock(...args),
  deduplicateResults: (...args: unknown[]) => deduplicateResultsMock(...args),
  formatAsTable: (...args: unknown[]) => formatAsTableMock(...args),
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

vi.mock('../../../../../src/main/tools/web/search/contentExtractor', () => ({
  autoExtractFromResults: (...args: unknown[]) => autoExtractFromResultsMock(...args),
  autoExtractFallback: (...args: unknown[]) => autoExtractFallbackMock(...args),
}));

import { webSearchModule } from '../../../../../src/main/tools/modules/network/webSearch';

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

const fakeSources = [
  { name: 'exa', priority: 3, isAvailable: vi.fn(), search: vi.fn() },
  { name: 'tavily', priority: 4, isAvailable: vi.fn(), search: vi.fn() },
];

function makeSearchResult() {
  return {
    success: true,
    output: '# Search results\n\n- Result One\n  https://example.com/a\n  first snippet',
    result: {
      results: [
        {
          title: 'Result One',
          url: 'https://example.com/a',
          snippet: 'first snippet',
          source: 'exa',
        },
      ],
      sources: ['exa'],
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
  getConfigServiceMock.mockReturnValue({ getServiceApiKey: vi.fn() });
  routeSourcesMock.mockReturnValue({ sources: ['exa', 'tavily'], reason: 'technical' });
  getAvailableSourcesMock.mockReturnValue(fakeSources);
  parallelSearchMock.mockResolvedValue(makeSearchResult());
  serialSearchMock.mockResolvedValue(makeSearchResult());
  deduplicateResultsMock.mockImplementation(() => undefined);
  formatAsTableMock.mockReturnValue('### 1. Result One\nfirst snippet\nhttps://example.com/a\n');
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
