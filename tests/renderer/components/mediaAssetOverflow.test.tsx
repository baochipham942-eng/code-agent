// @vitest-environment jsdom
// 对话图产物按钮条的**固定折叠规则**（2026-08-02 产品负责人拍板）：
// 任何宽度下都只露「修改 + 复制」，查看/打开/保存/Finder 恒进 ⋯。
//
// 为什么不是宽度自适应：这条按钮组全部调用点都传 compact（28px 纯图标），
// 6 个连间距才 ~188px，任何气泡都放得下——「按实测宽度折叠」会退化成「永不折叠」，
// 等于拍板没落地。本测试就是钉死这一点：谁把宽度自适应改回来，这里必须红。
//
// 探针纪律：jsdom 里所有 offsetWidth 恒为 0。若实现回到宽度自适应，
// 量不到宽度的兜底恰恰是「全展开」——所以「四个动作不在条上」这条断言
// 在自适应实现下必然失败，不会假绿。
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  MediaAssetActionBar,
  MEDIA_ASSET_OVERFLOW_IDS,
} from '../../../src/renderer/components/features/chat/MessageBubble/MediaAssetControls';
import type { SessionMediaAsset } from '../../../src/shared/utils/sessionMediaAssets';

vi.mock('../../../src/renderer/utils/platform', () => ({
  copyPathToClipboard: vi.fn(),
  isWebMode: () => false,
}));

// path 齐全的图产物 ⇒ 四个可折叠动作全部可用（lightbox 还需传 onOpenLightbox）。
const asset = {
  assetId: 'a1',
  sessionId: 's1',
  turnId: 't1',
  messageId: 'm1',
  source: 'markdown',
  role: 'output',
  sources: [{ source: 'markdown', role: 'output' }],
  kind: 'image',
  state: 'ready',
  path: '/tmp/x/pic.png',
  filename: 'pic.png',
} as unknown as SessionMediaAsset;

const renderBar = (): void => {
  render(<MediaAssetActionBar asset={asset} onOpenLightbox={() => {}} compact />);
};

afterEach(cleanup);

describe('对话图产物按钮条：固定折叠规则', () => {
  it('条上只有 修改 + 复制 + ⋯，四个次要动作一个都不直接露出', () => {
    renderBar();

    // 常驻的两个主动作在场——正对照：它俩要是也不在，说明组件根本没渲染出来，
    // 下面「四个不在场」的断言就是假绿。
    expect(screen.getByTestId('media-asset-edit-in-canvas')).toBeTruthy();
    expect(screen.getByTitle('复制引用')).toBeTruthy();

    // ⋯ 必须在场
    expect(screen.getByTestId('media-asset-overflow-more')).toBeTruthy();

    // 四个次要动作不能作为条上按钮出现（菜单未展开时它们根本不该被渲染）
    for (const title of ['放大查看', '打开', '保存', '在 Finder 中显示']) {
      expect(screen.queryByTitle(title)).toBeNull();
    }
  });

  it('点开 ⋯ 后四个动作都在菜单里，且顺序与常量一致', () => {
    renderBar();
    fireEvent.click(screen.getByTestId('media-asset-overflow-more'));

    const ids = MEDIA_ASSET_OVERFLOW_IDS.map((id) =>
      screen.getByTestId(`media-asset-overflow-${id}`),
    );
    expect(ids).toHaveLength(4);
    // 菜单项带文字，不降级成纯图标（compact 只作用于条上按钮）
    expect(screen.getByTestId('media-asset-overflow-reveal').textContent).toContain('Finder');
  });

  it('可折叠域的常量不含常驻动作，顺序即菜单顺序', () => {
    expect([...MEDIA_ASSET_OVERFLOW_IDS]).toEqual(['lightbox', 'open', 'save', 'reveal']);
    expect(MEDIA_ASSET_OVERFLOW_IDS).not.toContain('edit');
    expect(MEDIA_ASSET_OVERFLOW_IDS).not.toContain('copy');
  });
});
