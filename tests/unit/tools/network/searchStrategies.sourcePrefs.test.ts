import { describe, expect, it } from 'vitest';
import { getAvailableSources } from '../../../../src/main/tools/web/search';

// 所有 premium 源都给 key（tavily 经 getTavilyKeys(cs) 也读 getServiceApiKey('tavily')），
// 使其全部 available；firecrawl/cloud 受外部状态影响，断言时只看 premium 子集，确定性。
const allKeys = { getServiceApiKey: () => 'k' } as never;
const PREMIUM = ['perplexity', 'openai', 'exa', 'tavily', 'brave'];
const premiumOf = (names: string[]) => names.filter((n) => PREMIUM.includes(n));

describe('getAvailableSources — 用户搜索源偏好（ADR-026）', () => {
  it('无偏好时按内置 priority 排序（perplexity<openai<exa<tavily<brave）', () => {
    const names = getAvailableSources(allKeys).map((s) => s.name);
    expect(premiumOf(names)).toEqual(['perplexity', 'openai', 'exa', 'tavily', 'brave']);
  });

  it('disabledSources 中的源被剔除', () => {
    const names = getAvailableSources(allKeys, undefined, { disabledSources: ['perplexity', 'exa'] }).map((s) => s.name);
    expect(names).not.toContain('perplexity');
    expect(names).not.toContain('exa');
    expect(premiumOf(names)).toEqual(['openai', 'tavily', 'brave']);
  });

  it('sourceOrder 把列出的源按其顺序提前，未列出的随后按内置 priority', () => {
    const names = getAvailableSources(allKeys, undefined, { sourceOrder: ['brave', 'exa'] }).map((s) => s.name);
    const premium = premiumOf(names);
    // brave、exa 提前且保持给定顺序
    expect(premium.indexOf('brave')).toBeLessThan(premium.indexOf('exa'));
    expect(premium.indexOf('exa')).toBeLessThan(premium.indexOf('perplexity'));
    // 未列出的仍按内置 priority：perplexity < openai < tavily
    expect(premium.indexOf('perplexity')).toBeLessThan(premium.indexOf('openai'));
    expect(premium.indexOf('openai')).toBeLessThan(premium.indexOf('tavily'));
  });

  it('disabled 与 order 同时生效', () => {
    const names = getAvailableSources(allKeys, undefined, {
      disabledSources: ['perplexity'],
      sourceOrder: ['tavily', 'perplexity', 'exa'],
    }).map((s) => s.name);
    expect(names).not.toContain('perplexity');
    const premium = premiumOf(names);
    // tavily 最前，exa 次之（perplexity 虽在 order 中但已禁用，跳过）
    expect(premium[0]).toBe('tavily');
    expect(premium.indexOf('tavily')).toBeLessThan(premium.indexOf('exa'));
  });
});
