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

// K1 溢出折叠：mock 共享 hook 的测量结果，直接驱动收折态（jsdom 量不到真实宽度）。
// 默认空集 = 全平铺，既有用例不受影响；溢出用例自行往 overflowState 里塞 id。
const overflowState = vi.hoisted(() => ({ overflowed: new Set<string>([]) }));
vi.mock('../../../src/renderer/components/design/useToolbarOverflow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/components/design/useToolbarOverflow')>()),
  useToolbarOverflow: () => ({
    overflowed: overflowState.overflowed,
    itemRef: () => () => {},
  }),
}));

afterEach(() => {
  overflowState.overflowed = new Set<string>([]);
});

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

  it('批注重绘点击进 annotMode 并弹出指令浮层（工具四选 + 成本 + CTA；模型选择已退役）', () => {
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
    ]) {
      expect(popover.textContent).toContain(label);
    }
    // 2026-08-01 B1：mask 通道固定走万相，用户选不了模型——选择器退役，留着就是个不生效的控件。
    expect(popover.querySelector('[data-testid="annot-model-select"]')).toBeNull();
    expect(popover.textContent).not.toContain(zh.design.annotModelSelectLabel);
    // 无标注图形 + 无指令时 CTA 禁用（与原浮层逻辑一致）
    expect((screen.getByTestId('design-annot-redraw-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('无可用标注模型时降级：按钮禁用样式 + 浮层只展示原因，不进 annotMode、无 CTA（返工#4）', () => {
    const props = renderToolbar({
      annotModelUnavailable: true,
    });
    const btn = screen.getByTestId('design-toolbar-annotate');
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.title).toBe(zh.design.annotNoAvailableModel);
    fireEvent.click(btn);
    expect(props.setAnnotMode).not.toHaveBeenCalled();
    const popover = screen.getByTestId('design-annotate-popover');
    expect(popover.textContent).toContain(zh.design.annotNoAvailableModel);
    // 2026-08-01 B1：降级态只留原因说明——模型列表随选择器一起退役（mask 通道固定走万相）
    expect(popover.querySelector('[data-testid="annot-model-select"]')).toBeNull();
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

  it('可行档估一次扩图的钱，点击回传四向 scale（2026-08-01：由两次付费降为一次）', () => {
    const props = renderToolbar({ imageWidth: 1024, imageHeight: 1024 });
    fireEvent.click(screen.getByTestId('design-toolbar-resize'));
    const item = screen.getByTestId('design-resize-preset-9-16');
    // 1024×1024 → 9:16：一次四向扩图，成本 = 1 × ¥0.14。旧实现要两步 ¥0.28，
    // 这条同时钉住「不许再显示两次的价」——回退成两步调用会在这里红。
    expect(item.textContent).toContain('¥0.14');
    expect(item.textContent).toContain('1 次扩图');
    expect(item.textContent).not.toContain('¥0.28');
    fireEvent.click(item);
    expect(props.onResizePreset).toHaveBeenCalledTimes(1);
    const scales = vi.mocked(props.onResizePreset).mock.calls[0][0];
    expect(scales).not.toBeNull();
    if (!scales) throw new Error('应当回传 scales');
    // 变竖版 = 只抬高度两侧，宽度两侧保持 1
    expect(scales.left).toBe(1);
    expect(scales.right).toBe(1);
    expect(scales.top).toBeGreaterThan(1);
    expect(scales.top).toBeCloseTo(scales.bottom, 10);
    for (const v of [scales.top, scales.bottom, scales.left, scales.right]) {
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(2);
    }
    // 选档后菜单关闭
    expect(screen.queryByTestId('design-resize-menu')).toBeNull();
  });

  it('已是目标比例的档位：展示「已是该比例」且不发起调用', () => {
    const props = renderToolbar({ imageWidth: 1024, imageHeight: 1024 });
    fireEvent.click(screen.getByTestId('design-toolbar-resize'));
    const item = screen.getByTestId('design-resize-preset-1-1');
    expect(item.textContent).toContain('已是该比例');
    expect(item.textContent).not.toContain('¥');
    fireEvent.click(item);
    expect(props.onResizePreset).not.toHaveBeenCalled();
  });
});

describe('K1 溢出折叠（收折动词并入「更多 ⋯」同一菜单）', () => {
  it('收折的动词不再平铺，出现在更多菜单顶部「工具」组，文字保留，且只有一个 ⋯', () => {
    overflowState.overflowed = new Set(['resize', 'expand']);
    renderToolbar();
    // 平铺触发器消失
    expect(screen.queryByTestId('design-toolbar-resize')).toBeNull();
    expect(screen.queryByTestId('design-toolbar-expand')).toBeNull();
    fireEvent.click(screen.getByTestId('design-toolbar-more'));
    const menu = screen.getByTestId('design-more-menu');
    // 并入同一个「更多」菜单（顶部「工具」组），文字一律保留
    expect(menu.textContent).toContain(zh.design.moreGroupTools);
    expect(screen.getByTestId('design-overflow-resize').textContent).toContain(zh.design.imageToolbarResize);
    expect(screen.getByTestId('design-overflow-expand').textContent).toContain(zh.design.expandTitle);
    expect(screen.getAllByTestId('design-toolbar-more')).toHaveLength(1);
  });

  it('收折动作可达：点菜单行打开对应下拉（浮层锚到「更多」锚点）', () => {
    overflowState.overflowed = new Set(['resize']);
    renderToolbar();
    fireEvent.click(screen.getByTestId('design-toolbar-more'));
    fireEvent.click(screen.getByTestId('design-overflow-resize'));
    // 更多菜单关闭，调整大小下拉打开（五档齐全）
    expect(screen.queryByTestId('design-more-menu')).toBeNull();
    const menu = screen.getByTestId('design-resize-menu');
    expect(menu.textContent).toContain(zh.design.resizePresetSquare);
    // 浮层锚在「更多」触发按钮的锚点容器内（自己的锚点已不在 DOM）
    expect(menu.parentElement).toBe(screen.getByTestId('design-toolbar-more').parentElement);
  });

  it('批注重绘收折后点击仍进 annotMode 并弹指令浮层', () => {
    overflowState.overflowed = new Set(['annotate']);
    const props = renderToolbar();
    fireEvent.click(screen.getByTestId('design-toolbar-more'));
    fireEvent.click(screen.getByTestId('design-overflow-annotate'));
    expect(props.setAnnotMode).toHaveBeenCalledWith(true);
    expect(screen.getByTestId('design-annotate-popover')).toBeTruthy();
  });

  it('全平铺时更多菜单没有「工具」组', () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId('design-toolbar-more'));
    expect(screen.getByTestId('design-more-menu').textContent).not.toContain(zh.design.moreGroupTools);
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
