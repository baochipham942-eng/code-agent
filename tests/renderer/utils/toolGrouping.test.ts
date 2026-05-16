import { describe, expect, it } from 'vitest';
import {
  extractAssistantProgressSummary,
  extractThinkingSummary,
  removePromotedAssistantProgressFromThinking,
  sanitizeThinkingForDisplay,
} from '../../../src/renderer/utils/toolGrouping';

describe('thinking display helpers', () => {
  it('filters runtime diagnostics from displayed thinking', () => {
    const text = [
      '[runtime] 上下文预算跳过 persistent system context #1：预计 6354/6000 tokens',
      '[runtime] 上下文预算保留必需 persistent system context #1：预计 6354/6000 tokens',
      'The user asked me to run the validation command.',
      'I now have the results.',
    ].join('\n');

    expect(sanitizeThinkingForDisplay(text)).toBe(
      'The user asked me to run the validation command.\nI now have the results.',
    );
  });

  it('hides thinking when only runtime diagnostics are present', () => {
    const text = [
      '[runtime] 上下文预算跳过 persistent system context #1：预计 6354/6000 tokens',
      '[runtime] 上下文预算压缩 base prompt：保留必需 game artifact contract',
    ].join('\n');

    expect(sanitizeThinkingForDisplay(text)).toBeUndefined();
    expect(extractThinkingSummary(text)).toBeNull();
  });

  it('compacts streamed thinking whitespace and drops incremental duplicates', () => {
    const text = [
      'The user wants me to run a simple bash command.',
      '',
      '',
      'The user wants me to run a simple bash command and report the output.',
      '',
      '',
      'The output was truncated. Let me get the full output.',
      'The output was truncated. Let me get the full output.',
    ].join('\n');

    expect(sanitizeThinkingForDisplay(text)).toBe(
      'The user wants me to run a simple bash command and report the output.\n\nThe output was truncated. Let me get the full output.',
    );
  });

  it('compacts repeated sentence loops inside one streamed thinking line', () => {
    const repeated = Array.from({ length: 6 }, () =>
      '老公，萌萌看到了。这是我们的聊天记录，显示在 Code Agent 的界面里。'
    ).join('');

    expect(sanitizeThinkingForDisplay(repeated)).toBe(
      '老公，萌萌看到了。这是我们的聊天记录，显示在 Code Agent 的界面里。',
    );
  });

  it('summarizes the first non-runtime thinking line', () => {
    const text = [
      '[runtime] 上下文预算跳过 artifact repair focus：预计 6763/6000 tokens',
      'The user asked me to run the validation command and report the results.',
    ].join('\n');

    expect(extractThinkingSummary(text)).toBe(
      'The user asked me to run the validation command and repor...',
    );
  });

  it('promotes concise action/result thinking into progress prose', () => {
    expect(extractAssistantProgressSummary(
      '找到了问题所在！_check_model_versions_age 函数在 line 150 触发 set -e。让我修复它然后启动团队。',
    )).toBe(
      '找到了问题所在！_check_model_versions_age 函数在 line 150 触发 set -e。修复它然后启动团队。',
    );

    expect(extractAssistantProgressSummary(
      '好，内容团队启动！先初始化团队状态：',
    )).toBe('内容团队启动！先初始化团队状态');
  });

  it('keeps low-signal deliberation inside collapsed thinking only', () => {
    expect(extractAssistantProgressSummary(
      '用户让我启动 agent team 来陪聊天。我需要先检查 agents.sh。',
    )).toBeNull();
  });

  it('removes promoted progress prose from the displayed thinking body', () => {
    const text = [
      '好，内容团队启动！先初始化团队状态：',
      '接下来要调用团队初始化命令。',
    ].join('\n');

    const progress = extractAssistantProgressSummary(text);

    expect(progress).toBe('内容团队启动！先初始化团队状态');
    expect(removePromotedAssistantProgressFromThinking(text, progress)).toBe(
      '接下来要调用团队初始化命令。',
    );
  });

  it('hides the thinking block when all visible thinking was promoted', () => {
    const text = '好，内容团队启动！先初始化团队状态：';
    const progress = extractAssistantProgressSummary(text);

    expect(removePromotedAssistantProgressFromThinking(text, progress)).toBeUndefined();
  });
});
