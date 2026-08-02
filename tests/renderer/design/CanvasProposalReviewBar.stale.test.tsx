import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { CanvasProposalReviewBar } from '../../../src/renderer/components/design/CanvasProposalReviewBar';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import type { CanvasOpProposal } from '../../../src/shared/contract/canvasProposal';
import { en } from '../../../src/renderer/i18n/en';

const proposal: CanvasOpProposal = {
  requestId: 'cp-stale',
  rationale: '整理布局',
  ops: [
    { kind: 'moveNode', nodeId: 'home', x: 120, y: 80 },
    { kind: 'moveNode', nodeId: 'settings', x: 420, y: 80 },
  ],
};

function render(staleNodeIds?: ReadonlySet<string>): string {
  return renderToStaticMarkup(
    <CanvasProposalReviewBar
      proposal={proposal}
      onApply={() => undefined}
      onReject={() => undefined}
      staleNodeIds={staleNodeIds}
    />,
  );
}

afterEach(() => {
  useAppStore.setState({ language: 'zh' });
});

describe('CanvasProposalReviewBar 陈旧标注', () => {
  it('陈旧 op 单独标出并讲清后果；同批其它 op 不带标注', () => {
    const html = render(new Set(['home']));

    expect(html).toContain('data-testid="proposal-op-stale-0"');
    expect(html).toContain('这张图你在等待审批期间挪动过——批准后它会移到我原先算的位置');
    expect(html).not.toContain('data-testid="proposal-op-stale-1"');
  });

  it('无陈旧 op 时不出现标注', () => {
    const html = render(new Set());

    expect(html).not.toContain('proposal-op-stale');
    expect(html).not.toContain('这张图你在等待审批期间挪动过');
  });

  it('keeps English i18n key aligned for the stale notice', () => {
    expect(en.canvasActor.staleMoveNotice).toContain('moved this while the proposal was waiting');
  });
});
