import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract/tool';
import {
  formatToolDuration,
  getToolCapabilitySource,
  getToolPermissionView,
  getToolRecoveryHint,
  humanizeToolError,
  isAutoLoadedRetry,
  summarizeToolLoopDecision,
} from '../../../src/renderer/utils/toolExecutionPresentation';

function makeToolCall(overrides: Partial<ToolCall> & Pick<ToolCall, 'name'>): ToolCall {
  return {
    id: 'tool-1',
    arguments: {},
    ...overrides,
  };
}

describe('toolExecutionPresentation', () => {
  it('classifies tool source for builtin, mcp, computer, and memory tools', () => {
    expect(getToolCapabilitySource('Read')).toBe('builtin');
    expect(getToolCapabilitySource('mcp__github__get_issue')).toBe('mcp');
    expect(getToolCapabilitySource('computer_use')).toBe('computer');
    expect(getToolCapabilitySource('memory_write')).toBe('memory');
  });

  it('classifies permission level for common tool families', () => {
    expect(getToolPermissionView('Read')).toBe('read');
    expect(getToolPermissionView('Write')).toBe('write');
    expect(getToolPermissionView('Bash')).toBe('shell');
    expect(getToolPermissionView('WebFetch')).toBe('network');
    expect(getToolPermissionView('computer_use')).toBe('desktop');
  });

  it('formats durations consistently for meta rows', () => {
    expect(formatToolDuration(420)).toBe('420ms');
    expect(formatToolDuration(1250)).toBe('1.3s');
    expect(formatToolDuration(12000)).toBe('12s');
    expect(formatToolDuration(65000)).toBe('1m 5s');
  });

  it('returns recovery hint based on tool status', () => {
    expect(getToolRecoveryHint(makeToolCall({ name: 'Bash' }), 'pending')).toBe('等待结果');
    expect(getToolRecoveryHint(makeToolCall({ name: 'Bash' }), 'interrupted')).toBe('可重新运行');
    expect(getToolRecoveryHint(makeToolCall({
      name: 'Bash',
      expectedOutcome: '跑完验证',
      result: { toolCallId: 'tool-1', success: false, error: 'failed' },
    }), 'error')).toBe('可重试：跑完验证');
  });

  it('summarizes loop decision for pending, failed, and completed tools', () => {
    expect(summarizeToolLoopDecision([{
      name: 'Read',
      shortDescription: '读取配置',
    }])).toMatchObject({
      action: '等待工具返回',
      tone: 'neutral',
    });

    expect(summarizeToolLoopDecision([{
      name: 'Bash',
      shortDescription: '运行测试',
      result: 'failed',
      success: false,
    }])?.expectedNextAction).toBe('可以重试，或换个工具试试');

    expect(summarizeToolLoopDecision([{
      name: 'Read',
      expectedOutcome: '确认入口',
      result: 'ok',
      success: true,
    }])).toMatchObject({
      action: '工具结果已返回',
      reason: '确认入口',
      tone: 'success',
    });
  });

  it('detects auto-loaded retry results as benign', () => {
    expect(isAutoLoadedRetry({ autoLoaded: true })).toBe(true);
    expect(isAutoLoadedRetry({ autoLoadedTools: 'WebFetch' })).toBe(true);
    expect(isAutoLoadedRetry({})).toBe(false);
    expect(isAutoLoadedRetry(null)).toBe(false);
    expect(isAutoLoadedRetry(undefined)).toBe(false);
  });

  it('does not raise a 暂停恢复 decision for auto-loaded retry pseudo-failures', () => {
    // 仅有一条 auto-load 伪失败 → 不应弹任何决策 chip（被当良性内部状态忽略）
    expect(summarizeToolLoopDecision([{
      name: 'WebFetch',
      result: 'Tool WebFetch was not loaded yet and has now been auto-loaded.',
      success: false,
      metadata: { autoLoadedTools: 'WebFetch', autoLoaded: true },
    }])).toBeNull();

    // auto-load 伪失败 + 真成功混在一起 → 只看真成功，不再判为失败
    expect(summarizeToolLoopDecision([
      {
        name: 'WebFetch',
        result: 'auto-loaded',
        success: false,
        metadata: { autoLoaded: true },
      },
      {
        name: 'WebFetch',
        expectedOutcome: '抓取 changelog',
        result: 'ok',
        success: true,
      },
    ])).toMatchObject({ tone: 'success' });
  });

  it('humanizes search-source quota errors with a settings hint', () => {
    const raw = [
      'All search sources failed:',
      'perplexity: HTTP 401: {"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":401}}',
      'exa: HTTP 402: {"error":"You have exceeded your credits limit","tag":"NO_MORE_CREDITS"}',
      'tavily: HTTP 432: {"detail":{"error":"This request exceeds your plan\'s set usage limit"}}',
    ].join('\n');
    const humanized = humanizeToolError(raw, 'WebSearch');
    expect(humanized).not.toBeNull();
    expect(humanized?.settingsHint).toBe(true);
    expect(humanized?.summary).toContain('额度不足');
    // 识别出涉及的具体源
    expect(humanized?.summary).toContain('perplexity');
    expect(humanized?.summary).toContain('tavily');
  });

  it('returns null for unrecognized errors so raw output is preserved', () => {
    expect(humanizeToolError('TypeError: cannot read property foo of undefined')).toBeNull();
    expect(humanizeToolError('')).toBeNull();
    expect(humanizeToolError(undefined)).toBeNull();
  });
});
