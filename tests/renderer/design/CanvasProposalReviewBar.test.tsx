import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { CanvasProposalReviewBar } from '../../../src/renderer/components/design/CanvasProposalReviewBar';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import type { CanvasOpProposal } from '../../../src/shared/contract/canvasProposal';
import { en } from '../../../src/renderer/i18n/en';

const proposal: CanvasOpProposal = {
  requestId: 'cp-explain',
  rationale: '整理用户流',
  ops: [
    {
      kind: 'moveNode',
      nodeId: 'home',
      x: 120,
      y: 80,
      intent: '移动首页，让主流程从左到右阅读',
      source: 'design_acceptance_contract',
      affectedNodes: ['home'],
    },
    {
      kind: 'addShape',
      shape: { kind: 'sticky', x: 10, y: 20, width: 160, height: 80, text: '待补状态' },
      intent: '补一个状态说明，帮助后续 code handoff',
      source: 'qa_finding',
      affectedNodes: [],
    },
  ],
};

function render(): string {
  return renderToStaticMarkup(
    <CanvasProposalReviewBar
      proposal={proposal}
      onApply={() => undefined}
      onReject={() => undefined}
    />,
  );
}

afterEach(() => {
  useAppStore.setState({ language: 'zh' });
});

describe('CanvasProposalReviewBar', () => {
  it('renders per-op what, why, impact and source explanations', () => {
    const html = render();

    expect(html).toContain('data-testid="proposal-op-explain-0"');
    expect(html).toContain('移动 · home');
    expect(html).toContain('为什么：移动首页，让主流程从左到右阅读');
    expect(html).toContain('影响范围：home');
    expect(html).toContain('来源：验收契约');
    expect(html).toContain('为什么：补一个状态说明，帮助后续 code handoff');
    expect(html).toContain('影响范围：新增画布元素');
    expect(html).toContain('来源：QA 发现');
  });

  it('keeps English i18n keys aligned for proposal explanations', () => {
    expect(en.design.proposalWhy).toContain('{intent}');
    expect(en.design.proposalImpactNodes).toContain('{nodes}');
    expect(en.design.proposalSource).toContain('{source}');
    expect(en.design.proposalSourceAcceptanceContract).toBe('acceptance contract');
    expect(en.design.proposalSourceQaFinding).toBe('QA finding');
  });
});
