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

describe('humanizeToolError — code 优先（metadata.code 命中登记表）', () => {
  it('登记的 code 用 code 文案，不走正则分类（error 文本会被判成 quota 也压不过 code）', () => {
    const h = humanizeToolError('402 Payment Required: insufficient balance 余额不足', 'Write', zh, {
      code: 'DIRECTIVE_MEMORY_CONFIRMATION_REQUIRED',
    });
    expect(h).not.toBeNull();
    expect(h?.summary).toBe(zh.toolErrors.codes.DIRECTIVE_MEMORY_CONFIRMATION_REQUIRED.summary);
    expect(h?.detail).toBe(zh.toolErrors.codes.DIRECTIVE_MEMORY_CONFIRMATION_REQUIRED.detail);
    // code 文案不属于正则七类，不带 kind/settingsHint
    expect(h?.kind).toBeUndefined();
    expect(h?.settingsHint).toBeUndefined();
  });

  it('五个已登记 code 全部命中各自文案', () => {
    const cases: Array<[string, string]> = [
      ['DIRECTIVE_MEMORY_CONFIRMATION_REQUIRED', '全局记忆'],
      ['WORKBENCH_SCOPE_DENIED', '工作台范围'],
      ['PROJECT_SOURCE_READ_ONLY', '只读'],
      ['RUN_CONTEXT_MISMATCH', '运行上下文'],
      ['RUN_WORKSPACE_BOUNDARY', '工作区'],
    ];
    for (const [code, snippet] of cases) {
      const h = humanizeToolError('host 原文', 'Bash', zh, { code });
      expect(h?.summary).toContain(snippet);
    }
  });

  it('code 命中时不依赖 error 文本：error 为空也出人话（永不空白）', () => {
    const h = humanizeToolError('', 'Write', zh, { code: 'RUN_CONTEXT_MISMATCH' });
    expect(h?.summary).toBe(zh.toolErrors.codes.RUN_CONTEXT_MISMATCH.summary);
    const h2 = humanizeToolError(undefined, 'Write', zh, { code: 'WORKBENCH_SCOPE_DENIED' });
    expect(h2?.summary).toBe(zh.toolErrors.codes.WORKBENCH_SCOPE_DENIED.summary);
  });

  it('P1 迁移的 6 个 code 全部命中各自文案', () => {
    const cases: Array<[string, string]> = [
      ['AMEND_PUSHED', 'amend'],
      ['NO_PROJECT', 'Project'],
      ['UPDATE_FAILED', '授权写入失败'],
      ['PR_UNCOMMITTED_CHANGES', '未提交'],
    ];
    for (const [code, snippet] of cases) {
      const h = humanizeToolError('host 原文', 'Bash', zh, { code });
      expect(h?.summary).toContain(snippet);
    }
  });
});

describe('humanizeToolError — 带参 code 的 {param} 插值', () => {
  it('有参 → 填进 summary（{branch}）', () => {
    const h = humanizeToolError('host 原文', 'Bash', zh, {
      code: 'PR_ON_DEFAULT_BRANCH',
      branch: 'main',
    });
    expect(h?.summary).toBe('当前在默认分支 main，不能从这里创建 PR');
    expect(h?.summary).not.toContain('{branch}');
  });

  it('多参 → summary/detail 各自填对（{dependency}/{installHint}）', () => {
    const h = humanizeToolError('host 原文', 'Bash', zh, {
      code: 'ENV_DEPENDENCY_MISSING',
      dependency: 'Ghostscript',
      installHint: 'brew install ghostscript',
    });
    expect(h?.summary).toBe('缺少依赖 Ghostscript，无法执行');
    expect(h?.detail).toBe('请先安装：brew install ghostscript，装好后重试。');
  });

  it('缺参 → 占位符原样保留，不替成 undefined', () => {
    const h = humanizeToolError('host 原文', 'Bash', zh, { code: 'PR_ON_DEFAULT_BRANCH' });
    expect(h?.summary).toBe(zh.toolErrors.codes.PR_ON_DEFAULT_BRANCH.summary);
    expect(h?.summary).toContain('{branch}');
    expect(h?.summary).not.toContain('undefined');
  });

  it('畸形参数值（对象/数组/null）→ 占位符原样保留', () => {
    for (const bad of [{}, [], null] as unknown[]) {
      const h = humanizeToolError('host 原文', 'Bash', zh, {
        code: 'PR_ON_DEFAULT_BRANCH',
        branch: bad,
      });
      expect(h?.summary).toContain('{branch}');
      expect(h?.summary).not.toContain('undefined');
    }
  });

  it('脱敏：换行/控制字符剥离，超长截断（host 值→UI 通道不放大原文）', () => {
    const h = humanizeToolError('host 原文', 'Bash', zh, {
      code: 'PR_ON_DEFAULT_BRANCH',
      branch: 'main\nsecond-lineevil',
    });
    expect(h?.summary).toBe('当前在默认分支 main，不能从这里创建 PR');

    const long = humanizeToolError('host 原文', 'Bash', zh, {
      code: 'PR_ON_DEFAULT_BRANCH',
      branch: 'b'.repeat(200),
    });
    expect(long?.summary).toContain(`${'b'.repeat(77)}...`);
  });

  it('metadata 畸形时带参 code 不受影响（无参 code 仍出静态文案）', () => {
    const h = humanizeToolError('host 原文', 'Bash', zh, { code: 'AMEND_PUSHED', branch: 42 });
    expect(h?.summary).toBe(zh.toolErrors.codes.AMEND_PUSHED.summary);
  });
});

describe('humanizeToolError — 正则兜底（metadata 缺失/未登记时与改前逐条一致）', () => {
  // 固化改前的真实错误样本：quota、429、401、超时、网络，以及一条完全无法分类的
  const samples: Array<[string, string]> = [
    ['perplexity: HTTP 401: {"error":{"message":"You exceeded your current quota","type":"insufficient_quota"}}', 'quota'],
    ['Error: HTTP 429 Too Many Requests', 'rate_limit'],
    ['401 Unauthorized: invalid api key', 'auth'],
    ['Request timed out after 90000ms', 'timeout'],
    ['fetch failed: ECONNRESET', 'network'],
  ];

  it.each(samples)('空 metadata 时分类结果与无 metadata 完全一致：%s', (raw, kind) => {
    const withEmpty = humanizeToolError(raw, 'WebFetch', zh, {});
    const baseline = humanizeToolError(raw, 'WebFetch', zh);
    expect(withEmpty).toEqual(baseline);
    expect(withEmpty?.kind).toBe(kind);
  });

  it('未登记的 code 仍走正则分类', () => {
    const h = humanizeToolError('Error: HTTP 429 Too Many Requests', 'WebFetch', zh, { code: 'SOME_FUTURE_CODE' });
    expect(h?.kind).toBe('rate_limit');
    expect(h?.summary).toBe(zh.toolErrors.rateLimit.summary);
  });

  it('完全无法分类的错误带 metadata 也仍返回 null（调用方展示原文）', () => {
    expect(humanizeToolError('TypeError: cannot read property foo of undefined', undefined, zh, {})).toBeNull();
    expect(humanizeToolError('TypeError: cannot read property foo of undefined', undefined, zh, { code: 'UNKNOWN' })).toBeNull();
  });
});

describe('humanizeToolError — 畸形 metadata 不崩、一律退回兜底', () => {
  const malformed = [
    null,
    42,
    'not-an-object',
    { code: 123 },
    { code: null },
    { code: '' },
    { code: 'NOT_REGISTERED' },
  ].map((m) => m as unknown as Record<string, unknown> | null);

  it.each(malformed)('畸形 metadata %#：可分类错误仍走正则，不可分类仍返回 null', (meta) => {
    expect(() => humanizeToolError('Error: HTTP 429 Too Many Requests', 'WebFetch', zh, meta)).not.toThrow();
    expect(humanizeToolError('Error: HTTP 429 Too Many Requests', 'WebFetch', zh, meta)?.kind).toBe('rate_limit');
    expect(humanizeToolError('TypeError: boom', undefined, zh, meta)).toBeNull();
  });
});

describe('isEscalatedToolError — code 与正则同一套分流', () => {
  it('登记 code 不升级：即使 error 文本本身会被正则判成需介入', () => {
    const tc = makeToolCall({
      name: 'Write',
      result: {
        toolCallId: 'tc',
        success: false,
        error: '401 Unauthorized: invalid api key',
        metadata: { code: 'RUN_CONTEXT_MISMATCH' },
      },
    });
    expect(isEscalatedToolError(tc)).toBe(false);
  });

  it('登记 code 且无 error 文本时不崩、不升级', () => {
    const tc = makeToolCall({
      name: 'Write',
      result: {
        toolCallId: 'tc',
        success: false,
        metadata: { code: 'PROJECT_SOURCE_READ_ONLY' },
      },
    });
    expect(isEscalatedToolError(tc)).toBe(false);
  });

  it('未登记 code 不影响既有判定（401 仍升级）', () => {
    const tc = makeToolCall({
      name: 'WebSearch',
      result: {
        toolCallId: 'tc',
        success: false,
        error: '401 Unauthorized: invalid api key',
        metadata: { code: 'SOME_FUTURE_CODE' },
      },
    });
    expect(isEscalatedToolError(tc)).toBe(true);
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
