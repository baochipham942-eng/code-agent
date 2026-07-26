import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPLORE_AGENT_DESCRIPTION } from '../../../src/shared/constants';
import { CORE_AGENTS } from '../../../src/host/agent/hybrid/coreAgents';
import { spawnAgentSchema } from '../../../src/host/tools/modules/multiagent/spawnAgent.schema';

const sourcePath = path.join(
  process.cwd(),
  'src/host/tools/modules/multiagent/spawnAgent.schema.ts',
);

function exploreLine(description: string): string | undefined {
  return description.split('\n').find((line) => line.startsWith('- explore'));
}

describe('spawn_agent explore result guidance', () => {
  it('explore prompt requires conflicts and uncertainty to be surfaced', () => {
    const prompt = String(CORE_AGENTS.explore.prompt);
    expect(prompt).toContain(
      'Report conflicting evidence explicitly instead of selecting one source and presenting a single confident answer',
    );
    expect(prompt).toContain(
      'Label uncertainty when evidence is incomplete; do not present inference as established fact',
    );
  });

  it('parent guidance reuses results but resolves evidence conflicts before integration', () => {
    expect(spawnAgentSchema.description).toContain(
      'Use sub-agent results directly without repeating the same search; if they conflict with other evidence you have, resolve the conflict before integrating',
    );
  });

  it('static and fallback explore descriptions both reference the shared constant', () => {
    expect(CORE_AGENTS.explore.description).toBe(EXPLORE_AGENT_DESCRIPTION);
    expect(exploreLine(spawnAgentSchema.description)).toBe(
      `- explore (alias: explorer): ${EXPLORE_AGENT_DESCRIPTION}`,
    );
    expect(exploreLine(spawnAgentSchema.dynamicDescription?.() ?? '')).toBe(
      `- explore: ${EXPLORE_AGENT_DESCRIPTION}`,
    );

    const source = readFileSync(sourcePath, 'utf8');
    expect(source.match(/\$\{EXPLORE_AGENT_DESCRIPTION\}/g)).toHaveLength(2);
  });
});
