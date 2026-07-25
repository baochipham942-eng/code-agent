// ============================================================================
// 系统提示词预算门（2026-07-25 费曼审计 P2-6）
//
// builder.ts 头注自定目标 <2000 tokens，实测 ~5761（getSoul 占近半）——目标
// 停在许愿。二选一拍板结果：按现实改目标并立门守住（收敛 soul 是产品质量
// 决策，另立项）。预算 = 建门日实测 + ~10% 余量；想加提示词内容先来这里
// 提额并说明为什么。
//
// 自举：下限断言防「空 prompt 假绿」（测试环境工具注册表缺省时 prompt 变短，
// 低于下限说明构建本身坏了而不是变省了）。
// ============================================================================
import { describe, expect, it } from 'vitest';
import { buildPrompt, SYSTEM_PROMPT_TOKEN_BUDGET } from '../../src/host/prompts/builder';
import { estimateTokens } from '../../src/host/context/tokenEstimator';

describe('system prompt token budget', () => {
  const prompt = buildPrompt();
  const tokens = estimateTokens(prompt);

  it(`stays within the budget (${SYSTEM_PROMPT_TOKEN_BUDGET} tokens)`, () => {
    expect(
      tokens,
      `系统提示词估算 ${tokens} tokens 超出预算 ${SYSTEM_PROMPT_TOKEN_BUDGET}——先收敛内容或带理由提额`,
    ).toBeLessThanOrEqual(SYSTEM_PROMPT_TOKEN_BUDGET);
  });

  it('is not accidentally empty (gate anchor sanity)', () => {
    expect(tokens, `系统提示词只有 ${tokens} tokens——构建链路坏了（soul/工具描述缺失），不是真变省了`).toBeGreaterThan(2000);
    expect(prompt.length).toBeGreaterThan(0);
  });
});
