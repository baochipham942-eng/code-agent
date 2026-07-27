// @vitest-environment jsdom
// 侧栏对齐规范（2026-07-27 审美关，规范文档：
// code-agent-private-archive/docs/plans/2026-07-27-sidebar-session-list-alignment.md）：
//   1. 会话行不再显示相对时间——新旧靠排序表达，精确时间进行级 title
//   2. 标题左缘恒定 —— 置顶走固定 16px 前导槽，未读点挪到行尾状态列；
//      此前置顶 12px / 未读 6px / 无标记 0px 三档让标题左缘漂移
//   3. 行尾状态列宽度恒定，内容互斥（spinner / 需关注点 / 未读点 / 空）
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SidebarSessionItem } from '../../../src/renderer/components/features/sidebar/SidebarSessionItem';

function renderRow(overrides: { pinned?: boolean; unread?: boolean; hadLiveVoice?: boolean } = {}) {
  const session = {
    id: 'session-align',
    title: '对齐用例会话',
    type: 'chat',
    status: 'idle',
    createdAt: 1,
    // 明显是「很久以前」，旧实现会渲染出「N 天前」之类的文案
    updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 3,
    messageCount: 4,
    turnCount: 2,
    modelConfig: { provider: 'openai', model: 'gpt-5' },
    workingDirectory: '/repo/code-agent',
    ...(overrides.hadLiveVoice ? { metadata: { hadLiveVoice: true } } : {}),
  } as any;

  return renderToStaticMarkup(
    <SidebarSessionItem
      session={session}
      unreadSessionIds={overrides.unread ? new Set(['session-align']) : new Set()}
      automationSummariesBySessionId={{}}
      currentSessionId={null}
      selectedSessionIds={new Set()}
      pinnedSessionIds={overrides.pinned ? new Set(['session-align']) : new Set()}
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

describe('侧栏会话行对齐规范', () => {
  it('不再渲染相对时间文案', () => {
    const html = renderRow();
    expect(html).not.toMatch(/天前|小时前|分钟前|刚刚|ago/);
  });

  it('精确时间改挂行级 title（撤掉相对时间后的补偿）', () => {
    expect(renderRow()).toContain('title=');
  });

  it('标题左缘恒定：前导槽宽度不随置顶/未读变化', () => {
    const plain = renderRow();
    const pinned = renderRow({ pinned: true });
    const unread = renderRow({ unread: true });
    // 三种状态都渲染同一个固定宽前导槽
    for (const html of [plain, pinned, unread]) {
      expect(html).toContain('w-4 shrink-0 flex items-center justify-center');
    }
    // 置顶标记在前导槽里；未读点不在行首
    expect(pinned).toContain('lucide-pin');
    expect(unread).not.toContain('lucide-pin');
  });

  it('未读点在行尾状态列，不再占行首', () => {
    const unread = renderRow({ unread: true });
    const leadIndex = unread.indexOf('w-4 shrink-0 flex items-center justify-center');
    const dotIndex = unread.indexOf('bg-purple-400');
    expect(dotIndex).toBeGreaterThan(leadIndex);
    // 行尾状态列本身也是固定宽
    expect(unread).toContain('w-4 shrink-0 flex items-center justify-center');
  });

  it('标题带 min-w-0，保证 truncate 在 flex 里真生效', () => {
    expect(renderRow()).toContain('min-w-0 flex-1 truncate text-sm');
  });

  it('hover 动作簇带不透明底，不再直接压在标题上', () => {
    expect(renderRow()).toContain('bg-zinc-800');
  });
});

// 产品负责人 2026-07-27：实时语音的会话要在标题旁带语音图标。
// 判据钉在「metadata 真的驱动了渲染」——「图标加上了但永远不亮」是本仓高发故障。
describe('实时语音会话标记', () => {
  it('会话 metadata 标了 hadLiveVoice 才渲染语音图标', () => {
    expect(renderRow({ hadLiveVoice: true })).toContain('session-live-voice-badge');
    expect(renderRow()).not.toContain('session-live-voice-badge');
  });

  // 产品负责人 2026-07-27：图标要和别的行的状态点**同列居中**。
  // 挂在标题后面会永远比它们靠左一格，所以进同一个固定宽状态槽，
  // 按既有「内容互斥」规范排在优先级最低一档。
  it('图标进行尾状态槽（与别的行的状态点同列）', () => {
    const html = renderRow({ hadLiveVoice: true });
    const slotIndex = html.lastIndexOf('w-4 shrink-0 flex items-center justify-center');
    const badgeIndex = html.indexOf('session-live-voice-badge');
    expect(badgeIndex).toBeGreaterThan(slotIndex);
  });

  it('未读/在跑时状态优先，语音标识让位（槽内容互斥）', () => {
    const html = renderRow({ hadLiveVoice: true, unread: true });
    expect(html).toContain('bg-purple-400');
    expect(html).not.toContain('session-live-voice-badge');
  });
});
