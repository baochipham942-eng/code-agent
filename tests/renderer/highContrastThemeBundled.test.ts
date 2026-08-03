// ============================================================================
// 高对比主题的 token 定义必须真的进构建，不只是躺在磁盘上。
//
// 2026-08-02 实测：`high-contrast-dark.css` / `high-contrast-light.css` 两个文件从写出来
// 那天起**就没被任何地方 import**——`global.css` 只 import 了 dark/light 两套。于是：
//   - 文件在磁盘上，看起来"做了"；
//   - design-system 门**直接读磁盘文件**验对比度，一直报「16.75:1 达标 / 11.22:1 达标」；
//   - 但它们从不进构建产物，选中高对比只会得到一个没有 token 定义的裸状态。
//
// **门在给一个永远不进包的文件发合格证。** 这道测试补的就是那个缺口：不验对比度
// （那是 design-system 门的活），只验「这两套 CSS 确实被接进了样式入口」。
//
// 为什么钉在 global.css 的 @import 上而不是钉构建产物：跑一次 vite build 要几十秒，
// 而 @import 是唯一的接入点——掉了它构建产物必然缺 token（实测撤掉 import 后包里
// `high-contrast-dark` 从 19 处降到 10 处，剩下的 10 处全是别处源码对该 class 的**引用**，
// 定义块整个消失）。钉入口既准又快。
// ============================================================================
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const GLOBAL_CSS = join(__dirname, '../../src/renderer/styles/global.css');

describe('主题 CSS 接入样式入口', () => {
  const css = readFileSync(GLOBAL_CSS, 'utf8');

  it.each([
    'themes/dark.css',
    'themes/light.css',
    'themes/high-contrast-dark.css',
    'themes/high-contrast-light.css',
  ])('global.css 必须 @import %s', (relPath) => {
    // 只认真实的 @import 语句，不认注释里提到的路径——注释提一句不会让它进包。
    const importLines = css
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('@import'));

    expect(importLines.some((line) => line.includes(relPath))).toBe(true);
  });

  it('四套主题一个都不少——新增主题必须同步接进来', () => {
    // 防「加了第五套主题、CSS 写好了、又忘了 import」重演。以磁盘上的 themes/*.css
    // 为准反查入口，而不是维护一份手写清单（手写清单本身就会漏）。
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    const themeFiles = readdirSync(join(__dirname, '../../src/renderer/styles/themes'))
      .filter((name) => name.endsWith('.css'));

    expect(themeFiles.length).toBeGreaterThan(0);
    const missing = themeFiles.filter((name) => !css.includes(`themes/${name}`));
    expect(missing).toEqual([]);
  });
});
