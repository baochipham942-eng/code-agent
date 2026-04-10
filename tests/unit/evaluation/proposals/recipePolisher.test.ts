// ============================================================================
// recipePolisher tests — Self-Evolving v2.5 Phase 6
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  polishRecipe,
  buildPrompt,
  type RecipePolishInput,
  type ChatFn,
} from '../../../../src/main/evaluation/proposals/recipePolisher';

function makeInput(overrides: Partial<RecipePolishInput> = {}): RecipePolishInput {
  return {
    category: 'loop',
    count: 3,
    weightedScore: 2.25,
    sampleSummaries: [
      'bash retried grep 5 times with identical args',
      'read retried same file 4 times without reading output',
      'web_search retried 6 times with same query variants',
    ],
    staticRecipe: {
      hypothesis: 'Agent 在最近 3 个 session 中出现工具重复调用循环，应当自我中断',
      targetMetric: 'loop 根因次数 >= 50% 下降',
      ruleDraftHeader: '防循环规则（待人工 refine）',
      ruleDraftBullets: [
        '当同一工具连续 3 次使用相似参数时，必须停止',
        '立即报告当前状态，重新评估任务路径',
        '禁止盲目重试；优先考虑替代工具或完全不同的方法',
      ],
    },
    ...overrides,
  };
}

const VALID_RESPONSE = JSON.stringify({
  hypothesis: '如果 Agent 在看到同一工具连续 3 次相同参数后强制暂停，loop 根因次数将下降',
  targetMetric: 'loop 类型根因在下一个 synthesize 周期相对下降 ≥ 50%',
  ruleDraftHeader: '工具自我中断规则',
  ruleDraftBullets: [
    '当同一工具连续调用 3 次且参数相似度 >= 80% 时，必须立即暂停并报告原因',
    '当 read 同一文件超过 2 次时，必须先读取输出摘要再决定是否继续',
    '当 web_search 同一 query 变体超过 3 次无有效结果时，换策略或停止',
  ],
});

describe('recipePolisher', () => {
  it('polishes successfully when chatFn returns valid JSON', async () => {
    const chat: ChatFn = async () => VALID_RESPONSE;
    const result = await polishRecipe(makeInput(), chat);
    expect(result).not.toBeNull();
    expect(result!.ruleDraftBullets).toHaveLength(3);
    expect(result!.ruleDraftBullets[0]).toContain('立即暂停');
    expect(result!.hypothesis).toContain('loop');
  });

  it('handles fenced JSON responses', async () => {
    const chat: ChatFn = async () => `Here is your polished recipe:\n\`\`\`json\n${VALID_RESPONSE}\n\`\`\`\nHope it helps!`;
    const result = await polishRecipe(makeInput(), chat);
    expect(result).not.toBeNull();
    expect(result!.ruleDraftHeader).toBe('工具自我中断规则');
  });

  it('returns null on JSON parse failure', async () => {
    const chat: ChatFn = async () => 'this is not json at all';
    const result = await polishRecipe(makeInput(), chat);
    expect(result).toBeNull();
  });

  it('returns null when required field is missing', async () => {
    const broken = JSON.stringify({
      hypothesis: 'h',
      targetMetric: 'm',
      // ruleDraftHeader missing
      ruleDraftBullets: ['a', 'b'],
    });
    const chat: ChatFn = async () => broken;
    const result = await polishRecipe(makeInput(), chat);
    expect(result).toBeNull();
  });

  it('returns null when bullets count is out of range (too few)', async () => {
    const broken = JSON.stringify({
      hypothesis: 'h',
      targetMetric: 'm',
      ruleDraftHeader: 'head',
      ruleDraftBullets: ['only one'],
    });
    const chat: ChatFn = async () => broken;
    const result = await polishRecipe(makeInput(), chat);
    expect(result).toBeNull();
  });

  it('returns null when bullets count is out of range (too many)', async () => {
    const broken = JSON.stringify({
      hypothesis: 'h',
      targetMetric: 'm',
      ruleDraftHeader: 'head',
      ruleDraftBullets: ['1', '2', '3', '4', '5', '6', '7'],
    });
    const chat: ChatFn = async () => broken;
    const result = await polishRecipe(makeInput(), chat);
    expect(result).toBeNull();
  });

  it('returns null when a bullet is not a non-empty string', async () => {
    const broken = JSON.stringify({
      hypothesis: 'h',
      targetMetric: 'm',
      ruleDraftHeader: 'head',
      ruleDraftBullets: ['valid bullet', '   '],
    });
    const chat: ChatFn = async () => broken;
    const result = await polishRecipe(makeInput(), chat);
    expect(result).toBeNull();
  });

  it('returns null when chatFn throws', async () => {
    const chat: ChatFn = async () => {
      throw new Error('network timeout');
    };
    const result = await polishRecipe(makeInput(), chat);
    expect(result).toBeNull();
  });

  it('buildPrompt includes category, samples, and baseline recipe', () => {
    const prompt = buildPrompt(makeInput());
    expect(prompt).toContain('失败根因类别: loop');
    expect(prompt).toContain('bash retried grep 5 times');
    expect(prompt).toContain('防循环规则（待人工 refine）');
    expect(prompt).toContain('"ruleDraftBullets"');
  });

  it('buildPrompt truncates sample summaries to 8 max', () => {
    const many = Array.from({ length: 20 }, (_, i) => `sample ${i}`);
    const prompt = buildPrompt(makeInput({ sampleSummaries: many }));
    // Count digit-prefixed sample lines in the "证据样本" section.
    const sampleLines = prompt.split('\n').filter((l) => /^\s+\d+\. sample \d+$/.test(l));
    expect(sampleLines.length).toBe(8);
  });
});
