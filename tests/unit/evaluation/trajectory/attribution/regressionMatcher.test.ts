// ============================================================================
// regressionMatcher tests — Self-Evolving v2.5 Phase 2
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { matchRegressionCases } from '../../../../../src/main/evaluation/trajectory/attribution/regressionMatcher';
import type {
  Trajectory,
  TrajectoryStep,
} from '../../../../../src/main/testing/types';

function toolStep(index: number, name: string, success: boolean): TrajectoryStep {
  return {
    index,
    timestamp: index * 100,
    type: 'tool_call',
    toolCall: { name, args: {}, success, duration: 10 },
  };
}

function errorStep(index: number, message: string): TrajectoryStep {
  return {
    index,
    timestamp: index * 100,
    type: 'error',
    error: { message, recoverable: true },
  };
}

function makeTraj(steps: TrajectoryStep[]): Trajectory {
  return {
    id: 'traj_test',
    sessionId: 'sess',
    startTime: 0,
    endTime: 100,
    steps,
    deviations: [],
    recoveryPatterns: [],
    efficiency: {
      totalSteps: steps.length,
      effectiveSteps: steps.length,
      redundantSteps: 0,
      backtrackCount: 0,
      totalTokens: { input: 0, output: 0 },
      totalDuration: 0,
      tokensPerEffectiveStep: 0,
      efficiency: 1,
    },
    summary: { intent: 't', outcome: 'failure', criticalPath: [] },
  };
}

async function writeCase(
  dir: string,
  id: string,
  tags: string[],
  scenario: string,
  evalCommand = 'true',
  symptoms?: string[]
): Promise<void> {
  const symptomsLine =
    symptoms && symptoms.length > 0 ? `\nsymptoms: [${symptoms.join(', ')}]` : '';
  const fm = `---
id: ${id}
source: test
tags: [${tags.join(', ')}]
related_rules: []${symptomsLine}
eval_command: "${evalCommand}"
---

## 场景
${scenario}

## 预期行为
expected
`;
  await fs.writeFile(path.join(dir, `${id}.md`), fm);
}

describe('regressionMatcher', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reg-match-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('matches case by tool name + keyword overlap above threshold', async () => {
    await writeCase(
      tmpDir,
      'reg-001',
      ['bash', 'process'],
      'bash command executing with process environment variable undefined'
    );
    await writeCase(
      tmpDir,
      'reg-002',
      ['read_file', 'binary'],
      'read_file returns binary garbage for pdf files'
    );

    const traj = makeTraj([
      toolStep(0, 'bash', false),
      errorStep(1, 'process.env undefined in bash shell'),
    ]);
    const matches = await matchRegressionCases(traj, tmpDir);
    expect(matches).toContain('reg-001');
    expect(matches).not.toContain('reg-002');
  });

  it('returns empty array when trajectory is unrelated', async () => {
    await writeCase(
      tmpDir,
      'reg-001',
      ['bash', 'process'],
      'bash command with process env undefined'
    );
    const traj = makeTraj([toolStep(0, 'write_file', true)]);
    const matches = await matchRegressionCases(traj, tmpDir);
    expect(matches).toEqual([]);
  });

  it('returns empty array when cases directory does not exist', async () => {
    const bogus = path.join(tmpDir, 'does-not-exist');
    const traj = makeTraj([toolStep(0, 'bash', false)]);
    const matches = await matchRegressionCases(traj, bogus);
    expect(matches).toEqual([]);
  });

  it('matches via symptoms substring even when tags/scenario miss', async () => {
    // reg-003 style: Chinese scenario, symptoms list contains the English
    // identifiers that actually show up in the error message.
    await writeCase(
      tmpDir,
      'reg-003',
      ['protocol', 'compressor'],
      'autoCompressor 破坏 tool_calls 配对',
      'true',
      ['tool_use_id', 'tool_call_id', 'sanitizeToolCallOrder']
    );
    const traj = makeTraj([
      toolStep(0, 'Edit', true),
      errorStep(
        1,
        'Claude API (400): messages.12.content.2: unexpected `tool_use_id` found in `tool_result` blocks'
      ),
    ]);
    const matches = await matchRegressionCases(traj, tmpDir);
    expect(matches).toContain('reg-003');
  });

  it('symptom match wins even when other signals are weak', async () => {
    await writeCase(
      tmpDir,
      'reg-x',
      ['whatever'],
      'unrelated scenario text',
      'true',
      ['specific_error_token']
    );
    const traj = makeTraj([
      toolStep(0, 'unused_tool', true),
      errorStep(1, 'something failed with specific_error_token here'),
    ]);
    const matches = await matchRegressionCases(traj, tmpDir);
    expect(matches).toContain('reg-x');
  });

  it('ignores malformed case files without throwing', async () => {
    await fs.writeFile(path.join(tmpDir, 'reg-broken.md'), 'no frontmatter here');
    await writeCase(
      tmpDir,
      'reg-001',
      ['bash'],
      'bash command with process env undefined problem'
    );
    const traj = makeTraj([
      toolStep(0, 'bash', false),
      errorStep(1, 'process env undefined'),
    ]);
    const matches = await matchRegressionCases(traj, tmpDir);
    expect(matches).toContain('reg-001');
  });
});
