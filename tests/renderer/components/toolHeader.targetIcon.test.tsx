// @vitest-environment jsdom
// ============================================================================
// ToolHeader 的 target 图标：模型不再填 targetContext 之后还渲不渲得出来
// ============================================================================
// 这几条替代了工单原本要求的「真机看一次流式」——原方案把推导放在宿主侧，
// 才会有「流式期间图标出不来、要等最终消息」的问题；改成渲染端推导后只剩
// 一条路径，流式态可以直接用「工具名已知、arguments 还空着」这个形态钉住。
// ============================================================================
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ToolCall } from '../../../src/shared/contract';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (s: { openPreview: () => void }) => unknown) =>
    selector({ openPreview: () => {} }),
}));
vi.mock('../../../src/renderer/utils/featureFlags', () => ({
  isSemanticToolUIEnabled: () => true,
}));
// app kind 会调 NSWorkspace bridge，jsdom 里拿不到，退到 emoji/Monitor 分支
vi.mock('../../../src/renderer/hooks/useAppIcon', () => ({ useAppIcon: () => null }));

import { ToolHeader } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolHeader';

function call(overrides: Partial<ToolCall> & { name: string }): ToolCall {
  return { id: 'tc-1', arguments: {}, ...overrides } as ToolCall;
}

afterEach(cleanup);

describe('ToolHeader target 图标', () => {
  it('模型没填 targetContext 时，按工具名推出来照样渲染', () => {
    render(<ToolHeader toolCall={call({ name: 'Read', arguments: { file_path: '/a/MEMORY.md' } })} status="success" />);
    expect(screen.getByLabelText('MEMORY.md')).toBeTruthy();
  });

  it('流式态（工具名已知、arguments 还空着）也有图标，只是没 label', () => {
    render(<ToolHeader toolCall={call({ name: 'Read', arguments: {} })} status="pending" />);
    expect(screen.getByLabelText('File')).toBeTruthy();
  });

  it('宿主已推的 targetContext 优先，不被渲染端推导覆盖（cua 的真 app 图标）', () => {
    render(<ToolHeader toolCall={call({
      name: 'computer_use',
      arguments: {},
      targetContext: { kind: 'app', label: 'WeChat', iconHint: 'com.tencent.xinWeChat' },
    })} status="success" />);
    // emoji 分支带 aria-label=label
    expect(screen.getByLabelText('WeChat')).toBeTruthy();
  });

  it('两边都有值时宿主/历史值赢——这条才真的钉住优先级', () => {
    // 上一条（computer_use）钉不住：它推导出 undefined，两种优先级结果一样，
    // 把 `??` 顺序反过来测试照样绿。必须挑一个**两边都有值**的形态。
    render(<ToolHeader toolCall={call({
      name: 'Read',
      arguments: { file_path: '/a/b.ts' },
      targetContext: { kind: 'file', label: '历史标签' },
    })} status="success" />);
    expect(screen.getByLabelText('历史标签')).toBeTruthy();
    expect(screen.queryByLabelText('b.ts')).toBeNull();
  });

  it('「无目标」的工具不长图标——Bash 的目标是一条命令，不是可图标化的实体', () => {
    const KIND_ICONS = 'svg.lucide-globe, svg.lucide-file-text, svg.lucide-brain, svg.lucide-plug';

    // 正向对照先跑：没有它，下面那条 0 的断言可能只是选择器写错了在自欺
    const withIcon = render(
      <ToolHeader toolCall={call({ name: 'Read', arguments: { file_path: '/a/b.ts' } })} status="success" />,
    );
    expect(withIcon.container.querySelectorAll(KIND_ICONS).length).toBe(1);
    cleanup();

    const bash = render(
      <ToolHeader toolCall={call({ name: 'Bash', arguments: { command: 'ls -la' } })} status="success" />,
    );
    expect(bash.container.querySelectorAll(KIND_ICONS).length).toBe(0);
  });
});
