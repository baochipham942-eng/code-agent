import { describe, expect, it } from 'vitest';
import { extractArtifacts } from '../../../src/main/agent/artifactExtractor';

describe('artifactExtractor', () => {
  it('rebuilds stable artifact ids from persisted assistant content', () => {
    const content = [
      'Here is the chart:',
      '```chart',
      '{"title":"Usage","data":[{"x":1,"y":2}]}',
      '```',
    ].join('\n');

    const first = extractArtifacts(content);
    const second = extractArtifacts(content);

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      type: 'chart',
      title: 'Usage',
      content: '{"title":"Usage","data":[{"x":1,"y":2}]}',
    });
    expect(second[0]?.id).toBe(first[0]?.id);
  });
});
