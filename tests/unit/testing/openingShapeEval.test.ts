// ============================================================================
// 开场形状断言 — 用二期 dogfood 真实观测到的三种失败当标本
//
// 每条 fail 用例都不是假想的：它们是 2026-07-15 二期 dogfood 真跑出来的开场，
// 工具序列照抄自 MiniMax / DeepSeek 的日志。这条断言存在的意义就是让这三种
// 开场在 eval 里能被读出来——在此之前 cowork 用例只测「最后有没有文件」。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { evaluateNoStallBeforeArtifactExpectation } from '../../../src/host/testing/openingShapeEval';
import type { ToolExecutionRecord } from '../../../src/host/testing/types';

const exec = (tool: string): ToolExecutionRecord => ({
  tool,
  input: {},
  output: '',
  success: true,
  duration: 0,
  timestamp: 0,
});

/** dogfood-marketing-ppt 的口径：该用例无附件、主题通用，先查/先问都是拖延 */
const PPT_PARAMS = {
  artifact_tools: ['Skill', 'ppt_generate', 'Write'],
  stall_tools: ['WebSearch', 'AskUserQuestion', 'ListDirectory'],
};

describe('no_stall_before_artifact：先产 = pass', () => {
  it('首个动作就是产物动作', () => {
    const r = evaluateNoStallBeforeArtifactExpectation(PPT_PARAMS, [exec('Skill'), exec('Write')]);
    expect(r.passed).toBe(true);
    expect(r.actual).toContain('produced first');
  });

  it('产出之后再去查资料不算拖延（窗口只看锚点之前）', () => {
    const r = evaluateNoStallBeforeArtifactExpectation(PPT_PARAMS, [
      exec('Skill'),
      exec('WebSearch'),
      exec('AskUserQuestion'),
    ]);
    expect(r.passed).toBe(true);
  });
});

describe('no_stall_before_artifact：二期 dogfood 实测的三种开场失败都必须红', () => {
  it('旧提示词：首轮 WebSearch ×2 先调研（MiniMax + DeepSeek 两模型复现）', () => {
    const r = evaluateNoStallBeforeArtifactExpectation(PPT_PARAMS, [
      exec('WebSearch'),
      exec('WebSearch'),
      exec('Skill'),
    ]);
    expect(r.passed).toBe(false);
    expect(r.actual).toContain('stalled before producing');
    expect(r.actual).toContain('WebSearch');
  });

  it('关掉调研门后：首轮 AskUserQuestion 先问用途/受众', () => {
    const r = evaluateNoStallBeforeArtifactExpectation(PPT_PARAMS, [
      exec('AskUserQuestion'),
      exec('Skill'),
    ]);
    expect(r.passed).toBe(false);
    expect(r.actual).toContain('AskUserQuestion');
  });

  it('再关提问门后：ListDirectory → AskUserQuestion 先翻一圈再问', () => {
    const r = evaluateNoStallBeforeArtifactExpectation(PPT_PARAMS, [
      exec('ListDirectory'),
      exec('AskUserQuestion'),
      exec('ppt_generate'),
    ]);
    expect(r.passed).toBe(false);
    expect(r.details).toContain('ListDirectory');
  });
});

describe('no_stall_before_artifact：fail-loud，绝不假绿', () => {
  it('全程没有产物动作必须红 —— 窗口为空会「真空通过」，这是最危险的假绿', () => {
    const r = evaluateNoStallBeforeArtifactExpectation(PPT_PARAMS, []);
    expect(r.passed).toBe(false);
    expect(r.actual).toContain('never started producing');
  });

  it('只拖延、从没产出，同样必须红（而不是「窗口里没锚点所以算过」）', () => {
    const r = evaluateNoStallBeforeArtifactExpectation(PPT_PARAMS, [
      exec('WebSearch'),
      exec('AskUserQuestion'),
    ]);
    expect(r.passed).toBe(false);
    expect(r.actual).toContain('never started producing');
  });

  it.each([
    [{ stall_tools: ['WebSearch'] }, 'artifact_tools'],
    [{ artifact_tools: ['Skill'] }, 'stall_tools'],
    [{ artifact_tools: [], stall_tools: ['WebSearch'] }, 'artifact_tools'],
    [{ artifact_tools: ['Skill'], stall_tools: [42] }, 'stall_tools'],
  ])('缺参/坏参必须红: %j', (params, badKey) => {
    const r = evaluateNoStallBeforeArtifactExpectation(params as Record<string, unknown>, [exec('Skill')]);
    expect(r.passed).toBe(false);
    expect(r.actual).toContain('invalid params');
    expect(r.actual).toContain(badKey);
  });

  it('两表交集必须红：同一调用既是锚点又是违规，判据自相矛盾', () => {
    const r = evaluateNoStallBeforeArtifactExpectation(
      { artifact_tools: ['Write'], stall_tools: ['Write'] },
      [exec('Write')],
    );
    expect(r.passed).toBe(false);
    expect(r.actual).toContain('overlap');
  });
});

describe('no_stall_before_artifact：与 sim_* 同口径', () => {
  it('大小写不敏感 —— 工具名变体不许绕过判据', () => {
    const r = evaluateNoStallBeforeArtifactExpectation(PPT_PARAMS, [
      exec('websearch'),
      exec('SKILL'),
    ]);
    expect(r.passed).toBe(false);
    expect(r.actual).toContain('websearch');
  });

  it('锚点自身不算违规（窗口左闭右开）', () => {
    // 用「同一个工具名同时匹配两边模式」的构造，否则这条测不出边界：
    // 锚点若不匹配任何 stall 模式，窗口含不含它都一样过，测试就是空的（变异验证实证）。
    // overlap 守卫是**模式对模式**比对，'^Sk' 与 'ill$' 互不匹配 → 放行，
    // 但工具 'Skill' 两边都中 —— 此时窗口边界真正承重。
    const r = evaluateNoStallBeforeArtifactExpectation(
      { artifact_tools: ['^Sk'], stall_tools: ['ill$'] },
      [exec('Skill')],
    );
    expect(r.passed).toBe(true);
    expect(r.details).toContain('scanned 0 executions');
  });
});
