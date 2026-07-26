// @vitest-environment jsdom
// D3 回归（2026-07-26 打磨批 D）：会话行 hover 移开后归档等动作按钮仍显示。
// 根因：动作簇显隐挂在 group-focus-within 上，鼠标点击按钮后 Chrome 留下
// :focus（但不标 :focus-visible），focus-within 因此粘滞、动作簇常驻。
// 修复判据 = 鼠标移开且无（键盘）焦点时动作按钮隐藏：group-focus-within
// 全部换成 group-focus-visible（键盘 Tab 可及性保留，鼠标点击不再粘滞）。
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SidebarSessionItem } from '../../../src/renderer/components/features/sidebar/SidebarSessionItem';

function renderRow() {
  const session = {
    id: 'session-d3',
    title: 'Hover Stickiness Session',
    type: 'chat',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    messageCount: 4,
    turnCount: 2,
    modelConfig: { provider: 'openai', model: 'gpt-5' },
    workingDirectory: '/repo/code-agent',
  } as any;

  return renderToStaticMarkup(
    <SidebarSessionItem
      session={session}
      unreadSessionIds={new Set()}
      automationSummariesBySessionId={{}}
      currentSessionId={null}
      selectedSessionIds={new Set()}
      pinnedSessionIds={new Set()}
      renamingId={null}
      sessionRuntimes={new Map()}
      backgroundSessionMap={new Map()}
      sessionStates={{}}
      hasNeedsInputForSession={() => false}
      searchQuery=""
      messageSearchHitsBySessionId={{}}
      replayEvidenceBySessionId={new Map()}
      canOpenSessionReplay={true}
      reviewItemsBySessionId={{}}
      trajectoryQualityBySessionId={{}}
      multiSelectMode={false}
      hoveredSession={null}
      renameValue=""
      renameInputRef={React.createRef<HTMLInputElement>()}
      setHoveredSession={vi.fn()}
      setRenameValue={vi.fn()}
      handleSelectSession={vi.fn()}
      handleContextMenu={vi.fn()}
      handleRenameSubmit={vi.fn()}
      handleRenameKeyDown={vi.fn()}
      handleDoubleClick={vi.fn()}
      handleOpenSessionReplayInEvalCenter={vi.fn()}
      handleOpenSessionAssets={vi.fn()}
      handleOpenReplayEvidence={vi.fn()}
      handleSelectMessageSearchHit={vi.fn()}
      handleArchiveSession={vi.fn()}
    />,
  );
}

describe('SidebarSessionItem hover 动作簇显隐（D3）', () => {
  it('动作簇与右槽不再用 group-focus-within（鼠标点击焦点残留不再粘滞）', () => {
    const html = renderRow();
    expect(html).not.toContain('group-focus-within');
  });

  it('键盘可及性保留：显隐改挂 group-focus-visible，且默认 opacity-0', () => {
    const html = renderRow();
    expect(html).toContain('group-focus-visible:opacity-100');
    expect(html).toContain('opacity-0');
    expect(html).toContain('group-hover:opacity-100');
  });
});
