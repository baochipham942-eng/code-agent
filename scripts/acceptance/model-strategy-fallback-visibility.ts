#!/usr/bin/env npx tsx

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { pathToFileURL } from 'url';
import {
  finishWithError,
  hasFlag,
  parseArgs,
  printJson,
  printKeyValue,
} from './_helpers.ts';
import { FallbackBanner } from '../../src/renderer/components/features/chat/MessageBubble/FallbackBanner.tsx';
import { encodeModelFallbackNotice } from '../../src/renderer/components/features/chat/fallbackNotice.ts';
import { formatProviderFallbackToast } from '../../src/renderer/components/ProviderStatusNotice.tsx';
import type { ProviderFallbackEvent } from '../../src/shared/ipc';
import { zh } from '../../src/renderer/i18n/zh';

export interface ModelStrategyFallbackVisibilityResult {
  ok: boolean;
  status: 'passed' | 'failed';
  checks: Record<string, boolean>;
  failedChecks: string[];
  evidence: string[];
}

function includesAll(text: string, values: string[]): boolean {
  return values.every((value) => text.includes(value));
}

export function buildModelStrategyFallbackVisibilityResult(): ModelStrategyFallbackVisibilityResult {
  const capabilityHtml = renderToStaticMarkup(React.createElement(FallbackBanner, {
    content: encodeModelFallbackNotice({
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
          status: 'tried',
          reason: 'missing_capability',
          category: 'vision',
          detail: '需要 vision 能力',
        },
        {
          provider: 'zhipu',
          model: 'glm-4.5v',
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
    }),
  }));

  const exhaustedHtml = renderToStaticMarkup(React.createElement(FallbackBanner, {
    content: encodeModelFallbackNotice({
      reason: 'Moonshot API error: 503 service unavailable',
      category: 'provider_unavailable',
      strategy: 'adaptive-provider-fallback',
      from: 'moonshot/kimi-k2.5',
      to: '未切换',
      tried: [
        {
          provider: 'moonshot',
          model: 'kimi-k2.5',
          status: 'tried',
          reason: 'primary_failed',
          category: 'provider_unavailable',
        },
        {
          provider: 'deepseek',
          model: 'deepseek-v4-flash',
          status: 'exhausted',
          reason: 'fallback_chain_exhausted',
          category: 'provider_unavailable',
        },
      ],
    }),
  }));

  const providerToast = formatProviderFallbackToast({
    from: { provider: 'moonshot', model: 'kimi-k2.5' },
    to: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    reason: 'Moonshot API error: 503 service unavailable',
    category: 'provider_unavailable',
    strategy: 'adaptive-provider-fallback',
  } satisfies ProviderFallbackEvent, zh);

  const mainTaskToast = formatProviderFallbackToast({
    from: { provider: 'zhipu', model: 'glm-4.7-flash' },
    to: { provider: 'moonshot', model: 'kimi-k2.5' },
    reason: 'Zhipu API error: 429 rate limit exceeded',
    category: 'rate_limit',
    strategy: 'adaptive-main-task-recovery',
  } satisfies ProviderFallbackEvent, zh);

  const checks: Record<string, boolean> = {
    bannerShowsCapabilityStrategy: capabilityHtml.includes('能力自动切换'),
    bannerShowsFromToProviderIdentity: includesAll(capabilityHtml, [
      '原 来源 Mock Relay',
      '现 名称 Zhipu Relay',
      '协议 OpenAI-compatible',
      'endpoint https://mock.example/v1',
      'endpoint https://relay.example.com/zhipu/v1',
    ]),
    bannerShowsTraceGroups: includesAll(capabilityHtml, [
      '已尝试',
      '已跳过',
      '已选用',
      'mock/text-only',
      'openai/gpt-5.4-mini',
      'zhipu/glm-4.5v',
    ]),
    bannerShowsToolPolicyDisabled: includesAll(capabilityHtml, [
      '工具已关闭',
      '6 → 0',
      'Read, Edit, Write, Append +2',
      'disabled: Read, Edit, Write, Append, Bash, Task',
    ]),
    bannerShowsExhaustedProviderFallback: includesAll(exhaustedHtml, [
      '自动策略恢复',
      '已耗尽',
      'deepseek/deepseek-v4-flash',
      '未切换',
    ]),
    providerToastUsesStrategyMode: providerToast === '自动策略恢复：moonshot/kimi-k2.5 服务不可用，已切换到 deepseek/deepseek-v4-flash 继续任务',
    providerToastShowsMainTaskRecovery: mainTaskToast === '回到主任务模型：zhipu/glm-4.7-flash 触发限流，已回到 moonshot/kimi-k2.5 继续任务',
  };
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);

  return {
    ok: failedChecks.length === 0,
    status: failedChecks.length === 0 ? 'passed' : 'failed',
    checks,
    failedChecks,
    evidence: [
      'FallbackBanner renders strategy label, provider identity, trace groups, exhausted chain, and disabled tool policy',
      'ProviderStatusNotice uses the same strategy labels for provider fallback and main-task recovery toasts',
    ],
  };
}

export async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const json = hasFlag(parsed, 'json');
  const result = buildModelStrategyFallbackVisibilityResult();

  if (json) {
    printJson(result);
  } else {
    printKeyValue('Model strategy fallback visibility', [
      ['status', result.status],
      ['failedChecks', result.failedChecks.join(', ') || null],
    ]);
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => finishWithError(error));
}
