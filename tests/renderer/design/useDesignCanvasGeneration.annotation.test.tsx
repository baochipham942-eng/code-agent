// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

const designFiles = vi.hoisted(() => ({
  readWorkspaceImageAsDataUrl: vi.fn(),
}));

vi.mock('../../../src/renderer/components/design/designFiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/components/design/designFiles')>()),
  readWorkspaceImageAsDataUrl: designFiles.readWorkspaceImageAsDataUrl,
}));

import { useDesignCanvasGeneration } from '../../../src/renderer/components/design/useDesignCanvasGeneration';
import { useDesignCanvasStore } from '../../../src/renderer/components/design/designCanvasStore';
import type { CanvasImageNode } from '../../../src/renderer/components/design/designCanvasTypes';
import { ANNOT_COLOR } from '../../../src/renderer/components/design/AnnotationLayer';
import { zh } from '../../../src/renderer/i18n/zh';

const baseNode: CanvasImageNode = {
  id: 'base',
  kind: 'image',
  src: 'assets/base.png',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  createdAt: 1,
};

class LoadedImage {
  naturalWidth = 100;
  naturalHeight = 100;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}

describe('useDesignCanvasGeneration editByAnnotation 付费空调用守卫', () => {
  const invoke = vi.fn();

  beforeEach(() => {
    designFiles.readWorkspaceImageAsDataUrl.mockResolvedValue('data:image/png;base64,AAAA');
    invoke.mockReset();
    vi.stubGlobal('Image', LoadedImage);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      fillStyle: '',
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      arc: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,MASK');
    Object.defineProperty(window, 'domainAPI', {
      configurable: true,
      value: { invoke },
    });
    useDesignCanvasStore.setState({
      runDir: '/tmp/design-run',
      nodes: [baseNode],
      selectedIds: [baseNode.id],
      error: null,
      generating: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useDesignCanvasStore.setState({ runDir: null, nodes: [], selectedIds: [], error: null, generating: false });
  });

  it('只有文字标注时不发 IPC，并置出明确的无区域错误', async () => {
    const { result } = renderHook(() => useDesignCanvasGeneration());

    await act(async () => {
      await result.current.editByAnnotation({
        baseNode,
        instruction: '把这里改成绿色',
        shapes: [{ kind: 'text', x: 20, y: 30, text: '改这里', color: ANNOT_COLOR }],
      });
    });

    expect(designFiles.readWorkspaceImageAsDataUrl).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
    expect(useDesignCanvasStore.getState().error).toBe(zh.design.errAnnotNoRegion);
    expect(useDesignCanvasStore.getState().generating).toBe(false);
  });
});
