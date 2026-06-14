import { describe, expect, it } from 'vitest';
import { attachSessionQualityScoring } from '../../../src/main/evaluation/sessionQualityScoring';
import type { StructuredReplay } from '../../../src/shared/contract/evaluation';

function replay(): StructuredReplay {
  return {
    sessionId: 'session-quality-1',
    traceIdentity: {
      sessionId: 'session-quality-1',
      traceId: 'trace-session-quality-1',
      traceSource: 'session_replay',
      source: 'session_replay',
      replayKey: 'session:session-quality-1',
    },
    traceSource: 'session_replay',
    dataSource: 'transcript_fallback',
    turns: [{
      turnNumber: 1,
      blocks: [{
        type: 'memory_audit',
        content: 'Memory auto; 1 memories; openai/gpt-4.1; score 80/100',
        timestamp: 1,
        memoryAudit: {
          mode: 'auto',
          blocks: [{
            blockType: 'seed-memory',
            trigger: 'session_start',
            source: 'memory-packer',
            injected: true,
            chars: 50,
            count: 1,
          }],
          score: {
            score: 80,
            max: 100,
            grade: 'good',
            breakdown: [
              { dimension: 'strategy', score: 16, max: 20, status: 'good', reasons: ['命中 main 策略'] },
              { dimension: 'memory', score: 18, max: 20, status: 'good', reasons: ['注入 1 个记忆块'] },
            ],
          },
          agentScorecard: {
            agentId: 'coder',
            agentName: 'Coder',
            model: 'openai/gpt-4.1',
            strategyProfile: 'main',
            memoryUsed: 1,
            toolsUsed: 2,
            warnings: 0,
            score: {
              score: 80,
              max: 100,
              grade: 'good',
              breakdown: [
                { dimension: 'strategy', score: 16, max: 20, status: 'good', reasons: ['命中 main 策略'] },
              ],
            },
          },
        },
      }],
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
      startTime: 1,
    }],
    summary: {
      totalTurns: 1,
      toolDistribution: {
        Read: 0,
        Edit: 0,
        Write: 0,
        Bash: 0,
        Search: 0,
        Web: 0,
        Agent: 0,
        Skill: 0,
        Other: 0,
      },
      thinkingRatio: 0,
      selfRepairChains: 0,
      totalDurationMs: 0,
    },
  };
}

describe('attachSessionQualityScoring', () => {
  it('aggregates memory audit scores and agent scorecards into replay summary', () => {
    const scored = attachSessionQualityScoring(replay());

    expect(scored.summary.qualityScore).toMatchObject({
      score: 34,
      max: 40,
      grade: 'good',
    });
    expect(scored.summary.agentScorecards).toHaveLength(1);
    expect(scored.summary.agentScorecards?.[0]).toMatchObject({
      agentId: 'coder',
      memoryUsed: 1,
      toolsUsed: 2,
    });
  });
});
