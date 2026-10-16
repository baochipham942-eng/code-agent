import { describe, expect, it } from 'vitest';
import { AgentRequirementsAnalyzer } from '../../../src/host/agent/agentRequirementsAnalyzer';
import { chatTranscriptEn, chatTranscriptZh } from '../../../src/renderer/i18n/chatTranscript';

// PR review 2026-10-15（rework r2）：竞品简报卡的「少量实体 + 单轮交付」是
// bounded comparison，auto-delegator 的通用复杂度启发式不得把它推去自动生成
// 后台代理——那正是 2026-10-11 swarm 审批卡卡死首轮的入口。
describe('AgentRequirementsAnalyzer — 小范围单轮对比不自动派发', () => {
  it.each([
    ['zh', chatTranscriptZh.chat.suggestions.competitorBrief.prompt],
    ['en', chatTranscriptEn.chat.suggestions.competitorBrief.prompt],
  ])('%s 竞品卡保持常规循环（不自动生成代理）', async (_language, prompt) => {
    const requirements = await new AgentRequirementsAnalyzer().analyze(prompt);

    expect(requirements.needsAutoAgent).toBe(false);
  });

  it('显式大型多维任务仍自动派发（无回归）', async () => {
    const requirements = await new AgentRequirementsAnalyzer().analyze(
      'Compare 12 vendors across security, performance, quality, frontend, backend, database, and API dimensions. Produce a comprehensive report with independent findings, a complete recommendation, and a rollout plan. Validate sources, explain tradeoffs, and identify the highest-risk gaps for each vendor.',
    );

    expect(requirements.needsAutoAgent).toBe(true);
  });
});
