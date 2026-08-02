import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SidebarSessionItem } from '../../../src/renderer/components/features/sidebar/SidebarSessionItem';

// 归档图标对齐（2026-08-01 真机截图）：hover 归档簇要与行内容右缘同轨、有 z-index
// 压住行内状态槽，且不带 Tailwind v4 不生效的死 class（!p-1 前缀写法）。
describe('SidebarSessionItem 归档动作簇对齐', () => {
  function renderRow() {
    const session = {
      id: 'session-align',
      title: 'Align Check',
      type: 'chat',
      status: 'idle',
      createdAt: 1,
      updatedAt: 2,
      messageCount: 2,
      turnCount: 1,
      modelConfig: { provider: 'openai', model: 'gpt-5' },
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
        handleOpenReplayEvidence={vi.fn()}
        handleSelectMessageSearchHit={vi.fn()}
        handleArchiveSession={vi.fn()}
      />,
    );
  }

  it('hover 簇：z-10 压层 + right-1.5 与行右缘同轨 + 垂直居中', () => {
    const html = renderRow();
    expect(html).toContain('z-10');
    expect(html).toContain('right-1.5');
    expect(html).toContain('top-1/2');
    expect(html).toContain('-translate-y-1/2');
  });

  it('归档按钮不带 v4 死 class（!p-1 前缀 important 不生成 CSS）', () => {
    const html = renderRow();
    expect(html).not.toContain('!p-1');
  });
});
