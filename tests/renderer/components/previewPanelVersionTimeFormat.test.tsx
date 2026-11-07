// @vitest-environment jsdom
// ============================================================================
// PreviewPanel 已发布版本菜单时间口径（N-CRON-DETAIL-TIME-FORMAT-MIXED-FU1 返修）：
// 版本菜单里历史版本的裸 toLocaleDateString 改走 utils/formatDateTime(publishedAt, language)，
// zh 24 小时制带年份、绝不跟机器 locale 出 AM/PM；en 维持 en-US 原样。
// 菜单挂在标题栏徽记上（versionsOpen），点开才能看到历史版本行。
// ============================================================================
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewTab } from '../../../src/renderer/stores/appStore';

const sendPrompt = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: (selector: (state: { sendPrompt: typeof sendPrompt }) => unknown) =>
    selector({ sendPrompt }),
}));

import { PreviewPanel } from '../../../src/renderer/components/PreviewPanel';
import { useAppStore } from '../../../src/renderer/stores/appStore';

// 本地时区构造（不跨时区换算），任何 TZ 下时分字段都是构造值本身。
const V1_PUBLISHED_AT = new Date(2026, 10, 9, 16, 5, 0).getTime(); // 2026-11-09 16:05
const ZH = '2026/11/09 16:05';
const EN = '11/9/2026, 4:05:00 PM';

const TAB: PreviewTab = {
  id: 'preview-test',
  path: '/tmp/prototype.html',
  content: '<button>开始规划行程</button>',
  savedContent: '<button>开始规划行程</button>',
  mode: 'preview',
  lastActivatedAt: 1,
  isLoaded: true,
  kind: 'file',
};

function mockDomainInvoke(): void {
  (window as unknown as { domainAPI: unknown }).domainAPI = {
    invoke: vi.fn(async (_domain: string, action: string) => {
      if (action === 'getPublishInfo') {
        return {
          success: true,
          data: {
            publishState: { kind: 'published', version: 2, publishedAt: V1_PUBLISHED_AT },
            publishedVersions: [
              { version: 2, publishedAt: V1_PUBLISHED_AT },
              { version: 1, publishedAt: V1_PUBLISHED_AT },
            ],
          },
        };
      }
      return null;
    }),
  };
}

beforeEach(() => {
  mockDomainInvoke();
  useAppStore.setState({
    previewTabs: [TAB],
    activePreviewTabId: TAB.id,
    language: 'zh',
    processingSessionIds: new Set(),
  } as never);
});

afterEach(() => {
  delete (window as unknown as { domainAPI?: unknown }).domainAPI;
  cleanup();
});

describe('PreviewPanel 版本菜单历史版本时间（跟随 UI language）', () => {
  it('zh UI：历史版本行为 24 小时制带年份，无 AM/PM', async () => {
    render(<PreviewPanel />);
    await screen.findByTestId('preview-publish-state');
    fireEvent.click(screen.getByRole('button', { name: '版本' }));
    const menu = await screen.findByTestId('preview-version-menu');
    await waitFor(() => {
      expect(menu.textContent).toContain(`v1 ${ZH}`);
    });
    expect(menu.textContent).toContain('当前发布');
    expect(menu.textContent).not.toMatch(/AM|PM/);
  });

  it('en UI：维持 en-US 原样（英文 UI 行为不变）', async () => {
    useAppStore.setState({ language: 'en' });
    render(<PreviewPanel />);
    await screen.findByTestId('preview-publish-state');
    fireEvent.click(screen.getByRole('button', { name: 'Versions' }));
    const menu = await screen.findByTestId('preview-version-menu');
    await waitFor(() => {
      expect(menu.textContent).toContain(`v1 ${EN}`);
    });
    expect(menu.textContent).not.toContain('16:05');
  });
});
