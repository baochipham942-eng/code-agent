import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract/tool';
import {
  deriveApiErrorBanner,
  formatToolDuration,
  getToolCapabilitySource,
  getToolPermissionView,
  getToolRecoveryHint,
  humanizeToolError,
  isAutoLoadedRetry,
  isEscalatedToolError,
  summarizeToolLoopDecision,
} from '../../../src/renderer/utils/toolExecutionPresentation';
import type { TraceTurn } from '../../../src/shared/contract/trace';

function makeTurn(
  toolCalls: Array<{ name: string; success?: boolean; result?: string; recovered?: boolean }>,
): TraceTurn {
  return {
    turnNumber: 1,
    turnId: 'turn-1',
    status: 'completed',
    startTime: 0,
    nodes: toolCalls.map((tc, i) => ({
      id: `node-${i}`,
      type: 'tool_call',
      content: '',
      timestamp: i,
      toolCall: { id: `tc-${i}`, name: tc.name, args: {}, success: tc.success, result: tc.result, recovered: tc.recovered },
    })),
  };
}

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

  it('ignores recovered failures so a recovered turn is not headlined as failed', () => {
    // 单独一条"已恢复"的失败 → 不弹「工具报错」决策
    expect(summarizeToolLoopDecision([{
      name: 'WebSearch',
      result: 'All search sources failed',
      success: false,
      recovered: true,
    }])).toBeNull();

    // 失败(已恢复) + 后续真成功 → 整体判成功，不顶失败
    expect(summarizeToolLoopDecision([
      { name: 'WebSearch', result: 'failed', success: false, recovered: true },
      { name: 'WebFetch', expectedOutcome: '抓取 changelog', result: 'ok', success: true },
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

  it('search-source quota 也带 kind/escalate（供 banner 升级）', () => {
    const humanized = humanizeToolError('perplexity: insufficient_quota, exceeded your current quota', 'WebSearch');
    expect(humanized?.kind).toBe('quota');
    expect(humanized?.escalate).toBe(true);
  });

  it('识别 HTTP 429 限流', () => {
    const h = humanizeToolError('Error: HTTP 429 Too Many Requests', 'WebFetch');
    expect(h).not.toBeNull();
    expect(h?.kind).toBe('rate_limit');
    expect(h?.summary).toMatch(/限流|频繁/);
    expect(h?.action).toBe('retry');
    expect(h?.escalate).toBe(true);
  });

  it('识别 401/403 鉴权失败（与 quota 区分：纯鉴权不含额度词）', () => {
    const h = humanizeToolError('401 Unauthorized: invalid api key', 'WebSearch');
    expect(h?.kind).toBe('auth');
    expect(h?.settingsHint).toBe(true);
    expect(h?.summary).toMatch(/鉴权|API Key|无权限|授权/);
    expect(h?.action).toBe('settings');
    expect(h?.escalate).toBe(true);
  });

  it('识别超时', () => {
    const h = humanizeToolError('Request timed out after 90000ms', 'Bash');
    expect(h?.kind).toBe('timeout');
    expect(h?.summary).toMatch(/超时/);
    expect(h?.action).toBe('retry');
  });

  it('识别 503/过载', () => {
    const h = humanizeToolError('503 Service Unavailable: model is overloaded', 'WebFetch');
    expect(h?.kind).toBe('overloaded');
    expect(h?.summary).toMatch(/过载|繁忙|稍后/);
    expect(h?.action).toBe('retry');
  });

  it('识别网络异常', () => {
    const h = humanizeToolError('fetch failed: ECONNRESET', 'WebFetch');
    expect(h?.kind).toBe('network');
    expect(h?.summary).toMatch(/网络/);
    expect(h?.action).toBe('retry');
  });

  it('识别余额不足（402/欠费）', () => {
    const h = humanizeToolError('402 Payment Required: insufficient balance 余额不足', 'image_generate');
    expect(h?.kind).toBe('quota');
    expect(h?.summary).toMatch(/余额|额度/);
    expect(h?.escalate).toBe(true);
  });

  it('returns null for unrecognized errors so raw output is preserved', () => {
    expect(humanizeToolError('TypeError: cannot read property foo of undefined')).toBeNull();
    expect(humanizeToolError('')).toBeNull();
    expect(humanizeToolError(undefined)).toBeNull();
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

describe('deriveApiErrorBanner (P0 #3 全局 banner 升级)', () => {
  it('额度/余额错误升级成 banner', () => {
    const banner = deriveApiErrorBanner([
      makeTurn([{ name: 'web_search', success: false, result: 'HTTP 402: insufficient_quota' }]),
    ]);
    expect(banner).toMatchObject({ kind: 'quota', action: 'settings' });
    expect(banner?.summary).toContain('额度');
  });

  it('429 限流升级成 banner（action=retry）', () => {
    const banner = deriveApiErrorBanner([
      makeTurn([{ name: 'web_search', success: false, result: 'Error 429: too many requests' }]),
    ]);
    expect(banner).toMatchObject({ kind: 'rate_limit', action: 'retry' });
  });

  it('已恢复(recovered)的失败不升级', () => {
    expect(
      deriveApiErrorBanner([
        makeTurn([{ name: 'web_search', success: false, result: '429 rate limit', recovered: true }]),
      ]),
    ).toBeNull();
  });

  it('瞬态错误(超时/网络)不升 banner', () => {
    expect(
      deriveApiErrorBanner([makeTurn([{ name: 'Bash', success: false, result: 'request timed out' }])]),
    ).toBeNull();
  });

  it('成功工具 / 无错误不升 banner', () => {
    expect(deriveApiErrorBanner([makeTurn([{ name: 'Read', success: true, result: 'ok' }])])).toBeNull();
    expect(deriveApiErrorBanner([])).toBeNull();
    expect(deriveApiErrorBanner(null)).toBeNull();
  });

  it('只看最后一轮：早前轮的额度错误不挂在新一轮上', () => {
    const banner = deriveApiErrorBanner([
      makeTurn([{ name: 'web_search', success: false, result: 'insufficient_quota' }]),
      makeTurn([{ name: 'Read', success: true, result: 'ok' }]),
    ]);
    expect(banner).toBeNull();
  });

  it('取最后一轮里最新一条 escalate 错误', () => {
    const banner = deriveApiErrorBanner([
      makeTurn([
        { name: 'web_search', success: false, result: 'insufficient_quota' },
        { name: 'web_search', success: false, result: '429 too many requests' },
      ]),
    ]);
    expect(banner?.kind).toBe('rate_limit');
  });
});
