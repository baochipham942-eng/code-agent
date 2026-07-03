// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// TurnQualityStrip 降级为安静徽标：
//  默认（开发者模式关）→ 只显示模型名的小徽标，无评分/记忆 chip/展开交互；
//  开发者模式开 → 恢复评分 chip + 可展开五维评分详情。
// ---------------------------------------------------------------------------
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { TurnQualitySummary } from '../../../src/shared/contract/turnQuality';
import { TurnQualityStrip } from '../../../src/renderer/components/features/chat/TurnQualityStrip';
import { useAppStore } from '../../../src/renderer/stores/appStore';

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: vi.fn().mockResolvedValue(undefined) },
}));

const summary: TurnQualitySummary = {
  memory: {
    mode: 'auto',
    blocks: [
      {
        blockType: 'seed-memory',
        trigger: 'session_start',
        source: 'memory-packer',
        injected: true,
        chars: 120,
        count: 1,
        items: [
          {
            entryId: 'mem-entry-1',
            title: 'Memory Rule',
            kind: 'project',
            scope: 'project',
            status: 'active',
            preview: 'Keep retrieval visible.',
          },
        ],
      },
    ],
  },
  strategy: {
    provider: 'zhipu',
    model: 'glm-5',
    reason: '路由原因 user-selected',
  },
  capabilities: { agentName: 'coder', toolsUsed: ['bash'] },
  score: {
    score: 88,
    max: 100,
    grade: 'good',
    breakdown: [
      { dimension: 'strategy', score: 18, max: 20, status: 'good', reasons: ['路由原因 user-selected'] },
    ],
  },
} as TurnQualitySummary;

describe('TurnQualityStrip', () => {
  beforeEach(() => {
    useAppStore.setState({ developerMode: false });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders only a quiet model-name badge for regular users', () => {
    const { container } = render(<TurnQualityStrip summary={summary} />);
    const text = container.textContent || '';
    expect(text).toContain('glm-5');
    expect(text).not.toContain('88');
    expect(text).not.toContain('记忆');
    // 非交互：不渲染任何按钮/展开控件
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('[aria-expanded]')).toBeNull();
  });

  it('手动指定 agent 后，非开发者模式也透出安静 agent 徽标（本轮由 X 执行）', () => {
    const { container } = render(<TurnQualityStrip summary={summary} />);
    const text = container.textContent || '';
    expect(text).toContain('coder');
    // 仍然安静：无按钮、无展开
    expect(container.querySelector('button')).toBeNull();
  });

  it('自动路由默认 agent（default/缺失）不显示 agent 徽标', () => {
    const auto: TurnQualitySummary = {
      ...summary,
      capabilities: { agentName: 'default', toolsUsed: [] },
    } as TurnQualitySummary;
    const { container } = render(<TurnQualityStrip summary={auto} />);
    expect(container.textContent || '').not.toContain('default');

    const missing: TurnQualitySummary = {
      ...summary,
      capabilities: { toolsUsed: [] },
    } as TurnQualitySummary;
    const { container: c2 } = render(<TurnQualityStrip summary={missing} />);
    expect((c2.textContent || '')).toContain('glm-5');
  });

  it('unescapes html entities in memory preview text when expanded in developer mode', () => {
    useAppStore.setState({ developerMode: true });
    const escaped: TurnQualitySummary = {
      ...summary,
      memory: {
        ...summary.memory,
        blocks: [
          {
            ...summary.memory.blocks[0],
            blockType: 'failure_journal',
            items: [
              {
                ...(summary.memory.blocks[0].items?.[0] as object),
                entryId: 'fj-1',
                preview: '&gt; 工具调用失败 &amp; 已重试',
              },
            ],
          },
        ],
      },
    } as TurnQualitySummary;
    const { container } = render(<TurnQualityStrip summary={escaped} />);
    fireEvent.click(container.querySelector('[aria-expanded]')!);
    const text = container.textContent || '';
    expect(text).toContain('> 工具调用失败 & 已重试');
    expect(text).not.toContain('&gt;');
  });

  it('renders the score chip with expandable details in developer mode', () => {
    useAppStore.setState({ developerMode: true });
    const { container } = render(<TurnQualityStrip summary={summary} />);
    expect(container.textContent).toContain('88/100');
    const toggle = container.querySelector('[aria-expanded]');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle!);
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('18/20');
  });
});
