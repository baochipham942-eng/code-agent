// ============================================================================
// 生成端约束：IACT `!send` chip 不得承载「用户自行处理」类选项。
//
// 2026-08-01 真机事故：agent 给出建议项「你来手动打开浏览器看」（语义=用户自己
// 看，agent 停手），用户点击后该文字原样发回，模型把它当新指令又执行一遍网页
// 抓取。发送端已改写为用户表态模板（见 ChatInput/iactChipConfirmation.ts +
// 对应单测），但生成端仍可能把这类选项包成 !send chip——必须两端同修，只改
// 发送端是假安全（模板会完整保留原句歧义）。
//
// 静态层是字符串，纯函数断言即可，不需要跑模型。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { CONCISENESS_RULES } from '../../../src/host/prompts/identity';

// CONCISENESS_RULES 是 registry.ts 的 live-prompt Proxy（非真 string），
// 模板字符串插值走 Symbol.toPrimitive 强制求值成真字符串（同 staticPromptDecoding.test.ts 先例）。
const RULES_TEXT = `${CONCISENESS_RULES}`;

describe('inline_actions: 禁止把「用户自理」选项生成为 !send chip', () => {
  it('钉了禁止把用户自理选项做成 chip 的约束', () => {
    expect(RULES_TEXT).toContain('Never use `!send` for an option whose meaning is');
    expect(RULES_TEXT).toContain('I (the user) will handle this myself');
  });

  it('约束句落在 <inline_actions> 块内，且在 !send 语法说明之后', () => {
    const inlineActionsStart = RULES_TEXT.indexOf('<inline_actions>');
    const inlineActionsEnd = RULES_TEXT.indexOf('</inline_actions>');
    const sendSyntaxIndex = RULES_TEXT.indexOf('user clicks to send');
    const constraintIndex = RULES_TEXT.indexOf('Never use `!send` for an option');

    expect(inlineActionsStart).toBeGreaterThanOrEqual(0);
    expect(inlineActionsEnd).toBeGreaterThan(inlineActionsStart);
    expect(constraintIndex).toBeGreaterThan(sendSyntaxIndex);
    expect(constraintIndex).toBeLessThan(inlineActionsEnd);
  });
});
