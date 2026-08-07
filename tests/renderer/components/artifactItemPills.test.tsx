// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';
import type { TraceNode } from '../../../src/shared/contract/trace';
import type { TurnArtifactOwnershipItem } from '../../../src/shared/contract/turnTimeline';

function makeNode(items: TurnArtifactOwnershipItem[]): TraceNode {
  return {
    id: 'turn-1-artifact-ownership',
    type: 'turn_timeline',
    content: '',
    timestamp: 1000,
    turnTimeline: {
      id: 'turn-1-artifact-ownership',
      kind: 'artifact_ownership',
      timestamp: 1000,
      tone: 'success',
      artifactOwnership: items,
    },
  } as TraceNode;
}

const artifactItem = (label: string): TurnArtifactOwnershipItem => ({
  kind: 'artifact',
  label,
  ownerKind: 'assistant',
  ownerLabel: 'Assistant',
});

// 产物行的外层容器（图标 + 文案那一行）
function rowFor(label: string): HTMLElement {
  const row = screen.getByText(label).closest('div.flex.items-center');
  expect(row).toBeTruthy();
  return row as HTMLElement;
}

function iconClassFor(label: string): string {
  return rowFor(label).querySelector('svg')?.getAttribute('class') ?? '';
}

describe('ArtifactItemPills 产物行（非 link 项）', () => {
  afterEach(() => cleanup());

  it('docx/xlsx/pptx 不再渲染 Artifact 徽章与 Assistant 次行，且三类图标互不相同', () => {
    const { container } = render(
      <TraceNodeRenderer
        node={makeNode([
          artifactItem('Q3 产品策略报告.docx'),
          artifactItem('访谈洞察与优先级.xlsx'),
          artifactItem('Q3 评审演示稿.pptx'),
        ])}
      />,
    );

    // 中英夹杂清零：渲染输出里不出现 Artifact / Assistant
    expect(container.textContent).not.toContain('Artifact');
    expect(container.textContent).not.toContain('Assistant');
    // 区块标题走 i18n（默认 zh）
    expect(container.textContent).toContain('产物');

    // 一眼可辨的承重断言：三类文件各自映射到不同图标
    const docxIcon = iconClassFor('Q3 产品策略报告.docx');
    const xlsxIcon = iconClassFor('访谈洞察与优先级.xlsx');
    const pptxIcon = iconClassFor('Q3 评审演示稿.pptx');
    expect(docxIcon).toContain('lucide-file-text');
    expect(xlsxIcon).toContain('lucide-table');
    expect(pptxIcon).toContain('lucide-presentation');
    expect(new Set([docxIcon, xlsxIcon, pptxIcon]).size).toBe(3);
  });

  it('link 项（Sources 来源）保持现状：Link 徽章 + 来源工具名次行都在', () => {
    const { container } = render(
      <TraceNodeRenderer
        node={makeNode([
          {
            kind: 'link',
            label: 'example.com',
            ownerKind: 'tool',
            ownerLabel: 'WebFetch',
            url: 'https://example.com',
          },
        ])}
      />,
    );

    // 来源默认折叠，先点开
    const toggle = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('来源'));
    expect(toggle).toBeTruthy();
    fireEvent.click(toggle!);

    expect(container.textContent).toContain('Link');
    expect(container.textContent).toContain('WebFetch');
    expect(container.textContent).toContain('example.com');
  });
});
