import { describe, expect, it } from 'vitest';
import { extractArtifacts } from '../../../src/host/agent/artifactExtractor';

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

  it('extracts the canonical legacy generative_ui fence', () => {
    const html = '<!doctype html><html><head><title>Demo</title></head><body>'
      + '<div>interactive</div>'.repeat(40)
      + '</body></html>';
    const artifacts = extractArtifacts(`\`\`\`generative_ui\n${html}\n\`\`\``);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ type: 'generative_ui', title: 'Demo' });
  });

  it('extracts native neo_ui JSON separately from legacy HTML', () => {
    const spec = JSON.stringify({
      schemaVersion: 1,
      title: 'Choose a plan',
      components: [{ id: 'plan', type: 'ChoiceGroup', props: { options: ['A', 'B'] } }],
      fallback: 'Choose A or B.',
    });
    const artifacts = extractArtifacts(`\`\`\`neo_ui\n${spec}\n\`\`\``);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ type: 'neo_ui', title: 'Choose a plan', content: spec });
  });
});
