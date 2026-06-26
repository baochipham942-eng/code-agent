import { describe, expect, it } from 'vitest';
import { buildSearchPlan } from '../../../../src/main/tools/web/search';

describe('searchPlanner', () => {
  it('keeps quick mode to the primary query', () => {
    const plan = buildSearchPlan('OpenAI Responses API web_search parameters', { mode: 'quick' });

    expect(plan.intent).toBe('official_docs');
    expect(plan.maxQueryRewrites).toBe(0);
    expect(plan.queries).toEqual([
      { query: 'OpenAI Responses API web_search parameters', purpose: 'primary' },
    ]);
  });

  it('adds at most one complementary query in research mode', () => {
    const plan = buildSearchPlan('vitest worker timeout github issue', { mode: 'research' });

    expect(plan.intent).toBe('github_issue');
    expect(plan.maxQueryRewrites).toBe(1);
    expect(plan.queries).toHaveLength(2);
    expect(plan.queries[1]).toEqual({
      query: 'vitest worker timeout github issue site:github.com',
      purpose: 'github',
    });
  });

  it('does not rewrite when user already constrained sources or site operators', () => {
    expect(buildSearchPlan('tailwind v4 site:tailwindcss.com', { mode: 'research' }).queries).toHaveLength(1);
    expect(buildSearchPlan('tailwind v4', { mode: 'research', requestedSources: ['exa'] }).queries).toHaveLength(1);
  });
});
