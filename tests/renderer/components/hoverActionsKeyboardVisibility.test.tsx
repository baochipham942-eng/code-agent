import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: () => ({ currentSessionId: 'session-1' }),
}));

vi.mock('../../../src/renderer/stores/appStore', () => {
  const state = {
    setShowSettings: vi.fn(),
    closeWorkbenchTab: vi.fn(),
    workbenchHighlight: null,
    setWorkbenchHighlight: vi.fn(),
  };
  return {
    useAppStore: (selector?: (value: typeof state) => unknown) =>
      selector ? selector(state) : state,
  };
});

vi.mock('../../../src/renderer/stores/skillStore', () => ({
  useSkillStore: () => ({
    mountedSkills: [{ skillName: 'formatter', libraryId: 'builtin' }],
    availableSkills: [
      {
        name: 'formatter',
        description: '格式化内容',
        basePath: '/skills/builtin/formatter',
      },
      {
        name: 'reviewer',
        description: '审阅内容',
        basePath: '/skills/builtin/reviewer',
      },
    ],
    loading: false,
    error: null,
    setCurrentSession: vi.fn(),
    fetchAvailableSkills: vi.fn(),
    mountSkill: vi.fn(),
    unmountSkill: vi.fn(),
    refreshAll: vi.fn(),
    clearError: vi.fn(),
  }),
}));

import { ContextHealthPanel } from '../../../src/renderer/components/ContextHealthPanel';
import { SkillsPanel } from '../../../src/renderer/components/SkillsPanel';
import { AttachmentBar } from '../../../src/renderer/components/features/chat/ChatInput/AttachmentBar';
import { SidebarSessionItem } from '../../../src/renderer/components/features/sidebar/SidebarSessionItem';

function count(markup: string, token: string): number {
  return markup.split(token).length - 1;
}

describe('hover actions remain visible to keyboard users', () => {
  it('reveals SidebarSessionItem actions and reciprocally hides its status slot on group focus', () => {
    const html = renderToStaticMarkup(
      <SidebarSessionItem
        {...({
          session: {
            id: 'session-1',
            title: 'M2 键盘验收',
            modelConfig: {},
            workingDirectory: '/tmp/m2',
            createdAt: 1,
            updatedAt: 1,
            messageCount: 2,
            turnCount: 1,
          },
          unreadSessionIds: new Set<string>(),
          automationSummariesBySessionId: {},
          currentSessionId: 'session-1',
          selectedSessionIds: new Set<string>(),
          pinnedSessionIds: new Set<string>(),
          renamingId: null,
          sessionRuntimes: new Map(),
          backgroundTaskMap: new Map(),
          sessionStates: {},
          hasPendingApprovalForSession: () => false,
          hasNeedsInputForSession: () => false,
          searchQuery: '',
          messageSearchHitsBySessionId: {},
          replayEvidenceBySessionId: {},
          canOpenSessionReplay: true,
          reviewItemsBySessionId: {},
          trajectoryQualityBySessionId: {},
          multiSelectMode: false,
          hoveredSession: null,
          renameValue: '',
          renameInputRef: React.createRef<HTMLInputElement>(),
          setHoveredSession: vi.fn(),
          setRenameValue: vi.fn(),
          handleSelectSession: vi.fn(),
          handleContextMenu: vi.fn(),
          handleRenameSubmit: vi.fn(),
          handleRenameKeyDown: vi.fn(),
          handleDoubleClick: vi.fn(),
          handleOpenSessionReplay: vi.fn(),
          handleOpenSessionAssets: vi.fn(),
          handleOpenReplayEvidence: vi.fn(),
          handleSelectMessageSearchHit: vi.fn(),
          handleArchiveSession: vi.fn(),
        } as React.ComponentProps<typeof SidebarSessionItem>)}
      />,
    );

    expect(html).toContain('focus-visible:opacity-100');
    expect(html).toContain('group-focus-within:opacity-100');
    expect(html).toContain('group-focus-within:opacity-0');
    expect(count(html, 'focus-visible:ring-1')).toBe(2);
    expect(html).toContain('aria-label="归档会话 M2 键盘验收"');
  });

  it('reveals both SkillsPanel action siblings and names their target skills', () => {
    const html = renderToStaticMarkup(<SkillsPanel />);

    expect(count(html, 'focus-visible:opacity-100')).toBe(2);
    expect(count(html, 'group-focus-within:opacity-100')).toBe(2);
    expect(html).toContain('aria-label="卸载 Skill formatter"');
    expect(html).toContain('aria-label="挂载 Skill reviewer"');
  });

  it('reveals both ContextHealthPanel source actions and names their source', () => {
    const html = renderToStaticMarkup(
      <ContextHealthPanel
        collapsed={false}
        onNavigate={vi.fn()}
        onUnload={vi.fn()}
        health={{
          currentTokens: 100,
          maxTokens: 1000,
          usagePercent: 10,
          warningLevel: 'normal',
          estimatedTurnsRemaining: 9,
          lastUpdated: 1,
          breakdown: {
            systemPrompt: 20,
            messages: 50,
            toolResults: 30,
            bySource: {
              rules: 0,
              skills: { formatter: 20 },
              mcp: {},
              subagents: {},
              fileReads: 0,
              conversation: 80,
            },
          },
        }}
      />,
    );

    expect(count(html, 'focus-visible:opacity-100')).toBe(2);
    expect(count(html, 'group-focus-within:opacity-100')).toBe(2);
    expect(html).toContain('aria-label="跳转到 formatter 对应面板"');
    expect(html).toContain('aria-label="卸载或断开 formatter"');
  });

  it('reveals the AttachmentBar remove button and names its attachment', () => {
    const html = renderToStaticMarkup(
      <AttachmentBar
        attachments={[
          {
            id: 'attachment-1',
            type: 'file',
            category: 'text',
            name: '验收记录.txt',
            size: 1024,
            mimeType: 'text/plain',
          },
        ]}
        onRemove={vi.fn()}
      />,
    );

    expect(html).toContain('focus-visible:opacity-100');
    expect(html).toContain('group-focus-within:opacity-100');
    expect(html).toContain('aria-label="移除附件 验收记录.txt"');
  });
});
