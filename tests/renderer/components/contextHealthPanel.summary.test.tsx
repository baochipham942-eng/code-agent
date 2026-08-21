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

  // 爸 2026-08-21 真机反馈：全是 0 的桶还占位显示「0 (0.0%)」，看起来就像坏了。
  // Cursor 面板口径：0 值桶不占位。反向变异承重：去掉 BreakdownItem/NestedGroup
  // 的 0 值过滤，本用例立红。
  it('0 值桶不占位：规则/文件读取/空分组不渲染，非零桶正常显示', () => {
    const health = makeHealth(500, 2);
    render(<ContextHealthPanel collapsed={false} health={health} />);

    // bySource 区的 0 值标量桶不占位
    expect(screen.queryByText('规则')).toBeNull();
    expect(screen.queryByText('文件读取')).toBeNull();
    // 空 Record 分组不占位
    expect(screen.queryByText('Skills')).toBeNull();
    expect(screen.queryByText('MCP')).toBeNull();
    expect(screen.queryByText('Subagents')).toBeNull();
    // 非零桶正常显示
    expect(screen.getByText('对话')).toBeTruthy();
    expect(screen.getByText('摘要（压了 2 轮）')).toBeTruthy();
  });
});
