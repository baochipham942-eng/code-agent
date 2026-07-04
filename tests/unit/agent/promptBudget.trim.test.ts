// ============================================================================
// trimPreambleBeforeRequiredArtifactBlock — 合并预算口径（审计 A8/M3）
// 前缀稳定改造后 system 只承载稳定前缀，动态尾巴单独成消息；
// trim 的触发判断必须把尾巴 token 计入，否则「稳定前缀单独没超、
// 加上必需尾巴块就超」的修复压力场景下 preamble 永远不会被裁。
// ============================================================================

import { afterEach, describe, expect, it } from 'vitest';
import { trimPreambleBeforeRequiredArtifactBlock } from '../../../src/host/agent/runtime/contextAssembly/promptBudget';

const CONTRACT_MARKER = '\n\n## Game Artifact Contract\n';

describe('trimPreambleBeforeRequiredArtifactBlock 合并预算口径', () => {
  const prevEnv = process.env.CODE_AGENT_MAX_SYSTEM_PROMPT_TOKENS;
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.CODE_AGENT_MAX_SYSTEM_PROMPT_TOKENS;
    else process.env.CODE_AGENT_MAX_SYSTEM_PROMPT_TOKENS = prevEnv;
  });

  it('稳定前缀单独没超预算、加上尾巴超了 → 计入 extraTokens 后 trim 生效', () => {
    // 无 ctx 时预算 = MAX_SYSTEM_PROMPT_TOKENS（默认 6000）
    delete process.env.CODE_AGENT_MAX_SYSTEM_PROMPT_TOKENS;
    // preamble ≈ 5000 tokens（'word '×5000 ≈ 5000 tok），contract 尾段小
    const prompt = `${'word '.repeat(5000)}${CONTRACT_MARKER}contract body`;

    // 不带 extraTokens：prompt 自身 ≈ 5000 < 6000，不裁（保持既有行为）
    const untouched = trimPreambleBeforeRequiredArtifactBlock(prompt);
    expect(untouched).toBe(prompt);

    // 带 extraTokens=2000（模拟必需尾巴块）：合并 7000 > 6000，preamble 被裁
    const trimmed = trimPreambleBeforeRequiredArtifactBlock(prompt, undefined, 2000);
    expect(trimmed).not.toBe(prompt);
    expect(trimmed).toContain('## Game Artifact Contract');
    expect(trimmed).toContain('[base prompt trimmed to preserve required artifact contract]');
    expect(trimmed.length).toBeLessThan(prompt.length);
  });

  it('合并后仍在预算内则不动', () => {
    delete process.env.CODE_AGENT_MAX_SYSTEM_PROMPT_TOKENS;
    const prompt = `${'word '.repeat(1000)}${CONTRACT_MARKER}contract body`;
    expect(trimPreambleBeforeRequiredArtifactBlock(prompt, undefined, 500)).toBe(prompt);
  });
});
