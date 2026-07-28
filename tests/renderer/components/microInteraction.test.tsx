// ============================================================================
// 微交互锚点测试（2026-07-28 品质感视觉层打磨 ④）
// 拍板：按钮/菜单项 :active 要有 60-100ms 内的下压反馈；浮层入场
// opacity + translateY(4px)，120-150ms ease-out，别瞬现（①的 popover-enter）。
// 发送乐观上屏为既有行为（useAgentIPC 先 addMessage 后 invoke），本文件锚住不回退。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button } from '../../../src/renderer/components/primitives/Button';
import { IconButton } from '../../../src/renderer/components/primitives/IconButton';

const readSrc = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
const globalCss = readSrc('src/renderer/styles/global.css');

describe('按钮 :active 下压', () => {
  it('IconButton 五个 variant 都经 baseStyles 吃到 active:scale-[0.97]', () => {
    const html = renderToStaticMarkup(
      <IconButton aria-label="act" icon={<span aria-hidden="true">A</span>} />,
    );
    expect(html).toContain('active:scale-[0.97]');
  });

  it('Button 保持 active:scale-[0.98] 不回退', () => {
    const html = renderToStaticMarkup(<Button>act</Button>);
    expect(html).toContain('active:scale-[0.98]');
  });

  it('.btn-icon / .list-item 有 :active 下压规则', () => {
    expect(globalCss).toMatch(/\.btn-icon:active\s*\{[^}]*transform:\s*scale\(0\.97\)/);
    expect(globalCss).toMatch(/\.list-item:active\s*\{[^}]*transform:\s*scale\(0\.98\)/);
  });
});

describe('浮层入场动画', () => {
  it('popoverEnter keyframes = opacity + translateY(4px)', () => {
    expect(globalCss).toMatch(/@keyframes popoverEnter\s*\{[^%]*from\s*\{[^}]*opacity:\s*0;[^}]*transform:\s*translateY\(4px\)/);
  });

  it('.popover-enter 时长落在 120-150ms 区间且 ease-out', () => {
    const m = globalCss.match(/\.popover-enter\s*\{\s*animation:\s*popoverEnter\s+(\d+)ms\s+var\(--ease-out\)/);
    expect(m, '.popover-enter 定义缺失或形式不符').not.toBeNull();
    const ms = Number(m![1]);
    expect(ms).toBeGreaterThanOrEqual(120);
    expect(ms).toBeLessThanOrEqual(150);
  });
});

describe('发送乐观上屏不回退', () => {
  it('useAgentIPC 先 addMessage(userMessage) 再发 IPC', () => {
    const src = readSrc('src/renderer/hooks/agent/useAgentIPC.ts');
    const addIdx = src.indexOf('addMessage(userMessage)');
    expect(addIdx, '乐观上屏 addMessage 丢失').toBeGreaterThan(-1);
    const invokeIdx = src.indexOf("invoke(", addIdx);
    expect(invokeIdx, 'addMessage 之后没有 IPC 调用').toBeGreaterThan(addIdx);
  });
});
