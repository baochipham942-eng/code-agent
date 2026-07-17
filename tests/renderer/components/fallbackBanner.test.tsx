import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FallbackBanner } from '../../../src/renderer/components/features/chat/MessageBubble/FallbackBanner';
import { encodeModelFallbackNotice } from '../../../src/renderer/components/features/chat/fallbackNotice';

describe('FallbackBanner', () => {
	  it('renders tried, skipped, selected trace steps and disabled tool policy when expanded', () => {
	    const html = renderToStaticMarkup(
	      <FallbackBanner
	        defaultExpanded
	        content={encodeModelFallbackNotice({
	          reason: 'vision',
	          category: 'capability',
	          strategy: 'adaptive-capability-fallback',
	          from: 'mock/text-only',
	          to: 'zhipu/glm-4.5v',
	          fromIdentity: {
	            provider: 'mock',
	            sourceLabel: 'Mock Relay',
	            protocol: 'openai',
	            transportLabel: 'OpenAI-compatible',
	            endpoint: 'https://mock.example/v1',
	          },
	          toIdentity: {
	            provider: 'zhipu',
	            displayName: 'Zhipu Relay',
	            protocol: 'openai',
	            transportLabel: 'OpenAI-compatible',
	            endpoint: 'https://relay.example.com/zhipu/v1',
	          },
	          tried: [
	            {
	              provider: 'mock',
	              model: 'text-only',
	              providerIdentity: {
	                provider: 'mock',
	                sourceLabel: 'Mock Relay',
	                protocol: 'openai',
	                transportLabel: 'OpenAI-compatible',
	                endpoint: 'https://mock.example/v1',
	              },
	              status: 'tried',
	              reason: 'missing_capability',
	              category: 'vision',
	              detail: '需要 vision 能力',
	            },
	            {
	              provider: 'zhipu',
	              model: 'glm-4.5v',
	              providerIdentity: {
	                provider: 'zhipu',
	                displayName: 'Zhipu Relay',
	                protocol: 'openai',
	                transportLabel: 'OpenAI-compatible',
	                endpoint: 'https://relay.example.com/zhipu/v1',
	              },
	              status: 'selected',
	              reason: 'capability_fallback_selected',
	              category: 'vision',
	              detail: '具备 vision 能力',
	            },
	          ],
	          skipped: [
	            {
	              provider: 'openai',
	              model: 'gpt-5.4-mini',
	              status: 'skipped',
	              reason: 'missing_api_key',
	              category: 'vision',
	            },
	          ],
	          toolPolicy: {
	            status: 'disabled',
	            reason: 'fallback_model_without_tool_support',
	            originalToolCount: 6,
	            effectiveToolCount: 0,
	            disabledToolNames: ['Read', 'Edit', 'Write', 'Append', 'Bash', 'Task'],
	            detail: 'Fallback 模型 zhipu/glm-4.5v 不支持工具调用，本轮改为纯文本回复。',
	          },
	        })}
	      />,
	    );

    expect(html).toContain('模型已降级');
	    expect(html).toContain('能力自动切换');
	    expect(html).toContain('mock/text-only');
	    expect(html).toContain('zhipu/glm-4.5v');
	    expect(html).toContain('原 来源 Mock Relay');
	    expect(html).toContain('现 名称 Zhipu Relay');
	    expect(html).toContain('协议 OpenAI-compatible');
	    expect(html).toContain('endpoint https://mock.example/v1');
	    expect(html).toContain('endpoint https://relay.example.com/zhipu/v1');
	    expect(html).toContain('vision');
    expect(html).toContain('已尝试');
    expect(html).toContain('已跳过');
    expect(html).toContain('已选用');
    expect(html).toContain('openai/gpt-5.4-mini');
    expect(html).toContain('工具已关闭');
    expect(html).toContain('6 → 0');
    expect(html).toContain('Read, Edit, Write, Append +2');
    expect(html).toContain('disabled: Read, Edit, Write, Append, Bash, Task');
  });

  it('renders exhausted fallback traces when expanded', () => {
    const html = renderToStaticMarkup(
      <FallbackBanner
        defaultExpanded
        content={encodeModelFallbackNotice({
          reason: 'Moonshot API error: 503 service unavailable',
          category: 'provider_unavailable',
          strategy: 'adaptive-provider-fallback',
          from: 'zhipu/glm-4.7-flash',
          to: '未切换',
          tried: [
            {
              provider: 'zhipu',
              model: 'glm-4.7-flash',
              status: 'tried',
              reason: 'primary_failed',
              category: 'provider_unavailable',
            },
            {
              provider: 'moonshot',
              model: 'kimi-k2.5',
              status: 'exhausted',
              reason: 'fallback_chain_exhausted',
              category: 'provider_unavailable',
            },
          ],
        })}
      />,
    );

    expect(html).toContain('已耗尽');
    expect(html).toContain('自动策略恢复');
    expect(html).toContain('moonshot/kimi-k2.5');
    expect(html).toContain('未切换');
  });

  it('renders nothing for malformed fallback notice content', () => {
    expect(renderToStaticMarkup(<FallbackBanner content="not a fallback notice" />)).toBe('');
  });

  // 折叠是降级不是删除：默认态只留一行摘要（模型已降级 + from->to + reason），
  // strategy pill/identity/trace 分组/工具策略这些工程细节都收进展开态。
  it('collapses to a one-line summary by default; engineering detail stays reachable via expand', () => {
    const html = renderToStaticMarkup(
      <FallbackBanner
        content={encodeModelFallbackNotice({
          reason: 'vision',
          category: 'capability',
          strategy: 'adaptive-capability-fallback',
          from: 'mock/text-only',
          to: 'zhipu/glm-4.5v',
          fromIdentity: {
            provider: 'mock',
            sourceLabel: 'Mock Relay',
            protocol: 'openai',
          },
          tried: [
            {
              provider: 'mock',
              model: 'text-only',
              status: 'tried',
              reason: 'missing_capability',
              category: 'vision',
            },
          ],
          toolPolicy: {
            status: 'disabled',
            reason: 'fallback_model_without_tool_support',
            originalToolCount: 6,
            effectiveToolCount: 0,
            disabledToolNames: ['Read'],
          },
        })}
      />,
    );

    expect(html).toContain('模型已降级');
    expect(html).toContain('mock/text-only');
    expect(html).toContain('zhipu/glm-4.5v');
    expect(html).toContain('aria-expanded="false"');
    // 展开态才有的工程细节，默认不该出现
    expect(html).not.toContain('能力自动切换');
    expect(html).not.toContain('Mock Relay');
    expect(html).not.toContain('已尝试');
    expect(html).not.toContain('工具已关闭');
  });
});
