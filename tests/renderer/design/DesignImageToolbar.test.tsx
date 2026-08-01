// ============================================================================
// DesignImageToolbar 渲染/交互测试（jsdom）。覆盖 2026-07-31 顶栏语义反转验收点：
// 五动词齐全、调整大小五档（不可行档禁用+原因 / 可行档按实际步数估成本 / 点击回传 steps 顺序）、
// 「更多」对照原 288px 浮层低频动作一个不少、扩图下拉复用 DesignImageEditOps、批注重绘进 annotMode。
// ============================================================================

// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DesignImageToolbar } from '../../../src/renderer/components/design/DesignImageToolbar';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

function renderToolbar(over: Partial<React.ComponentProps<typeof DesignImageToolbar>> = {}) {
  const props: React.ComponentProps<typeof DesignImageToolbar> = {
    t: zh,
    generating: false,
    imageWidth: 1024,
    imageHeight: 1024,
    annotating: false,
    setAnnotating: vi.fn(),
    annotationCount: 0,
    onClearAnnotations: vi.fn(),
    instruction: '',
    setInstruction: vi.fn(),
    onRepaint: vi.fn(),
    onExportImage: vi.fn(),
    onGenerateVideo: vi.fn(),
    onExportPdf: vi.fn(),
    onExportCanvasPptx: vi.fn(),
    exportingPptx: false,
    expandDirection: 'all',
    expandRatio: 1.5,
    onExpandDirectionChange: vi.fn(),
    onExpandRatioChange: vi.fn(),
    onExpand: vi.fn(),
    onRemoveWatermark: vi.fn(),
    onResizePreset: vi.fn(),
    annotMode: false,
    setAnnotMode: vi.fn(),
    annotTool: 'pen',
    setAnnotTool: vi.fn(),
    effectiveAnnotModel: 'wanx2.1-imageedit',
    setAnnotModel: vi.fn(),
    annotAvailability: null,
    annotModelUnavailable: false,
    annotInstruction: '',
    setAnnotInstruction: vi.fn(),
    annotShapeCount: 0,
    onAnnotRedraw: vi.fn(),
    ...over,
  };
  render(<DesignImageToolbar {...props} />);
  return props;
}

afterEach(() => cleanup());

describe('DesignImageToolbar 动词条', () => {
  it('五个动词齐全：批注重绘 / 局部重绘 / 调整大小 / 扩图 / 更多', () => {
    renderToolbar();
    const bar = screen.getByTestId('design-image-toolbar');
    for (const label of [
      zh.design.annotMode,
      zh.design.editRegionBtn,
      zh.design.imageToolbarResize,
      zh.design.expandTitle,
      zh.design.imageToolbarMore,
    ]) {
      expect(bar.textContent).toContain(label);
    }
  });

  it('en 文案也对齐（i18n 两语种均有键）', () => {
    renderToolbar({ t: en });
    const bar = screen.getByTestId('design-image-toolbar');
    for (const label of [
      en.design.annotMode,
      en.design.editRegionBtn,
      en.design.imageToolbarResize,
      en.design.expandTitle,
      en.design.imageToolbarMore,
    ]) {
      expect(bar.textContent).toContain(label);
    }
  });

  it('批注重绘点击进 annotMode 并弹出指令浮层（工具四选 + 模型选择 + 成本 + CTA）', () => {
    const props = renderToolbar();
    fireEvent.click(screen.getByTestId('design-toolbar-annotate'));
    expect(props.setAnnotMode).toHaveBeenCalledWith(true);
    const popover = screen.getByTestId('design-annotate-popover');
    for (const label of [
      zh.design.annotToolPen,
      zh.design.annotToolArrow,
      zh.design.annotToolRect,
      zh.design.annotToolText,
      zh.design.annotInstruction,
      zh.design.costEstimateLabel,
      zh.design.annotModelSelectLabel,
    ]) {
      expect(popover.textContent).toContain(label);
    }
    // 标注模型选择已挪进批注重绘浮层（返工#4：控件跟着它服务的功能走）
    expect(popover.querySelector('[data-testid="annot-model-select"]')).not.toBeNull();
    // 无标注图形 + 无指令时 CTA 禁用（与原浮层逻辑一致）
    expect((screen.getByTestId('design-annot-redraw-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('无可用标注模型时降级：按钮禁用样式 + 浮层只展示原因，不进 annotMode、无 CTA（返工#4）', () => {
    const props = renderToolbar({
      annotModelUnavailable: true,
      effectiveAnnotModel: '',
      annotAvailability: { 'gpt-image-2': false, 'wanx2.1-imageedit': false },
    });
    const btn = screen.getByTestId('design-toolbar-annotate');
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.title).toBe(zh.design.annotNoAvailableModel);
    fireEvent.click(btn);
    expect(props.setAnnotMode).not.toHaveBeenCalled();
    const popover = screen.getByTestId('design-annotate-popover');
    expect(popover.textContent).toContain(zh.design.annotNoAvailableModel);
    // 灰显的模型列表仍在（可见「未配置 Key」），但没有重绘 CTA、没有指令输入
    expect(popover.textContent).toContain(zh.design.imageModelUnconfigured);
    expect(screen.queryByTestId('design-annot-redraw-btn')).toBeNull();
    expect(popover.querySelector('textarea')).toBeNull();
  });
});

describe('菜单锚定触发按钮（2026-08-01 返工#1）', () => {
  it('三个下拉 + 两个浮层都与各自触发按钮同处一个锚点容器（相对定位的父级）', () => {
    renderToolbar();
    const pairs: Array<[string, string]> = [
      ['design-toolbar-annotate', 'design-annotate-popover'],
      ['design-toolbar-repaint', 'design-repaint-popover'],
      ['design-toolbar-resize', 'design-resize-menu'],
      ['design-toolbar-expand', 'design-expand-menu'],
      ['design-toolbar-more', 'design-more-menu'],
    ];
    for (const [triggerId, menuId] of pairs) {
      fireEvent.click(screen.getByTestId(triggerId));
      const trigger = screen.getByTestId(triggerId);
      const menu = screen.getByTestId(menuId);
      // 菜单必须与触发按钮同在一个 relative 锚点容器内（不再挂在整条工具条下共用中心点）
      expect(menu.parentElement).toBe(trigger.parentElement);
      expect(menu.parentElement?.className).toContain('relative');
      expect(menu.className).toContain('left-0');
      expect(menu.className).not.toContain('-translate-x-1/2');
      fireEvent.click(screen.getByTestId(triggerId)); // 收起，给下一对让路
    }
  });
});

describe('调整大小五档', () => {
  it('五档齐全：比例小方块 + 人话名字 + 灰色比例数字', () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId('design-toolbar-resize'));
    const menu = screen.getByTestId('design-resize-menu');
    const names: Array<[string, string]> = [
      ['1-1', zh.design.resizePresetSquare],
      ['3-4', zh.design.resizePresetPortrait],
      ['9-16', zh.design.resizePresetStory],
      ['4-3', zh.design.resizePresetLandscape],
      ['16-9', zh.design.resizePresetWide],
    ];
    for (const [testid, name] of names) {
      expect(screen.getByTestId(`design-resize-preset-${testid}`).textContent).toContain(name);
    }
    for (const ratio of ['1:1', '3:4', '9:16', '4:3', '16:9']) {
      expect(menu.textContent).toContain(ratio);
    }
  });

  it('已是目标比例的档位禁用并提示（1024×1024 → 1:1）', () => {
    renderToolbar({ imageWidth: 1024, imageHeight: 1024 });
    fireEvent.click(screen.getByTestId('design-toolbar-resize'));
    const item = screen.getByTestId('design-resize-preset-1-1');
    expect((item as HTMLButtonElement).disabled).toBe(true);
    expect(item.textContent).toContain(zh.design.resizeAlreadyRatio);
  });

  it('不可行档禁用并显示原因（说人话，无内部机制词），不静默（1000×100 → 1:1 需扩高 10 倍超上限）', () => {
    const props = renderToolbar({ imageWidth: 1000, imageHeight: 100 });
    fireEvent.click(screen.getByTestId('design-toolbar-resize'));
    const item = screen.getByTestId('design-resize-preset-1-1');
    expect((item as HTMLButtonElement).disabled).toBe(true);
    expect(item.textContent).toContain('太扁');
    expect(item.textContent).toContain('超出能力');
    expect(item.textContent).not.toContain('两步对称扩展');
    expect(item.textContent).not.toContain('扩图能力上限');
    fireEvent.click(item);
    expect(props.onResizePreset).not.toHaveBeenCalled();
  });

  it('可行档按实际步数估成本（2 步 = 2 次付费扩图），点击按顺序回传 steps', () => {
    const props = renderToolbar({ imageWidth: 1024, imageHeight: 1024 });
    fireEvent.click(screen.getByTestId('design-toolbar-resize'));
    const item = screen.getByTestId('design-resize-preset-9-16');
    // 1024×1024 → 9:16：两步对称扩高，成本 = 2 × ¥0.14 = ¥0.28，不许只算一次
    expect(item.textContent).toContain('¥0.28');
    expect(item.textContent).toContain('2');
    fireEvent.click(item);
    expect(props.onResizePreset).toHaveBeenCalledTimes(1);
    const steps = vi.mocked(props.onResizePreset).mock.calls[0][0];
    expect(steps).toHaveLength(2);
    expect(steps[0].direction).toBe('up');
    expect(steps[1].direction).toBe('down');
    for (const s of steps) {
      expect(s.ratio).toBeGreaterThanOrEqual(1);
      expect(s.ratio).toBeLessThanOrEqual(2);
    }
    // 选档后菜单关闭
    expect(screen.queryByTestId('design-resize-menu')).toBeNull();
  });
});

describe('扩图下拉与更多菜单', () => {
  it('扩图下拉复用方向五选 + 倍率 + 扩展画布', () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId('design-toolbar-expand'));
    expect(screen.getByTestId('design-image-edit-ops')).toBeTruthy();
    expect(screen.getByTestId('design-expand-dir-all')).toBeTruthy();
    expect(screen.getByTestId('design-expand-ratio')).toBeTruthy();
    fireEvent.click(screen.getByTestId('design-expand-btn'));
    expect(screen.queryByTestId('design-expand-menu')).toBeNull();
  });

  it('更多 ⋯ 对照原 288px 浮层低频动作一个不少，且按用途分组（返工#2）', () => {
    const props = renderToolbar();
    fireEvent.click(screen.getByTestId('design-toolbar-more'));
    const menu = screen.getByTestId('design-more-menu');
    // 组标题：修图 / 导出这张 / 派生 / 整个画布
    for (const group of [
      zh.design.moreGroupEdit,
      zh.design.moreGroupExportThis,
      zh.design.moreGroupDerive,
      zh.design.moreGroupCanvas,
    ]) {
      expect(menu.textContent).toContain(group);
    }
    // 去除水印 / 导出图片 / 导出 PDF / 生成视频 / 导出 PPTX / 标注模型选择（逐项对照 DesignImageEditPanel 原有动作 + 返工#3 收编的画布 PPTX）
    expect(screen.getByTestId('design-more-remove-watermark').textContent).toContain(
      zh.design.removeWatermarkBtn,
    );
    expect(screen.getByTestId('design-more-export-image').textContent).toContain(zh.design.exportImage);
    expect(screen.getByTestId('design-more-export-pdf').textContent).toContain(zh.design.exportImagePdf);
    expect(screen.getByTestId('design-more-generate-video').textContent).toContain(
      zh.design.generateVideoFromImage,
    );
    // 导出 PPTX 在「整个画布」组下（导的是整块画布，不是选中这张）
    const pptxItem = screen.getByTestId('design-more-export-pptx');
    expect(pptxItem.textContent).toContain(zh.design.exportCanvasPptx);
    expect(menu.textContent?.indexOf(zh.design.moreGroupDerive)).toBeLessThan(
      menu.textContent?.indexOf(zh.design.moreGroupCanvas) ?? 0,
    );
    // 标注模型选择已挪出「更多」（返工#4：进批注重绘浮层），更多菜单只剩分组动作
    expect(menu.textContent).not.toContain(zh.design.annotModelSelectLabel);
    expect(menu.querySelector('[data-testid="annot-model-select"]')).toBeNull();
    // 动作可达：点导出图片调用回调并关菜单
    fireEvent.click(screen.getByTestId('design-more-export-image'));
    expect(props.onExportImage).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('design-more-menu')).toBeNull();
  });
});
