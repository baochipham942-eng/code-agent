import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouteTraceChip } from '../../../src/renderer/components/features/chat/RouteTraceChip';

afterEach(() => {
  vi.useRealTimers();
});

describe('RouteTraceChip', () => {
  it('shows model strategy summary on the collapsed chip', () => {
    const html = renderToStaticMarkup(
      React.createElement(RouteTraceChip, {
        defaultExpanded: true,
        decision: {
          requestedProvider: 'moonshot',
          requestedModel: 'kimi-k2.5',
          resolvedProvider: 'zhipu',
          resolvedModel: 'glm-4.5-flash',
          reason: 'simple-task-free',
          role: null,
	          billingMode: 'payg',
	          fallbackFrom: null,
	          strategySummary: '识别为简单任务，按量计费下切到快模型降低成本和延迟。',
	          taskClass: 'simple',
          complexityScore: 0.12,
          costPolicy: 'save-cost',
          speedPolicy: 'fast-path',
          capabilityNeeds: ['code'],
          toolPolicy: 'runtime-checked',
          toolStrategy: {
            visibleToolCount: 4,
            toolNamesPreview: ['Read', 'Edit', 'mcp__github__search_code'],
            mcpToolCount: 1,
            mcpServerIds: ['github'],
            programmaticToolCalling: 'available',
            programmaticToolCount: 4,
            tokenSavings: {
              status: 'estimated',
              savedTokens: 128,
              detail: '估算值：工具规格若写入普通消息上下文，约占 128 tokens；真实账单以 provider usage 为准。',
              measurement: {
                savingsSource: 'tool-spec-local-estimate',
                usageSource: 'model-response-usage',
                providerReportedSavings: false,
              },
              basis: {
                source: 'tool-spec-local-estimate',
                toolCount: 4,
                previewToolCount: 3,
                fields: ['name', 'description', 'inputSchema'],
              },
              providerUsage: {
                source: 'model-response-usage',
                inputTokens: 1200,
                outputTokens: 80,
                totalTokens: 1280,
              },
            },
          },
        },
      }),
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('简单任务');
    expect(html).toContain('kimi-k2.5 -&gt; glm-4.5-flash');
    expect(html).toContain('识别为简单任务，按量计费下切到快模型降低成本和延迟。');
	    expect(html).toContain('按量付费');
    expect(html).toContain('0.12 · 规则估计');
    expect(html).toContain('不代表模型质量评分');
	    expect(html).toContain('MCP');
    expect(html).toContain('github');
    expect(html).toContain('本地估算少占 128 tokens 上下文');
    expect(html).toContain('本地工具规格估算');
    expect(html).toContain('字段 name/description/inputSchema');
    expect(html).toContain('预览 3 个');
    expect(html).toContain('provider usage');
    expect(html).toContain('输入 1200 / 输出 80 tokens');
    expect(html).toContain('合计 1280');
    expect(html).toContain('上下文少占=本地估算');
    expect(html).toContain('用量=provider usage');
    expect(html).toContain('无 provider-reported saved tokens');
    expect(html).toContain('saved tokens 是工具规格少占上下文的本地估算');
    expect(html).toContain('不等同 provider 账单节省');
    expect(html).toContain('真实账单以 provider usage 为准');
	  });

	  it('shows provider-reported saved tokens without the local-estimate boundary', () => {
	    const html = renderToStaticMarkup(
	      React.createElement(RouteTraceChip, {
	        defaultExpanded: true,
	        decision: {
	          requestedProvider: 'moonshot',
	          requestedModel: 'kimi-k2.5',
	          resolvedProvider: 'moonshot',
	          resolvedModel: 'kimi-k2.5',
	          reason: 'user-selected',
	          role: null,
	          billingMode: 'payg',
	          fallbackFrom: null,
	          strategySummary: '使用用户选定的主任务模型，未做自动切换。',
	          taskClass: 'multi-tool',
	          costPolicy: 'neutral',
	          speedPolicy: 'normal',
	          toolPolicy: 'runtime-checked',
	          toolStrategy: {
	            visibleToolCount: 2,
	            toolNamesPreview: ['Read', 'Edit'],
	            mcpToolCount: 0,
	            programmaticToolCalling: 'available',
	            programmaticToolCount: 2,
	            tokenSavings: {
	              status: 'provider-reported',
	              savedTokens: 42,
	              detail: 'provider 已回传 programmatic tool saved tokens：42 tokens；本轮 provider usage 已回传：输入 500 / 输出 50 tokens。',
	              measurement: {
	                savingsSource: 'provider-reported',
	                usageSource: 'model-response-usage',
	                providerReportedSavings: true,
	              },
	              providerReport: {
	                source: 'provider-reported',
	                savedTokens: 42,
	              },
	              providerUsage: {
	                source: 'model-response-usage',
	                inputTokens: 500,
	                outputTokens: 50,
	                totalTokens: 550,
	              },
	            },
	          },
	        },
	      }),
	    );

	    expect(html).toContain('provider 回传节省 42 tokens');
	    expect(html).toContain('provider-reported saved tokens');
	    expect(html).toContain('节省=provider 回传');
	    expect(html).toContain('provider 已回传 saved tokens');
	    expect(html).toContain('输入 500 / 输出 50 tokens');
	    expect(html).not.toContain('不等同 provider 账单节省');
	  });

	  it('shows provider identity for custom relay decisions in expanded details', () => {
	    const html = renderToStaticMarkup(
	      React.createElement(RouteTraceChip, {
	        defaultExpanded: true,
	        decision: {
	          requestedProvider: 'custom-commonstack',
	          requestedModel: 'anthropic/claude-opus-4-8',
	          resolvedProvider: 'custom-commonstack',
	          resolvedModel: 'anthropic/claude-opus-4-8',
	          reason: 'user-selected',
	          role: null,
	          billingMode: 'unknown',
	          fallbackFrom: null,
	          strategySummary: '使用用户选定的主任务模型，未做自动切换。',
	          providerIdentity: {
	            provider: 'custom-commonstack',
	            displayName: 'CommonStack',
	            sourceLabel: 'CommonStack',
	            protocol: 'openai',
	            transportLabel: 'OpenAI-compatible',
	            endpoint: 'https://commonstack.example/v1',
	          },
	          taskClass: 'coding',
	          costPolicy: 'user-locked',
	          speedPolicy: 'normal',
	        },
	      }),
	    );

	    expect(html).toContain('custom-commonstack/anthropic/claude-opus-4-8');
	    expect(html).toContain('来源 CommonStack');
	    expect(html).toContain('协议 OpenAI-compatible');
	    expect(html).toContain('endpoint https://commonstack.example/v1');
	  });

	  it('shows conservative billing gate decisions for plan and unknown billing', () => {
    const planHtml = renderToStaticMarkup(
      React.createElement(RouteTraceChip, {
        defaultExpanded: true,
        decision: {
          requestedProvider: 'claude',
          requestedModel: 'sonnet-4',
          resolvedProvider: 'claude',
          resolvedModel: 'sonnet-4',
          reason: 'billing-gate-skip',
          role: null,
          billingMode: 'plan',
          fallbackFrom: null,
          strategySummary: '识别为简单任务，但当前计费方式切换快模型没有实际节省，沿用主任务模型。',
          taskClass: 'simple',
          complexityScore: 0.08,
          costPolicy: 'plan-no-savings',
          speedPolicy: 'normal',
        },
      }),
    );
    const unknownHtml = renderToStaticMarkup(
      React.createElement(RouteTraceChip, {
        defaultExpanded: true,
        decision: {
          requestedProvider: 'custom',
          requestedModel: 'local-heavy',
          resolvedProvider: 'custom',
          resolvedModel: 'local-heavy',
          reason: 'billing-gate-skip',
          role: null,
          billingMode: 'unknown',
          fallbackFrom: null,
          strategySummary: '识别为简单任务，但 provider 计费方式未知，保守沿用主任务模型。',
          taskClass: 'simple',
          complexityScore: 0.14,
          costPolicy: 'unknown-conservative',
          speedPolicy: 'normal',
        },
      }),
    );

    expect(planHtml).toContain('计费跳过');
    expect(planHtml).toContain('套餐/订阅');
    expect(planHtml).toContain('套餐内不切换');
    expect(planHtml).toContain('识别为简单任务，但当前计费方式切换快模型没有实际节省，沿用主任务模型。');
    expect(unknownHtml).toContain('计费跳过');
    expect(unknownHtml).toContain('未知计费');
    expect(unknownHtml).toContain('计费未知保守');
    expect(unknownHtml).toContain('识别为简单任务，但 provider 计费方式未知，保守沿用主任务模型。');
  });

  it('shows external engine reliability in the expanded strategy details', () => {
    vi.useFakeTimers();
    vi.setSystemTime(180_000);
    const html = renderToStaticMarkup(
      React.createElement(RouteTraceChip, {
        defaultExpanded: true,
        decision: {
          requestedProvider: 'claude_code',
          requestedModel: 'sonnet',
          resolvedProvider: 'claude_code',
          resolvedModel: 'sonnet',
          reason: 'user-selected',
          role: null,
          billingMode: 'unknown',
          fallbackFrom: null,
          strategySummary: 'Claude Code 使用 sonnet 执行本轮任务；CLI、登录态、quota、stream 和工具链路会影响输出可靠性。',
          taskClass: 'coding',
          costPolicy: 'user-locked',
          speedPolicy: 'normal',
          toolPolicy: 'runtime-checked',
          externalEngine: {
            kind: 'claude_code',
            label: 'Claude Code',
            model: 'sonnet',
            installState: 'installed',
            runtimeState: 'ready',
            executable: true,
            capabilities: ['execute', 'stream_events'],
            version: '2.1.177',
            reliability: {
              cliStatus: 'available',
              authState: 'not_checked',
              quotaState: 'not_checked',
              streamingMode: 'stream_json',
              toolSupport: 'read_only_cli_tools',
              transcriptMode: 'clean_stream_json',
              partialMessages: true,
              mcpBridge: false,
            },
            failure: {
              category: 'auth',
              reason: 'auth_failed',
              message: 'Failed to authenticate',
              suggestion: 'Claude Code 认证失败。请完成 Claude CLI 登录或检查订阅/API 凭据后重试。',
              retryable: false,
              occurredAt: 60_000,
              statusCode: 401,
              exitCode: 1,
              reliability: { authState: 'needs_login' },
            },
          },
        },
      }),
    );

    expect(html).toContain('Claude Code');
    expect(html).toContain('登录未检测');
    expect(html).toContain('quota 未检测');
    expect(html).toContain('stream-json');
    expect(html).toContain('只读 CLI 工具');
    expect(html).toContain('干净 stream-json transcript');
    expect(html).toContain('auth · auth_failed · 2 分钟前失败 · HTTP 401 · exit 1 · 需处理');
    expect(html).toContain('Claude Code 认证失败');
    expect(html).toContain('2.1.177');
  });

  it('shows provider speed risk when health snapshot is degraded', () => {
    vi.useFakeTimers();
    vi.setSystemTime(120_201);
    const html = renderToStaticMarkup(
      React.createElement(RouteTraceChip, {
        defaultExpanded: true,
        decision: {
          requestedProvider: 'moonshot',
          requestedModel: 'kimi-k2.5',
          resolvedProvider: 'moonshot',
          resolvedModel: 'kimi-k2.5',
          reason: 'user-selected',
          role: null,
          billingMode: 'payg',
          fallbackFrom: null,
          strategySummary: '使用用户选定的主任务模型，未做自动切换。',
          taskClass: 'coding',
          costPolicy: 'user-locked',
          speedPolicy: 'provider-degraded',
          providerHealthSnapshot: {
            provider: 'moonshot',
            status: 'degraded',
            sampledAt: 201,
            latencyP50: 1900,
            latencyP95: 5200,
            errorRate: 0.42,
            consecutiveErrors: 3,
          },
        },
      }),
    );

    expect(html).toContain('provider 状态风险');
    expect(html).toContain('moonshot · 最近窗口 不稳定');
    expect(html).toContain('采样 2 分钟前');
    expect(html).toContain('p50 1900ms');
    expect(html).toContain('err 42%');
    expect(html).toContain('非实时 SLA');
  });

  it('explains when the selected execution model cannot use tools', () => {
    const html = renderToStaticMarkup(
      React.createElement(RouteTraceChip, {
        defaultExpanded: true,
        decision: {
          requestedProvider: 'mock',
          requestedModel: 'text-only',
          resolvedProvider: 'zhipu',
          resolvedModel: 'glm-4.5v',
          reason: 'capability-vision',
          role: null,
          billingMode: 'payg',
          fallbackFrom: null,
          strategySummary: '原模型 mock/text-only 缺少 vision 能力，切到 zhipu/glm-4.5v 完成当前任务。',
          taskClass: 'vision',
          costPolicy: 'neutral',
          speedPolicy: 'normal',
          toolPolicy: 'disabled-by-model',
          toolStrategy: {
            visibleToolCount: 0,
            mcpToolCount: 0,
            programmaticToolCalling: 'unavailable',
            programmaticToolCount: 0,
            tokenSavings: {
              status: 'not-measured',
              detail: '本轮没有可见程序化工具，token saved 不计量。',
              measurement: {
                savingsSource: 'not-measured',
                usageSource: 'unavailable',
                providerReportedSavings: false,
              },
            },
          },
          capabilityNeeds: ['vision'],
        },
      }),
    );

    expect(html).toContain('视觉能力');
    expect(html).toContain('模型不支持');
    expect(html).toContain('当前执行模型不支持工具调用');
    expect(html).toContain('本轮按纯文本执行');
    expect(html).toContain('MCP / 程序化工具不会下发');
    expect(html).toContain('不可用 · 0 个程序化工具');
    expect(html).toContain('token saved 未计量');
    expect(html).toContain('节省=未计量');
  });
});
