import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ContextHealthPanel } from '../../../src/renderer/components/ContextHealthPanel';
import type { ContextHealthState } from '../../../src/shared/contract/contextHealth';

function makeHealth(overrides: Partial<ContextHealthState> = {}): ContextHealthState {
  return {
    currentTokens: 1000,
    maxTokens: 10000,
    usagePercent: 10,
    breakdown: { systemPrompt: 200, messages: 700, toolResults: 100 },
    warningLevel: 'normal',
    estimatedTurnsRemaining: 20,
    lastUpdated: Date.now(),
    ...overrides,
  };
}

// GAP-023 丢弃块此前直接把每个原始 block 标识符（如 'deferred-tools-manifest'）
// 铺成一排 pill。现在默认只留计数摘要，标识符收进「查看详情」折叠——
// 回归钉子：折叠默认收起时，原始标识符不该出现在渲染结果里。
describe('ContextHealthPanel — droppedPromptBlocks 折叠', () => {
  it('默认只显示计数摘要，块标识符默认折叠不裸露', () => {
    const html = renderToStaticMarkup(
      <ContextHealthPanel
        collapsed={false}
        health={makeHealth({ droppedPromptBlocks: ['deferred-tools-manifest', 'skills-catalog'] })}
      />,
    );

    expect(html).toContain('2');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('deferred-tools-manifest');
    expect(html).not.toContain('skills-catalog');
  });

  it('没有丢弃块时不渲染这块区域', () => {
    const html = renderToStaticMarkup(
      <ContextHealthPanel collapsed={false} health={makeHealth()} />,
    );
    expect(html).not.toContain('查看详情');
  });
});
