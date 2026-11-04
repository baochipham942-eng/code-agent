import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelRouter } from '../../../src/host/model/modelRouter';
import { ProgressiveResearchLoop, type ProgressiveLoopConfig } from '../../../src/host/research/progressiveLoop';
import type { ProgressiveResearchState, SourceResult } from '../../../src/host/research/types';
import type { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../../../src/shared/constants';

const h = vi.hoisted(() => ({
  settings: {
    models: {
      default: '' as string,
      providers: {} as Record<string, { model?: string }>,
    },
  },
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getSettings: () => h.settings,
    getApiKey: () => '',
  }),
}));

type LoopCalls = {
  generateInitialPlan(state: ProgressiveResearchState): Promise<unknown>;
  analyzeResults(state: ProgressiveResearchState, sources: SourceResult[]): Promise<unknown>;
};

function state(): ProgressiveResearchState {
  return {
    topic: 'background model',
    iteration: 1,
    sources: [],
    facts: [],
    gaps: [],
    objectivesCovered: new Map([['coverage', 0]]),
    overallCoverage: 0,
    lastIterationNovelty: 1,
    totalUniqueInfo: 0,
    searchCallsUsed: 0,
    pageFetchesUsed: 0,
    timeElapsedMs: 0,
    startTime: Date.now(),
  };
}

function config(): ProgressiveLoopConfig {
  return {
    triggeredBy: 'manual',
    researchConfig: {
      parallelSearches: 1,
      resultsPerSearch: 1,
      maxFetchesPerSearch: 1,
      maxIterations: 1,
      coverageThreshold: 0.8,
      noveltyThreshold: 0.1,
      maxDurationMs: 1000,
      maxSearchCalls: 1,
      maxPageFetches: 1,
      enabledSources: ['web_search'],
      reportStyle: 'default',
    },
  };
}

const source: SourceResult = {
  url: 'https://example.test/note',
  title: 'note',
  sourceType: 'web_search',
  content: 'a sourced fact',
  fetchedAt: 1,
};

describe('progressiveLoop default model', () => {
  const chat = vi.fn(async (_request: unknown) => ({ content: '[]' }));

  beforeEach(() => {
    chat.mockClear();
    chat.mockResolvedValue({ content: '[]' });
    h.settings.models.default = '';
    h.settings.models.providers = {};
  });

  async function bothCalls(): Promise<Array<{ provider: string; model: string; maxTokens: number }>> {
    const router = { chat } as unknown as ModelRouter;
    const loop = new ProgressiveResearchLoop({} as ToolExecutor, router, config()) as unknown as LoopCalls;
    await loop.generateInitialPlan(state());
    chat.mockResolvedValueOnce({
      content: JSON.stringify({ facts: [], gaps: [], objectiveCoverage: { coverage: 0.2 } }),
    });
    await loop.analyzeResults(state(), [source]);
    return chat.mock.calls.map((call) => {
      const request = call[0];
      if (!request || typeof request !== 'object') throw new Error('missing chat request');
      return request as { provider: string; model: string; maxTokens: number };
    });
  }

  it('uses the configured user provider and model for both chat calls', async () => {
    h.settings.models.default = 'deepseek';
    h.settings.models.providers = { deepseek: { model: 'deepseek-chat' } };

    const requests = await bothCalls();

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat', maxTokens: 300 });
    expect(requests[1]).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat', maxTokens: 1000 });
  });

  it('falls back to the factory default when nothing is configured', async () => {
    const requests = await bothCalls();

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL, maxTokens: 300 });
    expect(requests[1]).toMatchObject({ provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL, maxTokens: 1000 });
  });
});
