// @vitest-environment jsdom
// ============================================================================
// ContextHealthPanel — bySource 摘要桶（N-CTXPANEL）
// summary > 0 时渲染「摘要（压了 N 轮）」，summary = 0 / 缺失时不渲染。
// ============================================================================

import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextHealthPanel } from '../../../src/renderer/components/ContextHealthPanel';
import type { ContextHealthState } from '../../../src/shared/contract/contextHealth';

function makeHealth(summaryTokens: number, compressionCount = 2): ContextHealthState {
  return {
    currentTokens: 9500,
    maxTokens: 10000,
    usagePercent: 95,
    breakdown: {
      systemPrompt: 200,
      messages: 9100,
      toolResults: 200,
      bySource: {
        rules: 0,
        skills: {},
        mcp: {},
        subagents: {},
        fileReads: 0,
        summary: summaryTokens,
        conversation: 8600,
      },
    },
    warningLevel: 'critical',
    estimatedTurnsRemaining: 1,
    lastUpdated: Date.now(),
    compression: {
      status: 'active',
      compressionCount,
      totalSavedTokens: 5000,
    },
  };
}

afterEach(cleanup);

describe('ContextHealthPanel — bySource 摘要桶', () => {
  it('summary > 0：渲染摘要桶，文案带压缩轮数，token 数正确', () => {
    render(<ContextHealthPanel collapsed={false} health={makeHealth(500, 2)} />);

    expect(screen.getByText('摘要（压了 2 轮）')).toBeTruthy();
    expect(screen.getByText(/^500 \(/)).toBeTruthy();
  });

  it('summary = 0：不渲染摘要桶', () => {
    render(<ContextHealthPanel collapsed={false} health={makeHealth(0)} />);

    expect(screen.queryByText(/摘要（压了/)).toBeNull();
  });
});
