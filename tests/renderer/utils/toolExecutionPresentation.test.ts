import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract/tool';
import {
  formatToolDuration,
  getToolCapabilitySource,
  getToolPermissionView,
  getToolRecoveryHint,
  humanizeToolError,
  isAutoLoadedRetry,
  isEscalatedToolError,
} from '../../../src/renderer/utils/toolExecutionPresentation';
import { zh } from '../../../src/renderer/i18n/zh';

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
    expect(getToolRecoveryHint(makeToolCall({ name: 'Bash' }), 'pending', zh)).toBe('等待结果');
    expect(getToolRecoveryHint(makeToolCall({ name: 'Bash' }), 'interrupted', zh)).toBe('可重新运行');
    expect(getToolRecoveryHint(makeToolCall({
      name: 'Bash',
      expectedOutcome: '跑完验证',
      result: { toolCallId: 'tool-1', success: false, error: 'failed' },
    }), 'error', zh)).toBe('可重试：跑完验证');
  });

  it('detects auto-loaded retry results as benign', () => {
    expect(isAutoLoadedRetry({ autoLoaded: true })).toBe(true);
    expect(isAutoLoadedRetry({ autoLoadedTools: 'WebFetch' })).toBe(true);
    expect(isAutoLoadedRetry({})).toBe(false);
    expect(isAutoLoadedRetry(null)).toBe(false);
    expect(isAutoLoadedRetry(undefined)).toBe(false);
  });

  it('humanizes search-source quota errors with a settings hint', () => {
    const raw = [
      'All search sources failed:',
      'perplexity: HTTP 401: {"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":401}}',
      'exa: HTTP 402: {"error":"You have exceeded your credits limit","tag":"NO_MORE_CREDITS"}',
      'tavily: HTTP 432: {"detail":{"error":"This request exceeds your plan\'s set usage limit"}}',
    ].join('\n');
    const humanized = humanizeToolError(raw, 'WebSearch', zh);
    expect(humanized).not.toBeNull();
    expect(humanized?.settingsHint).toBe(true);
    expect(humanized?.summary).toContain('额度不足');
    // 识别出涉及的具体源
    expect(humanized?.summary).toContain('perplexity');
    expect(humanized?.summary).toContain('tavily');
  });

  it('search-source quota 也带 kind/escalate（供 banner 升级）', () => {
    const humanized = humanizeToolError('perplexity: insufficient_quota, exceeded your current quota', 'WebSearch', zh);
    expect(humanized?.kind).toBe('quota');
    expect(humanized?.escalate).toBe(true);
  });

  it('识别 HTTP 429 限流', () => {
    const h = humanizeToolError('Error: HTTP 429 Too Many Requests', 'WebFetch', zh);
    expect(h).not.toBeNull();
    expect(h?.kind).toBe('rate_limit');
    expect(h?.summary).toMatch(/限流|频繁/);
    expect(h?.action).toBe('retry');
    expect(h?.escalate).toBe(true);
  });

  it('识别 401/403 鉴权失败（与 quota 区分：纯鉴权不含额度词）', () => {
    const h = humanizeToolError('401 Unauthorized: invalid api key', 'WebSearch', zh);
    expect(h?.kind).toBe('auth');
    expect(h?.settingsHint).toBe(true);
    expect(h?.summary).toMatch(/鉴权|API Key|无权限|授权/);
    expect(h?.action).toBe('settings');
    expect(h?.escalate).toBe(true);
  });

  it('识别超时', () => {
    const h = humanizeToolError('Request timed out after 90000ms', 'Bash', zh);
    expect(h?.kind).toBe('timeout');
    expect(h?.summary).toMatch(/超时/);
    expect(h?.action).toBe('retry');
  });

  it('识别 503/过载', () => {
    const h = humanizeToolError('503 Service Unavailable: model is overloaded', 'WebFetch', zh);
    expect(h?.kind).toBe('overloaded');
    expect(h?.summary).toMatch(/过载|繁忙|稍后/);
    expect(h?.action).toBe('retry');
  });

  it('识别网络异常', () => {
    const h = humanizeToolError('fetch failed: ECONNRESET', 'WebFetch', zh);
    expect(h?.kind).toBe('network');
    expect(h?.summary).toMatch(/网络/);
    expect(h?.action).toBe('retry');
  });

  it('识别余额不足（402/欠费）', () => {
    const h = humanizeToolError('402 Payment Required: insufficient balance 余额不足', 'image_generate', zh);
    expect(h?.kind).toBe('quota');
    expect(h?.summary).toMatch(/余额|额度/);
    expect(h?.escalate).toBe(true);
  });

  it('returns null for unrecognized errors so raw output is preserved', () => {
    expect(humanizeToolError('TypeError: cannot read property foo of undefined', undefined, zh)).toBeNull();
    expect(humanizeToolError('', undefined, zh)).toBeNull();
    expect(humanizeToolError(undefined, undefined, zh)).toBeNull();
  });
});

describe('isEscalatedToolError（P0 失败去噪：区分需用户介入 vs agent 探索性失败）', () => {
  it('鉴权失效需要用户介入，应升级', () => {
    const tc = makeToolCall({
      name: 'WebSearch',
      result: { toolCallId: 'tc', success: false, error: '401 Unauthorized: invalid api key' },
    });
    expect(isEscalatedToolError(tc)).toBe(true);
  });

  it('额度/余额耗尽需要用户介入，应升级', () => {
    const tc = makeToolCall({
      name: 'image_generate',
      result: { toolCallId: 'tc', success: false, error: '402 Payment Required: insufficient balance 余额不足' },
    });
    expect(isEscalatedToolError(tc)).toBe(true);
  });

  it('Playwright 未安装等未分类错误是探索性失败，不升级', () => {
    const tc = makeToolCall({
      name: 'browser_action',
      result: { toolCallId: 'tc', success: false, error: 'Executable doesn\'t exist, please run playwright install' },
    });
    expect(isEscalatedToolError(tc)).toBe(false);
  });

  it('Bash 非零退出码等未分类错误是探索性失败，不升级', () => {
    const tc = makeToolCall({
      name: 'Bash',
      result: { toolCallId: 'tc', success: false, error: 'command failed with exit code 1' },
    });
    expect(isEscalatedToolError(tc)).toBe(false);
  });

  it('超时/网络抖动是瞬态可自动重试的失败，不升级', () => {
    const tc = makeToolCall({
      name: 'WebFetch',
      result: { toolCallId: 'tc', success: false, error: 'Request timed out after 90000ms' },
    });
    expect(isEscalatedToolError(tc)).toBe(false);
  });

  it('成功的工具调用不算失败', () => {
    const tc = makeToolCall({
      name: 'Bash',
      result: { toolCallId: 'tc', success: true, output: 'ok' },
    });
    expect(isEscalatedToolError(tc)).toBe(false);
  });

  it('没有 result（尚未执行）不算失败', () => {
    const tc = makeToolCall({ name: 'Bash' });
    expect(isEscalatedToolError(tc)).toBe(false);
  });
});
