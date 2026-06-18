import { describe, expect, it } from 'vitest';
import { buildUnusedSourcesHint } from '../../../../src/main/tools/web/search';

describe('buildUnusedSourcesHint (P2 可发现性)', () => {
  it('提示已配置但本次未命中的 premium 源', () => {
    const hint = buildUnusedSourcesHint(
      ['firecrawl', 'exa', 'perplexity'],
      ['firecrawl', 'perplexity'],
    );
    expect(hint).toContain('exa');
    expect(hint).toContain('sources');
    // 未命中的源里不应误报 perplexity（它被用了）
    expect(hint).not.toContain('perplexity');
  });

  it('用户显式指定 sources 时不打扰（返回 null）', () => {
    const hint = buildUnusedSourcesHint(
      ['firecrawl', 'exa'],
      ['exa'],
      ['exa'],
    );
    expect(hint).toBeNull();
  });

  it('没有未命中的 premium 源时返回 null', () => {
    const hint = buildUnusedSourcesHint(
      ['firecrawl', 'exa'],
      ['firecrawl', 'exa'],
    );
    expect(hint).toBeNull();
  });

  it('firecrawl/cloud 等基础设施源未命中也不提示', () => {
    const hint = buildUnusedSourcesHint(
      ['firecrawl', 'cloud'],
      ['firecrawl'],
    );
    expect(hint).toBeNull();
  });

  it('多个未命中 premium 源全部列出', () => {
    const hint = buildUnusedSourcesHint(
      ['firecrawl', 'exa', 'brave', 'tavily'],
      ['firecrawl'],
    );
    expect(hint).toContain('exa');
    expect(hint).toContain('brave');
    expect(hint).toContain('tavily');
  });
});
