import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DocumentBlock } from '../../../src/renderer/components/features/chat/MessageBubble/DocumentBlock';

const spec = JSON.stringify({
  title: '季度报告',
  wordCount: 12,
  paragraphs: [
    { index: 0, type: 'heading', text: '一、总体情况', level: 1 },
    { index: 1, type: 'paragraph', text: '本季度营收同比增长两成。' },
  ],
});

// 动作条上的按钮文案（i18n zh）——用来判断"可编辑假象"在不在。
const ACTION_PROBE = '重写';

describe('DocumentBlock filePath 门禁', () => {
  it('没有源文件时不给任何可编辑假象', () => {
    const html = renderToStaticMarkup(<DocumentBlock spec={spec} />);
    // 正文照常渲染（证明不是整个组件没渲染导致的假绿）
    expect(html).toContain('本季度营收同比增长两成。');
    // 但不给光标手型 —— 段落"看起来能点"本身就是假承诺的一部分
    expect(html).not.toContain('cursor-pointer');
  });

  it('有源文件时段落可交互', () => {
    const html = renderToStaticMarkup(<DocumentBlock spec={spec} filePath="/tmp/report.docx" />);
    expect(html).toContain('本季度营收同比增长两成。');
    expect(html).toContain('cursor-pointer');
  });

  it('动作条在无源文件时不渲染（SSR 下未选中段落，两种情况都不该出现）', () => {
    const withoutPath = renderToStaticMarkup(<DocumentBlock spec={spec} />);
    expect(withoutPath).not.toContain(ACTION_PROBE);
  });
});
