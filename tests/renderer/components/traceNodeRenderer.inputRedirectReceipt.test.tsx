// @vitest-environment jsdom

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { TraceNode } from '../../../src/shared/contract/trace';
import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';

afterEach(() => cleanup());

describe('input redirect receipt action', () => {
  it('keeps the original words collapsed and shows where the previous reply stopped', () => {
    const original = '请改用按业务价值排序的三段结构，并删掉技术背景铺垫；第一段先给业务判断，第二段写证据，第三段只留行动建议和验收口径';
    const node: TraceNode = {
      id: 'receipt-1',
      type: 'system',
      subtype: 'input_redirect_receipt',
      content: '',
      timestamp: 100,
      metadata: {
        inputRedirectReceipt: {
          receiptId: 'receipt-1',
          originalContent: original,
          expectedTurnId: 'turn-1',
          partial: { charCount: 126, trailingText: '上一段的末尾' },
          interruptedTools: ['Bash'],
        },
      },
    };

    render(<TraceNodeRenderer node={node} />);

    expect(screen.getByTestId('input-redirect-receipt').textContent).toContain('已按你的纠正改了方向：');
    expect(screen.getByTestId('input-redirect-receipt').textContent).not.toContain('上一轮写到 126 字处停下');
    expect(screen.queryByText(original)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '查看原话' }));
    expect(screen.getByText(original)).toBeTruthy();
    expect(screen.getByTestId('input-redirect-receipt').textContent).toContain('上一轮写到 126 字处停下');
    expect(screen.getByTestId('input-redirect-receipt').textContent).toContain('当时正在处理 Bash');
  });
});
