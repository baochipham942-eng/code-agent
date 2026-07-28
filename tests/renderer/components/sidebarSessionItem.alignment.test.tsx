// @vitest-environment jsdom
// 侧栏对齐规范（2026-07-27 审美关，规范文档：
// code-agent-private-archive/docs/plans/2026-07-27-sidebar-session-list-alignment.md）：
//   1. 会话行不再显示相对时间——新旧靠排序表达，精确时间进行级 title
//   2. 标题左缘恒定 —— 置顶走固定 16px 前导槽，未读点挪到行尾状态列；
//      此前置顶 12px / 未读 6px / 无标记 0px 三档让标题左缘漂移
//   3. 行尾两个固定宽槽（#771 起）：左槽临时状态、内容互斥（spinner / 需关注点 /
//      未读点 / 空）；右槽是身份轴（分叉标记 / 用过实时语音），与临时状态并存不互斥
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SidebarSessionItem } from '../../../src/renderer/components/features/sidebar/SidebarSessionItem';

function renderRow(overrides: { pinned?: boolean; unread?: boolean; hadLiveVoice?: boolean; forkedFrom?: string } = {}) {
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
    ...(overrides.hadLiveVoice || overrides.forkedFrom
      ? {
          metadata: {
            ...(overrides.hadLiveVoice ? { hadLiveVoice: true } : {}),
            ...(overrides.forkedFrom ? { forkLineage: { parentSessionId: overrides.forkedFrom } } : {}),
          },
        }
      : {}),
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
  // 挂在标题后面会永远比它们靠左一格，所以必须进固定宽槽位。
  // #771 之后行尾是两个固定槽：左=临时状态、右=身份轴，语音走右槽（见下条）。
  it('图标进行尾固定槽（与别的行同列，不是挂在标题后面）', () => {
    const html = renderRow({ hadLiveVoice: true });
    const slotIndex = html.lastIndexOf('w-4 shrink-0 flex items-center justify-center');
    const badgeIndex = html.indexOf('session-live-voice-badge');
    expect(badgeIndex).toBeGreaterThan(slotIndex);
  });

  // #771 把身份（分叉标记）拆成独立最右轴，明确不与临时状态互斥。
  // 「用过语音」和「分叉来的」是同一类事实——说的是这会话**是什么**，
  // 不是它**此刻怎么了**——所以语音图标一并归身份轴，不再让位给未读/在跑。
  // 这条门就是防止有人把它挪回互斥链里（那样有未读时语音标识就消失了）。
  it('未读/在跑时语音标识不让位——身份与临时状态各占一槽', () => {
    const html = renderRow({ hadLiveVoice: true, unread: true });
    expect(html).toContain('bg-purple-400');
    expect(html).toContain('session-live-voice-badge');
  });

  // 身份轴只有一格：两个身份同时成立时让给分叉标记——它可点击、能跳回父会话，
  // 信息量更大。这条钉住取舍方向，免得以后反过来又不知道为什么。
  it('既分叉又用过语音时，身份轴让给分叉标记', () => {
    const html = renderRow({ hadLiveVoice: true, forkedFrom: 'parent-session' });
    expect(html).toContain('fork-lineage-marker');
    expect(html).not.toContain('session-live-voice-badge');
  });
});
