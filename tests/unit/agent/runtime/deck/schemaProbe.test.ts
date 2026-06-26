// ============================================================================
// schemaProbe — Phase 4 PR-3 step 1 tests.
//
// 验证 SCHEMA_PROBE 与 validateStructuredSlides 行为对齐。
// ============================================================================

import { describe, it, expect } from 'vitest';

import type { DeckArtifactInput } from '../../../../../src/host/agent/runtime/deck/types';
import { SCHEMA_PROBE } from '../../../../../src/host/agent/runtime/deck/general/schemaProbe';
import type { StructuredSlide } from '../../../../../src/host/tools/media/ppt/slideSchemas';

function evaluate(input: Partial<DeckArtifactInput>) {
  if (SCHEMA_PROBE.kind !== 'imperative') throw new Error('expected imperative probe');
  return SCHEMA_PROBE.evaluate({
    structured: [],
    legacy: [],
    ...input,
  });
}

describe('SCHEMA_PROBE', () => {
  it('passes on empty structured (vacuous)', () => {
    const r = evaluate({ structured: [] });
    expect(r.probe).toBe('schema_invalid');
    expect(r.passed).toBe(true);
    expect(r.failure).toBeUndefined();
  });

  it('passes on all-valid structured slides', () => {
    const slides: StructuredSlide[] = [
      { layout: 'list', title: '封面', isTitle: true, content: { points: ['p1'] } },
      {
        layout: 'stats',
        title: '数据',
        content: { stats: [{ label: 'A', value: '1' }, { label: 'B', value: '2' }] },
      },
      { layout: 'list', title: '结尾', isEnd: true, content: { points: ['谢谢'] } },
    ];
    const r = evaluate({ structured: slides });
    expect(r.passed).toBe(true);
  });

  it('fails on at least one invalid slide and includes per-slide detail', () => {
    const slides: StructuredSlide[] = [
      { layout: 'list', title: '封面', isTitle: true, content: { points: ['p1'] } },
      // invalid: stats 缺 stats 数组
      { layout: 'stats', title: '坏数据', content: {} as never },
      { layout: 'list', title: '结尾', isEnd: true, content: { points: ['end'] } },
    ];
    const r = evaluate({ structured: slides });
    expect(r.passed).toBe(false);
    expect(r.failure).toMatch(/schema:/);
    expect(r.failure).toMatch(/slide 2/); // 1-based index
    expect(r.failure).toMatch(/stats/);
    expect(r.affectedSlideIndex).toBe(1); // 0-based
  });

  it('fails on multiple invalid slides — failure aggregates all', () => {
    const slides: StructuredSlide[] = [
      { layout: 'list', title: '封面', isTitle: true, content: { points: ['p1'] } },
      // invalid: stats 缺 stats
      { layout: 'stats', title: '坏1', content: {} as never },
      // invalid: timeline 缺 description
      { layout: 'timeline', title: '坏2', content: { steps: [{ title: 's1' }] } as never },
      { layout: 'list', title: '结尾', isEnd: true, content: { points: ['end'] } },
    ];
    const r = evaluate({ structured: slides });
    expect(r.passed).toBe(false);
    expect(r.failure).toMatch(/2 张 slide 校验失败/);
    expect(r.failure).toMatch(/slide 2/);
    expect(r.failure).toMatch(/slide 3/);
  });

  it('does not depend on legacy field — only structured matters', () => {
    const slides: StructuredSlide[] = [
      { layout: 'list', title: '封面', isTitle: true, content: { points: ['p1'] } },
      { layout: 'list', title: '结尾', isEnd: true, content: { points: ['end'] } },
    ];
    const withLegacy = evaluate({ structured: slides, legacy: [{ title: 'X', points: [] }] });
    const withoutLegacy = evaluate({ structured: slides, legacy: [] });
    expect(withLegacy.passed).toBe(withoutLegacy.passed);
  });
});
