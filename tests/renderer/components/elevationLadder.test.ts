// ============================================================================
// Elevation 层级系统锚点测试（2026-07-28 品质感视觉层打磨 ①）
// 拍板：暗色下层级靠「亮度阶梯 + 投影」，不靠描边。四级阶梯与投影值的唯一真源
// 是 themes/*.css 的 --elevation-l* / --shadow-l* token，global.css 只做组装，
// 组件侧只许消费组装好的类（elevation-l2/l3、composer-elevated、chat-scroll-fade、
// popover-enter），不许再各写一份 bg-zinc-* + shadow-xl。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const readSrc = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

const darkCss = readSrc('src/renderer/styles/themes/dark.css');
const lightCss = readSrc('src/renderer/styles/themes/light.css');
const globalCss = readSrc('src/renderer/styles/global.css');

describe('elevation 四级阶梯 token（dark 主题真源）', () => {
  it.each([
    ['--elevation-l0: #101012', 'L0 底座'],
    ['--elevation-l1: #18181B', 'L1 卡片'],
    ['--elevation-l2: #1F1F23', 'L2 浮层'],
    ['--elevation-l3: #26262B', 'L3 toast/浮动 pill'],
  ])('%s（%s）存在于 dark.css', (token) => {
    expect(darkCss).toContain(token);
  });

  it.each([
    ['--shadow-l2: 0 8px 24px rgba(0, 0, 0, 0.45)', 'L2 投影'],
    ['--shadow-l3: 0 4px 16px rgba(0, 0, 0, 0.5)', 'L3 投影'],
    ['--shadow-composer: 0 4px 24px rgba(0, 0, 0, 0.35)', 'composer 投影'],
  ])('%s（%s）存在于 dark.css', (token) => {
    expect(darkCss).toContain(token);
  });

  it('其余主题定义同名 token（四套主题铺满，token-integrity 门要求）', () => {
    const hcDark = readSrc('src/renderer/styles/themes/high-contrast-dark.css');
    const hcLight = readSrc('src/renderer/styles/themes/high-contrast-light.css');
    for (const [name, css] of [['light.css', lightCss], ['high-contrast-dark.css', hcDark], ['high-contrast-light.css', hcLight]] as const) {
      for (const token of ['--elevation-l0', '--elevation-l1', '--elevation-l2', '--elevation-l3', '--shadow-l2', '--shadow-l3', '--shadow-composer']) {
        expect(css, `${name} 缺 ${token}`).toContain(token);
      }
    }
  });
});

describe('elevation 组装类（global.css）', () => {
  it('.elevation-l2 = L2 底 + hairline + L2 投影', () => {
    expect(globalCss).toMatch(/\.elevation-l2\s*\{[^}]*background-color:\s*var\(--elevation-l2\)/);
    expect(globalCss).toMatch(/\.elevation-l2\s*\{[^}]*box-shadow:\s*var\(--shadow-l2\)/);
  });

  it('.elevation-l3 = L3 底 + hairline + L3 投影', () => {
    expect(globalCss).toMatch(/\.elevation-l3\s*\{[^}]*background-color:\s*var\(--elevation-l3\)/);
    expect(globalCss).toMatch(/\.elevation-l3\s*\{[^}]*box-shadow:\s*var\(--shadow-l3\)/);
  });

  it('.composer-elevated 聚焦时描边微亮', () => {
    expect(globalCss).toMatch(/\.composer-elevated\s*\{[^}]*box-shadow:\s*var\(--shadow-composer\)/);
    expect(globalCss).toMatch(/\.composer-elevated:focus-within\s*\{[^}]*border-color:\s*var\(--border-hover\)/);
  });

  it('.chat-scroll-fade 提供 composer 上方渐隐 mask', () => {
    expect(globalCss).toMatch(/\.chat-scroll-fade\s*\{[^}]*mask-image:\s*linear-gradient/);
  });

  it('.popover-enter 浮层入场动画 + reduced-motion 降级', () => {
    expect(globalCss).toMatch(/\.popover-enter\s*\{[^}]*animation:\s*popoverEnter/);
    expect(globalCss).toMatch(/prefers-reduced-motion:\s*reduce\)\s*\{[^%]*\.popover-enter\s*\{\s*animation:\s*none/);
  });
});

describe('组件侧消费锚点', () => {
  it.each([
    ['src/renderer/components/StatusBar/ModelSwitcher.tsx', 'elevation-l2', '模型菜单'],
    ['src/renderer/components/Toast.tsx', 'elevation-l3', 'toast'],
    ['src/renderer/components/features/chat/ChatInput/index.tsx', 'composer-elevated', 'composer'],
    ['src/renderer/components/features/chat/TurnBasedTraceView.tsx', 'chat-scroll-fade', '聊天滚动渐隐'],
  ])('%s（%s）消费 %s', (file, cls) => {
    expect(readSrc(file)).toContain(cls);
  });

  it('模型菜单不再手搓 bg-zinc-800 + shadow-xl', () => {
    const src = readSrc('src/renderer/components/StatusBar/ModelSwitcher.tsx');
    expect(src).not.toContain('bg-zinc-800 border border-zinc-700 rounded-lg');
  });
});
