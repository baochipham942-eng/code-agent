import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  PresentationPreview,
  parseDesignPptArtifactContent,
} from '../../../src/renderer/components/PreviewPanel';

const artifactJson = JSON.stringify({
  version: 1,
  kind: 'design_ppt',
  title: 'deck.pptx',
  topic: '新能源汽车趋势',
  theme: 'dark',
  outputPath: '/out/deck.pptx',
  screenshots: ['/out/deck.screenshots/slide-1.png', '/out/deck.screenshots/slide-2.png'],
  slidesCount: 5,
  iterations: 1,
  createdAt: '2026-06-25T00:00:00.000Z',
});

const outlineJson = JSON.stringify({
  filePath: '/out/deck.pptx',
  format: 'pptx',
  slideCount: 5,
  shownCount: 5,
  truncated: false,
  slides: [{ index: 1, name: 'slide1.xml', title: '封面', text: ['标题'] }],
});

describe('PPTX 预览：有截图走可视预览，无则 fallback 大纲', () => {
  it('parseDesignPptArtifactContent 识别 design_ppt 截图产物，拒绝大纲/空截图/垃圾', () => {
    expect(parseDesignPptArtifactContent(artifactJson)?.screenshots.length).toBe(2);
    expect(parseDesignPptArtifactContent(outlineJson)).toBeNull();
    expect(
      parseDesignPptArtifactContent(JSON.stringify({ kind: 'design_ppt', screenshots: [] })),
    ).toBeNull();
    expect(parseDesignPptArtifactContent('not-json')).toBeNull();
  });

  it('有截图时渲染图片缩略图，而不是「PPTX outline」大纲文本', () => {
    const html = renderToStaticMarkup(<PresentationPreview content={artifactJson} />);
    expect(html).toContain('<img');
    expect(html).toContain('slide-1.png');
    expect(html).not.toContain('PPTX 大纲');
  });

  it('无截图产物时仍渲染「PPTX outline」大纲（fallback 不回归）', () => {
    const html = renderToStaticMarkup(<PresentationPreview content={outlineJson} />);
    expect(html).toContain('PPTX 大纲');
    expect(html).toContain('封面');
  });
});
