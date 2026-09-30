import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolSearchService } from '../../../../src/host/services/toolSearch/toolSearchService';
import type { JevSkillRerankJudge } from '../../../../src/shared/contract/toolSearch';
import { resetProtocolRegistry } from '../../../../src/host/tools/protocolRegistry';
import type { DeferredToolMeta } from '../../../../src/shared/contract/toolSearch';
type JevSkillRerankJudgeInput = Parameters<JevSkillRerankJudge>[0];

vi.mock('../../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function answer(choice: string, confidence = 0.9, needSkill = 1, needNow = 1, none = 0) {
  return {
    choice: { choice, confidence },
    nouls: {
      need_skill: { noul: needSkill },
      need_now: { noul: needNow },
      none_of_roster: { noul: none },
    },
  };
}

function registerTools(service: ToolSearchService, count = 3): string[] {
  const names = Array.from({ length: count }, (_, index) => `mcp__mock__tool-${index}`);
  const metas: DeferredToolMeta[] = names.map((name, index) => ({
    name,
    shortDescription: `Mock keyword tool ${index}`,
    tags: ['mcp'],
    aliases: ['keyword'],
    source: 'mcp',
    mcpServer: 'mock',
  }));
  service.registerMCPTools(metas);
  return names;
}

function enabled(judge: JevSkillRerankJudge) {
  return { rerank: { enabled: true, judge } };
}

const ORIGIN_MAIN_SNAPSHOTS = {
  keyword: {
    tools: [0, 1, 2].map((index) => ({
      name: `mcp__mock__tool-${index}`,
      description: `Mock keyword tool ${index}`,
      score: 1,
      source: 'mcp',
      mcpServer: 'mock',
      tags: ['mcp'],
      loadable: true,
      canonicalInvocation: `mcp__mock__tool-${index}`,
    })),
    hasMore: false,
    totalCount: 3,
    loadedTools: [],
  },
  'mock keyword': {
    tools: [0, 1, 2].map((index) => ({
      name: `mcp__mock__tool-${index}`,
      description: `Mock keyword tool ${index}`,
      score: 1,
      source: 'mcp',
      mcpServer: 'mock',
      tags: ['mcp'],
      loadable: true,
      canonicalInvocation: `mcp__mock__tool-${index}`,
    })),
    hasMore: false,
    totalCount: 3,
    loadedTools: [],
  },
  missing: { tools: [], hasMore: false, totalCount: 0, loadedTools: [] },
} as const;

describe('Jev skill/tool rerank', () => {
  beforeEach(() => resetProtocolRegistry());

  it('flag off / no judge preserves the keyword result for three queries', async () => {
    for (const query of Object.keys(ORIGIN_MAIN_SNAPSHOTS) as Array<keyof typeof ORIGIN_MAIN_SNAPSHOTS>) {
      const baselineService = new ToolSearchService();
      registerTools(baselineService);
      const baseline = await baselineService.searchTools(query, { maxResults: 3, includeMCP: true });
      expect(baseline).toEqual(ORIGIN_MAIN_SNAPSHOTS[query]);

      const service = new ToolSearchService();
      registerTools(service);
      const disabled = await service.searchTools(query, { maxResults: 3, includeMCP: true, rerank: { enabled: false, judge: vi.fn() } });
      expect(disabled).toEqual(baseline);
    }
  });

  it('puts the judged winner first and keeps keyword order for the rest', async () => {
    const service = new ToolSearchService();
    const names = registerTools(service);
    const judge = vi.fn(async ({ roster }: JevSkillRerankJudgeInput) => answer(roster[2]!.name));

    const result = await service.searchTools('keyword', { maxResults: 3, includeMCP: true, ...enabled(judge) });

    expect(judge).toHaveBeenCalledTimes(2);
    expect(result.tools.map((tool) => tool.name)).toEqual([names[2], names[0], names[1]]);
  });

  it('does not auto-load skills when need_skill is false, including negative trigger samples', async () => {
    const service = new ToolSearchService();
    service.registerSkill('contract-review', 'Review contracts for legal risks', ['润色文案']);
    service.registerSkill('meeting-summary', 'Summarize meetings and notes', ['整理日志']);
    const judge = vi.fn(async ({ roster }: JevSkillRerankJudgeInput) => answer(roster[0]!.name, 0.9, 0, 1, 0));

    for (const query of ['润色文案', '整理日志']) {
      const result = await service.searchTools(query, { maxResults: 3, includeMCP: false, ...enabled(judge) });
      expect(result.loadedTools).toEqual([]);
      expect(result.tools.every((tool) => tool.name.startsWith('skill:'))).toBe(true);
    }
  });

  it('does not force a skill when choice confidence is below the threshold', async () => {
    const service = new ToolSearchService();
    service.registerSkill('contract-review', 'Review contracts for legal risks', ['contract']);
    service.registerSkill('meeting-summary', 'Summarize meetings and notes', ['contract']);
    const judge = vi.fn(async ({ roster }: JevSkillRerankJudgeInput) => answer(roster[1]!.name, 0.4));

    const baseline = await service.searchTools('contract', { maxResults: 2, includeMCP: false });
    service.resetLoadedTools();
    const result = await service.searchTools('contract', { maxResults: 2, includeMCP: false, ...enabled(judge) });

    expect(judge).toHaveBeenCalledTimes(1);
    expect(result).toEqual(baseline);
    expect(result.loadedTools).toEqual([]);
  });

  it('sends at most 255 non-empty-description entries to the judge', async () => {
    const service = new ToolSearchService();
    const names = registerTools(service, 260);
    service.registerSkill('empty-description', '', ['keyword']);
    const judge = vi.fn(async ({ roster }: JevSkillRerankJudgeInput) => answer(roster[0]!.name));

    await service.searchTools('keyword', { maxResults: 3, includeMCP: true, ...enabled(judge) });

    expect(judge).toHaveBeenCalled();
    expect(judge.mock.calls[0]![0].roster).toHaveLength(255);
    expect(judge.mock.calls[0]![0].roster.some((entry) => entry.name === 'skill:empty-description')).toBe(false);
    expect(names.slice(0, 255).every((name) => judge.mock.calls[0]![0].roster.some((entry) => entry.name === name))).toBe(true);
  });

  it('falls back byte-identically when the judge rejects', async () => {
    const baselineService = new ToolSearchService();
    registerTools(baselineService);
    const baseline = await baselineService.searchTools('keyword', { maxResults: 3, includeMCP: true });

    const service = new ToolSearchService();
    registerTools(service);
    const judge = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error('judge unavailable');
    });
    const result = await service.searchTools('keyword', { maxResults: 3, includeMCP: true, ...enabled(judge) });

    expect(result).toEqual(baseline);
  });

  it('reverse mutation: need_skill=false blocks a Choice that always returns roster[0]', async () => {
    const service = new ToolSearchService();
    service.registerSkill('contract-review', 'Review contracts', ['contract']);
    const judge = vi.fn(async ({ roster }: JevSkillRerankJudgeInput) => answer(roster[0]!.name, 0.9, 0, 1, 0));

    const result = await service.searchTools('contract', { maxResults: 1, includeMCP: false, ...enabled(judge) });

    expect(judge).toHaveBeenCalledTimes(1);
    expect(result.loadedTools).toEqual([]);
  });
});
