// @vitest-environment jsdom
// ============================================================================
// ToolHeader 基线对齐：状态词（text-xs）与主文案（text-sm）同行混排时，
// 容器必须 items-baseline 而不是 items-center（盒子居中对齐 ≠ 文字基线对齐，
// 12px/14px 混排在 Retina 上差 1 个物理像素）；图标类元素补 self-center 防下沉。
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
// 打开语义 UI flag，让 TargetContextIcon 参与渲染，验证图标的 self-center
vi.mock('../../../src/renderer/utils/featureFlags', () => ({
  isSemanticToolUIEnabled: () => true,
}));

import { ToolHeader } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolHeader';

function failedCall(withTarget: boolean): ToolCall {
  return {
    id: 'tc-fail-1',
    name: 'Read',
    arguments: { file_path: '/tmp/a.md' },
    result: {
      toolCallId: 'tc-fail-1',
      success: false,
      output: 'boom',
    },
    ...(withTarget ? { targetContext: { kind: 'browser', label: 'Browser' } } : {}),
  } as ToolCall;
}

function okCall(): ToolCall {
  return {
    id: 'tc-ok-1',
    name: 'Read',
    arguments: { file_path: '/tmp/a.md' },
    result: {
      toolCallId: 'tc-ok-1',
      success: true,
      // 无 "N lines" 等可报数据 → enrichCompletedLabel 返回 null → 状态词不渲染
      output: 'file body',
    },
  } as ToolCall;
}

afterEach(cleanup);

describe('ToolHeader — 状态词与主文案基线对齐', () => {
  it('失败态（状态词在场）：容器用 items-baseline 而非 items-center', () => {
    const { container } = render(<ToolHeader toolCall={failedCall(false)} status="error" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root).toBeTruthy();
    expect(root.className).toContain('items-baseline');
    expect(root.className).not.toContain('items-center');
    // 状态词与主文案同时在场（主文案带 file_path，走可点预览的 button）
    expect(root.querySelector('span.text-xs')).toBeTruthy();
    expect(screen.getByTestId('tool-header-open-preview')).toBeTruthy();
  });

  it('失败态且渲染了 TargetContextIcon：图标带 self-center，不随基线下沉', () => {
    render(<ToolHeader toolCall={failedCall(true)} status="error" />);
    const icon = screen.getByLabelText('Browser');
    // SVG 元素的 className 是 SVGAnimatedString，需取 class 属性断言
    expect(icon.getAttribute('class')).toContain('self-center');
  });

  it('成功态且 statusLabel 为 null（只有主文案）：渲染不报错、结构不变', () => {
    const { container } = render(<ToolHeader toolCall={okCall()} status="success" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root).toBeTruthy();
    // 无主文案以外的状态词
    expect(root.querySelector('span.text-xs')).toBeNull();
    expect(screen.getByText(/读取了/)).toBeTruthy();
  });
});
