// ============================================================================
// N-CSV-ATTACH-PREVIEW-AND-VISIBILITY-FU2 — adaptive-thinking 三问的回复格式框定
// ----------------------------------------------------------------------------
// 真跑回归（父单 GLM 轮）：模型把 <thinking> 三问（执行结果是否符合预期 / 离最终
// 目标还有多远 / 下一步的最优行动）的结构化答案——executionStatus / gapAnalysis /
// nextAction 形状的裸 JSON——当成最终回复原样发给了用户。修复：三问必须声明
// 「内部自检 + 面向用户的回复用自然语言」，两段变体（成功/失败）都如此。
// ============================================================================
import { describe, expect, it } from 'vitest';
import { generateThinkingPrompt } from '../../../src/host/agent/runtime/contextAssembly/modeInjection';
import type { ContextAssemblyCtx } from '../../../src/host/agent/runtime/contextAssembly/shared';
import type { ToolCall, ToolResult } from '../../../src/shared/contract';

const ctx = {} as ContextAssemblyCtx;

const toolCalls: ToolCall[] = [
  { id: 'call_1', name: 'task_status', arguments: {} },
];

const okResults: ToolResult[] = [
  { toolCallId: 'call_1', success: true, output: '1. 求和 [running]' },
];

const failedResults: ToolResult[] = [
  { toolCallId: 'call_1', success: false, error: 'boom' },
];

describe('generateThinkingPrompt reply-format framing', () => {
  it('frames the no-error self-check as internal and requires a natural-language reply', () => {
    const prompt = generateThinkingPrompt(ctx, toolCalls, okResults);

    expect(prompt).toContain('<thinking>');
    expect(prompt).toContain('1. 执行结果是否符合预期？');
    expect(prompt).toContain('2. 离最终目标还有多远？');
    expect(prompt).toContain('3. 下一步的最优行动是什么？');
    // 三问必须是内部自检，不允许以裸问卷形态出现（旧形态诱导结构化状态回复）
    expect(prompt).toContain('先在内部自检');
    expect(prompt).toContain('不进入面向用户的回复');
    expect(prompt).toContain('对用户的回复用自然语言直接回答用户的原始问题');
    expect(prompt).not.toContain('请简要分析');
  });

  it('frames the error-recovery self-check the same way', () => {
    const prompt = generateThinkingPrompt(ctx, toolCalls, failedResults);

    expect(prompt).toContain('刚执行了 task_status，其中有工具失败。');
    expect(prompt).toContain('1. 错误的根本原因是什么？');
    expect(prompt).toContain('先在内部自检');
    expect(prompt).toContain('不进入面向用户的回复');
    expect(prompt).toContain('对用户的回复用自然语言直接回答用户的原始问题');
  });
});
