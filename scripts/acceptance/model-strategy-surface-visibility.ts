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
import { RouteTraceChip } from '../../src/renderer/components/features/chat/RouteTraceChip.tsx';
import {
  buildProviderBillingSummary,
  buildProviderHealthSummary,
  formatNativeModelSwitcherTooltip,
  ProviderBillingBadge,
  ProviderHealthBadge,
  ProviderSourceBadge,
  ProviderTransportBadge,
} from '../../src/renderer/components/StatusBar/modelSwitcherHelpers.tsx';

export interface ModelStrategySurfaceVisibilityResult {
  ok: boolean;
  status: 'passed' | 'failed';
  checks: Record<string, boolean>;
  failedChecks: string[];
  evidence: string[];
}

function includesAll(text: string, values: string[]): boolean {
  return values.every((value) => text.includes(value));
}

function renderDecision(decision: React.ComponentProps<typeof RouteTraceChip>['decision']): string {
  return renderToStaticMarkup(React.createElement(RouteTraceChip, {
    defaultExpanded: true,
    decision,
  }));
}

export function buildModelStrategySurfaceVisibilityResult(): ModelStrategySurfaceVisibilityResult {
  const paygHtml = renderDecision({
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
  });

  const planHtml = renderDecision({
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
  });

  const unknownHtml = renderDecision({
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
  });

  const identityHtml = renderDecision({
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
  });

  const billingBadgeHtml = renderToStaticMarkup(React.createElement(ProviderBillingBadge, {
    summary: buildProviderBillingSummary('unknown'),
  }));
  const healthBadgeHtml = renderToStaticMarkup(React.createElement(ProviderHealthBadge, {
    summary: buildProviderHealthSummary({
      status: 'unavailable',
      latencyP50: 4200,
      errorRate: 0.91,
    }),
  }));
  const sourceBadgeHtml = renderToStaticMarkup(React.createElement(ProviderSourceBadge, {
    sourceLabel: 'CommonStack',
  }));
  const transportBadgeHtml = renderToStaticMarkup(React.createElement(ProviderTransportBadge, {
    protocol: 'openai',
    transportLabel: 'OpenAI-compatible',
    endpoint: 'https://commonstack.example/v1',
  }));
  const tooltip = formatNativeModelSwitcherTooltip({
    engineLabel: 'Neo',
    currentModel: 'mimo-v2.5-pro',
    displayProvider: 'xiaomi',
    displayModel: 'mimo-v2.5-pro',
    adaptive: true,
    overridden: false,
    billingSummary: buildProviderBillingSummary('payg'),
    healthSummary: buildProviderHealthSummary({ status: 'healthy', latencyP50: 120, errorRate: 0 }),
    effort: { label: 'High' },
    thinkingLabel: 'Think',
  });

  const checks: Record<string, boolean> = {
    routeTraceShowsPaygSavings: includesAll(paygHtml, [
      '按量付费',
      '按量省成本',
      '快模型优先',
      '识别为简单任务，按量计费下切到快模型降低成本和延迟。',
    ]),
    routeTraceShowsPlanNoSavings: includesAll(planHtml, [
      '计费跳过',
      '套餐/订阅',
      '套餐内不切换',
      '切换快模型没有实际节省',
    ]),
    routeTraceShowsUnknownConservative: includesAll(unknownHtml, [
      '未知计费',
      '计费未知保守',
      '保守沿用主任务模型',
    ]),
    routeTraceShowsProviderIdentity: includesAll(identityHtml, [
      '来源 CommonStack',
      '协议 OpenAI-compatible',
      'endpoint https://commonstack.example/v1',
    ]),
    modelSwitcherShowsBillingBadge: includesAll(billingBadgeHtml, [
      'data-provider-billing-mode="unknown"',
      '计费未知',
      '自动策略会保守处理',
    ]),
    modelSwitcherShowsHealthBadge: includesAll(healthBadgeHtml, [
      'data-provider-health-state="unavailable"',
      'Provider 状态: 不可用',
      'P50 4200ms · 错误率 91%',
    ]),
    modelSwitcherShowsSourceAndTransport: includesAll(`${sourceBadgeHtml}\n${transportBadgeHtml}`, [
      'data-provider-source-label="CommonStack"',
      '来源 CommonStack',
      'data-provider-transport-protocol="openai"',
      'data-provider-endpoint="https://commonstack.example/v1"',
      'OpenAI-compatible',
      'commonstack.example/v1',
    ]),
    modelSwitcherTooltipShowsTaskStrategyContext: tooltip === '自动路由（按任务、成本和能力切换，当前主任务 mimo-v2.5-pro） · Engine: Neo · 计费: 按量 · Provider: 健康 · Effort: High · Thinking: Think',
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
      'RouteTraceChip renders payg, plan, and unknown billing strategy outcomes',
      'RouteTraceChip renders provider source, protocol, and endpoint identity',
      'ModelSwitcher provider badges expose billing, health, source, and transport identity',
      'ModelSwitcher tooltip names the main task model strategy context',
    ],
  };
}

export async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const json = hasFlag(parsed, 'json');
  const result = buildModelStrategySurfaceVisibilityResult();

  if (json) {
    printJson(result);
  } else {
    printKeyValue('Model strategy surface visibility', [
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
