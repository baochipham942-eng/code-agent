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
