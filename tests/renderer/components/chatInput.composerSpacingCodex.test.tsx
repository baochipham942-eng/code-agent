import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SendButton } from '../../../src/renderer/components/features/chat/ChatInput/SendButton';

// 2026-07-28 输入框打磨（任务 A）：对齐 Codex composer 参考图的像素扫描值。
// 四个间距：容器下边→app 底部 18.5 / 工具行左右对称 16（2026-08-05 拍板收回 7.5 不对称）/ 下 16.5；
// 按钮：直径 28（h-7 w-7）+ 正圆 + 实心浅色，interrupting/排队/停止/普通 四分支同形态。

const CHAT_INPUT_PATH = resolve(
  __dirname,
  '../../../src/renderer/components/features/chat/ChatInput/index.tsx',
);

describe('SendButton Codex 形态（28px 实心浅色正圆，全状态分支）', () => {
  const cases: Array<[string, Parameters<typeof SendButton>[0]]> = [
    ['interrupting 接入中', { isInterrupting: true }],
    ['处理中+有内容（排队）', { isProcessing: true, hasContent: true }],
    ['处理中+无内容（停止）', { isProcessing: true, hasContent: false }],
    ['普通-可发送', { hasContent: true }],
    ['普通-禁用', { hasContent: false }],
  ];

  it.each(cases)('%s：28px 正圆', (_name, props) => {
    const html = renderToStaticMarkup(React.createElement(SendButton, props));
    expect(html).toContain('h-7');
    expect(html).toContain('w-7');
    expect(html).toContain('rounded-full');
    expect(html).not.toContain('h-9');
    expect(html).not.toContain('rounded-xl');
  });

  // 原分支还断言「实心浅色填充（bg-white）+ 非 bg-brand」，重贴时**刻意不采纳**：
  // 那版写于 2026-07-28，当时只有深色主题，白底按钮很醒目。此后主题批（#936/#941/#946）
  // 铺开四套主题，浅色下 --zinc-900 是 rgb(250,250,250)，白底按钮压在上面约 1.02:1
  // ——等于隐形。配色继续走主题 token，本文件只钉形态，不钉颜色。
  // 颜色的门在 design-system / theme-blind 那两道，不在这里重复表达。

  it.each(cases)('%s：图标随按钮等比缩小，不再用 36px 时代的 h-4', (_name, props) => {
    const html = renderToStaticMarkup(React.createElement(SendButton, props));
    expect(html).toMatch(/h-3(\.5)? w-3(\.5)?/);
    expect(html).not.toContain('h-4 w-4');
  });
});

describe('输入框间距（Codex 参考图像素扫描值）', () => {
  const source = readFileSync(CHAT_INPUT_PATH, 'utf8');

  it('工具行内边距：左右对称 16 / 下 16.5（产品负责人 2026-08-05 拍板回对称——右 7.5 的理由只在发送键显示时成立，静止态右端是语音入口）', () => {
    expect(source).toMatch(/flex items-center gap-1 px-4 pb-\[16\.5px\]/);
  });

  it('容器下边 → app 底部：18.5', () => {
    // 左右内边距已由 px-4 换成 .chat-col-pad（clamp 自适应，同批打磨），这里只钉下边。
    expect(source).toMatch(/chat-col-pad pb-\[18\.5px\] pt-0 transition-colors/);
  });
});
