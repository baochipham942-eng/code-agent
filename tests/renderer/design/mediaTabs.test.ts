// 设计 tab 媒介聚合层（4 媒介：网页/图/演示稿/视频）的纯映射逻辑单测。
// 守护「图」聚合 mockup+infographic、切媒介保留子类、往返一致等核心 IA 约束。
import { describe, it, expect } from 'vitest';
import { outputToMedia, mediaToOutput, type DesignMedia } from '../../../src/renderer/components/design/DesignWorkspace';
import type { DesignOutputType } from '../../../src/renderer/components/design/designTypes';

describe('设计媒介聚合映射', () => {
  it('outputToMedia：mockup/infographic 同属「图」', () => {
    expect(outputToMedia('mockup')).toBe('image');
    expect(outputToMedia('infographic')).toBe('image');
  });

  it('outputToMedia：其余各自独立媒介', () => {
    expect(outputToMedia('prototype')).toBe('web');
    expect(outputToMedia('slides')).toBe('slides');
    expect(outputToMedia('video')).toBe('video');
  });

  it('mediaToOutput：切到「图」时保留当前图子类（infographic 不被重置成 mockup）', () => {
    expect(mediaToOutput('image', 'infographic')).toBe('infographic');
    expect(mediaToOutput('image', 'mockup')).toBe('mockup');
  });

  it('mediaToOutput：从非图切到「图」默认落设计稿', () => {
    expect(mediaToOutput('image', 'prototype')).toBe('mockup');
    expect(mediaToOutput('image', 'video')).toBe('mockup');
    expect(mediaToOutput('image', 'slides')).toBe('mockup');
  });

  it('mediaToOutput：网页/演示稿/视频直达对应产物', () => {
    expect(mediaToOutput('web', 'mockup')).toBe('prototype');
    expect(mediaToOutput('slides', 'mockup')).toBe('slides');
    expect(mediaToOutput('video', 'mockup')).toBe('video');
  });

  it('往返一致：每个 outputType 经 media 再回映射，媒介稳定', () => {
    const all: DesignOutputType[] = ['prototype', 'mockup', 'infographic', 'slides', 'video'];
    for (const ot of all) {
      const media: DesignMedia = outputToMedia(ot);
      // 回映射后媒介不变（图子类在同媒介内允许保留）
      expect(outputToMedia(mediaToOutput(media, ot))).toBe(media);
    }
  });
});
