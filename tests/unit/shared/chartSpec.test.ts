import { describe, expect, it } from 'vitest';
import {
  normalizeChartSpec,
  parseChartSpecSource,
} from '../../../src/shared/chartSpec';

describe('chartSpec', () => {
  it('infers a drawable series for common name/value bar charts', () => {
    const spec = parseChartSpecSource(JSON.stringify({
      type: 'bar',
      title: 'Acceptance',
      data: [
        { name: 'role assets', value: 4 },
        { name: 'proactivity', value: 5 },
      ],
    }));

    expect(spec).not.toBeNull();
    expect(spec?.xKey).toBe('name');
    expect(spec?.series).toEqual([{ key: 'value' }]);
  });

  it('keeps explicit xKey and series untouched', () => {
    const spec = normalizeChartSpec({
      type: 'line',
      xKey: 'year',
      series: [{ key: 'Python', name: 'Python usage' }],
      data: [{ year: 2026, Python: 76, TypeScript: 82 }],
    });

    expect(spec.xKey).toBe('year');
    expect(spec.series).toEqual([{ key: 'Python', name: 'Python usage' }]);
  });

  it('normalizes pie charts that use label/count data', () => {
    const spec = normalizeChartSpec({
      type: 'pie',
      xKey: 'label',
      data: [
        { label: 'pass', count: 7 },
        { label: 'fail', count: 1 },
      ],
    });

    expect(spec.data).toEqual([
      { label: 'pass', count: 7, name: 'pass', value: 7 },
      { label: 'fail', count: 1, name: 'fail', value: 1 },
    ]);
  });
});
