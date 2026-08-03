// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// DesignCanvasZoomControls（2026-08-01 K2）：右下角缩放控件——
// 读数跟随 camera.scale；读数点开档位菜单（25/50/100/200 + 自定义输入），
// 选中 = 以视口中心为锚点缩放；范围与滚轮缩放同源（clamp 0.1–5）；适配视口走 onFit。
// ---------------------------------------------------------------------------
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { DesignCanvasZoomControls } from '../../../src/renderer/components/design/DesignCanvasZoomControls';
import type { CanvasCamera } from '../../../src/renderer/components/design/designCanvasTypes';

afterEach(cleanup);

const camera = (scale: number, x = 0, y = 0): CanvasCamera => ({ x, y, scale });
const viewport = { w: 800, h: 600 };

function renderControls(cam: CanvasCamera = camera(1)) {
  const onCameraChange = vi.fn();
  const onFit = vi.fn();
  render(
    <DesignCanvasZoomControls
      camera={cam}
      viewport={viewport}
      onCameraChange={onCameraChange}
      onFit={onFit}
    />,
  );
  return { onCameraChange, onFit };
}

describe('DesignCanvasZoomControls（K2）', () => {
  it('读数跟随 camera.scale 实时更新', () => {
    const { onCameraChange, onFit } = renderControls(camera(0.68));
    expect(screen.getByTestId('design-canvas-zoom-readout').textContent).toContain('68%');

    cleanup();
    render(
      <DesignCanvasZoomControls
        camera={camera(1.5)}
        viewport={viewport}
        onCameraChange={onCameraChange}
        onFit={onFit}
      />,
    );
    expect(screen.getByTestId('design-canvas-zoom-readout').textContent).toContain('150%');
  });

  it('读数是入口：点开出现 25/50/100/200 档位 + 自定义输入', () => {
    renderControls();
    expect(screen.queryByTestId('design-canvas-zoom-menu')).toBeNull();

    fireEvent.click(screen.getByTestId('design-canvas-zoom-readout'));

    expect(screen.getByTestId('design-canvas-zoom-menu')).toBeTruthy();
    for (const p of [25, 50, 100, 200]) {
      expect(screen.getByTestId(`design-canvas-zoom-preset-${p}`)).toBeTruthy();
    }
    expect(screen.getByTestId('design-canvas-zoom-input')).toBeTruthy();
  });

  it('点选档位：以视口中心为锚点缩放到对应比例，菜单收起', () => {
    // 视口 800x600，当前 scale=1、camera=(0,0)：中心锚定的世界点 = (400,300)。
    const { onCameraChange } = renderControls(camera(1));

    fireEvent.click(screen.getByTestId('design-canvas-zoom-readout'));
    fireEvent.click(screen.getByTestId('design-canvas-zoom-preset-50'));

    expect(onCameraChange).toHaveBeenCalledWith({ scale: 0.5, x: 200, y: 150 });
    expect(screen.queryByTestId('design-canvas-zoom-menu')).toBeNull();
  });

  it('自定义输入：回车应用并夹在合法范围（与滚轮同源 0.1–5）', () => {
    const { onCameraChange } = renderControls(camera(1));

    fireEvent.click(screen.getByTestId('design-canvas-zoom-readout'));
    const input = screen.getByTestId('design-canvas-zoom-input');
    fireEvent.change(input, { target: { value: '133' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onCameraChange).toHaveBeenCalledWith({ scale: 1.33, x: 400 - 400 * 1.33, y: 300 - 300 * 1.33 });

    // 超出上限（>500%）夹到 5；低于 10% 夹到 0.1。
    onCameraChange.mockClear();
    fireEvent.click(screen.getByTestId('design-canvas-zoom-readout'));
    const input2 = screen.getByTestId('design-canvas-zoom-input');
    fireEvent.change(input2, { target: { value: '9999' } });
    fireEvent.keyDown(input2, { key: 'Enter' });
    expect(onCameraChange).toHaveBeenCalledWith({ scale: 5, x: 400 - 400 * 5, y: 300 - 300 * 5 });
  });

  it('适配视口按钮调用 onFit', () => {
    const { onFit } = renderControls();
    fireEvent.click(screen.getByTestId('design-canvas-zoom-fit'));
    expect(onFit).toHaveBeenCalledTimes(1);
  });

  it('菜单开着时点控件外部收起', () => {
    renderControls();
    fireEvent.click(screen.getByTestId('design-canvas-zoom-readout'));
    expect(screen.getByTestId('design-canvas-zoom-menu')).toBeTruthy();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('design-canvas-zoom-menu')).toBeNull();
  });
});
