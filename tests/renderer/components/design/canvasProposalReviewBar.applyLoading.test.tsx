// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// CanvasProposalReviewBar —— #1 应用按钮 loading 反馈（真机 dogfood 发现）：
//  出图 ~15s，按钮 busy 时须显示「生成中…」+ disabled，非 busy 显示「应用」。
// ---------------------------------------------------------------------------
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import React from 'react';

import { CanvasProposalReviewBar } from '../../../../src/renderer/components/design/CanvasProposalReviewBar';
import { useAppStore } from '../../../../src/renderer/stores/appStore';
import type { CanvasOpProposal } from '../../../../src/shared/contract';

function makeProposal(): CanvasOpProposal {
  return {
    requestId: 'req-loading-1',
    rationale: '调整布局',
    // 非付费 op，避开成本闸，专测按钮态。
    ops: [{ kind: 'renameNode', nodeId: 'n1', label: '英雄区' }],
  } as unknown as CanvasOpProposal;
}

beforeEach(() => {
  useAppStore.setState({ language: 'zh' });
});

afterEach(() => {
  cleanup();
});

describe('CanvasProposalReviewBar 应用按钮 loading 态', () => {
  it('非 busy：按钮显示「应用」且可点', () => {
    const { container } = render(
      <CanvasProposalReviewBar proposal={makeProposal()} onApply={() => {}} onReject={() => {}} />,
    );
    const apply = container.querySelector('[data-testid="proposal-apply"]') as HTMLButtonElement;
    expect(apply).toBeTruthy();
    expect(apply.textContent).toContain('应用');
    expect(apply.textContent).not.toContain('生成中');
    expect(apply.disabled).toBe(false);
  });

  it('busy（onApply 未 resolve）：按钮文案变「生成中…」且 disabled；resolve 后复位「应用」', async () => {
    let resolveApply: () => void = () => {};
    const pending = new Promise<void>((r) => {
      resolveApply = r;
    });
    const { container } = render(
      <CanvasProposalReviewBar proposal={makeProposal()} onApply={() => pending} onReject={() => {}} />,
    );
    const apply = container.querySelector('[data-testid="proposal-apply"]') as HTMLButtonElement;

    await act(async () => {
      fireEvent.click(apply);
    });

    // 出图进行中：loading 文案 + disabled。
    expect(apply.textContent).toContain('生成中');
    expect(apply.textContent).not.toContain('应用');
    expect(apply.disabled).toBe(true);
    // 拒绝按钮 busy 时也保持 disabled。
    const reject = container.querySelector('[data-testid="proposal-reject"]') as HTMLButtonElement;
    expect(reject.disabled).toBe(true);

    await act(async () => {
      resolveApply();
      await pending;
    });

    await waitFor(() => {
      expect(apply.textContent).toContain('应用');
      expect(apply.textContent).not.toContain('生成中');
      expect(apply.disabled).toBe(false);
    });
  });
});
