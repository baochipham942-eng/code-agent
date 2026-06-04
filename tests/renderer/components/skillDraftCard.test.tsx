// ============================================================================
// SkillDraftCard 渲染测试 — 按 origin 出 badge + 分流副标题
// LLM 自沉淀草稿没有工具序列，副标题必须显示描述而非"成功 0 次"。
// ============================================================================

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// 组件 import 时会带出 ipcService（node env 下避免其副作用）
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { on: () => () => {}, invoke: async () => ({ success: true }) },
}));

import { SkillDraftCard } from '../../../src/renderer/components/features/chat/ChatInput/SkillDraftCard';

function render(draft: Record<string, unknown>): string {
  return renderToStaticMarkup(
    React.createElement(SkillDraftCard, {
      drafts: [draft as never],
      onResolved: () => {},
      onDismiss: () => {},
    }),
  );
}

describe('SkillDraftCard', () => {
  it('LLM 自沉淀草稿：显示 AI 自沉淀 badge + 描述副标题（不显示成功次数）', () => {
    const html = render({
      id: 'd1',
      name: 'deploy-tauri-macos',
      description: '部署 Tauri 桌面应用的标准流程',
      toolSequence: [],
      occurrences: 0,
      origin: 'llm-review',
    });
    expect(html).toContain('AI 自沉淀');
    expect(html).toContain('部署 Tauri 桌面应用的标准流程');
    expect(html).not.toContain('成功 0 次');
  });

  it('经验蒸馏草稿：显示 经验蒸馏 badge + 工具序列 + 成功次数', () => {
    const html = render({
      id: 'd2',
      name: 'grep-read-edit',
      description: 'desc',
      toolSequence: ['Grep', 'Read', 'Edit'],
      occurrences: 3,
      origin: 'telemetry-distilled',
    });
    expect(html).toContain('经验蒸馏');
    expect(html).toContain('Grep → Read → Edit');
    expect(html).toContain('成功 3 次');
  });

  it('缺 origin（旧事件）→ 兜底按经验蒸馏渲染', () => {
    const html = render({
      id: 'd3',
      name: 'legacy',
      description: 'desc',
      toolSequence: ['Bash'],
      occurrences: 2,
    });
    expect(html).toContain('经验蒸馏');
  });
});
