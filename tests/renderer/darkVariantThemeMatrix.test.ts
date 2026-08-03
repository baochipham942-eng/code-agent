// @vitest-environment jsdom
// ============================================================================
// dark: 变体 × 四套主题的命中状态矩阵
//
// 2026-08-03 事故：tailwind.config.js 的 darkMode 自定义选择器只有
// [data-theme="dark"]，high-contrast-dark 下 data-theme="high-contrast-dark"，
// 全部 dark: 类（text-blue-700 dark:text-blue-300 这类成对写法）取了浅色分支，
// 深色文字压近黑底。useTheme 给 hc-dark 补挂的 dark class 救不了它——自定义
// 选择器已经替换了默认的 .dark。
//
// 这道测试用真实 tailwind.config.js 编译一条探针类，抠出 dark: 变体实际生成的
// 选择器，再在 jsdom 里按四套主题各自的 data-theme 做元素匹配断言。两真两假，
// 钉的是通则（四套主题全过一遍），不是只钉 hc-dark 一个 case。
// ============================================================================
import { beforeAll, describe, expect, it } from 'vitest';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../..');

let darkVariantSelector: string;
let tempDir: string;

beforeAll(async () => {
  // Tailwind 的 @config 只接受相对/绝对文件路径；在仓库根下建临时目录放入口 CSS
  // （模块解析要能向上找到仓库 node_modules，所以不能放系统临时目录），
  // 绝对路径引用真实 tailwind.config.js——测的就是仓库在用的那份配置。
  tempDir = mkdtempSync(join(REPO_ROOT, '.dark-matrix-'));
  const entry = join(tempDir, 'entry.css');
  writeFileSync(
    entry,
    `@import 'tailwindcss';\n@config '${join(REPO_ROOT, 'tailwind.config.js')}';\n@source inline("dark:underline");`,
  );
  const result = await postcss([tailwind({ base: tempDir })]).process(
    `@import './entry.css';`,
    { from: join(tempDir, 'input.css') },
  );
  // 编译产物形如：.dark\:underline { &:is(<选择器> *) { ... } }
  // 先锚到探针类规则、再在其后抠变体选择器（产物里还有 open:/group: 等别的
  // 变体规则，全局抠会锚错），避免把期望选择器在测试里硬编码第二份。
  // 匹配用 `<选择器> *` 而不是 `:is(<选择器> *)`：单一复杂选择器时两者语义等价，
  // 而 jsdom 的 nwsapi 不支持嵌套 :is()。
  const probeRuleAt = result.css.indexOf('.dark\\:underline');
  expect(probeRuleAt, '编译产物里必须有探针类 dark:underline 的规则').toBeGreaterThanOrEqual(0);
  const match = result.css.slice(probeRuleAt).match(/&:is\((.+?) \*\)\s*\{/);
  expect(match, '探针类规则里必须找得到 dark: 变体的嵌套选择器').not.toBeNull();
  darkVariantSelector = `${match![1]} *`;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('dark: 变体命中矩阵（四套主题全钉）', () => {
  // 与 useTheme.ts 的 ResolvedTheme 一一对应：data-theme 就是 resolvedTheme。
  it.each([
    ['dark', true],
    ['high-contrast-dark', true],
    ['light', false],
    ['high-contrast-light', false],
  ] as const)('data-theme=%s 时 dark: 命中 = %s', (theme, expected) => {
    document.documentElement.setAttribute('data-theme', theme);
    const probe = document.createElement('div');
    document.body.appendChild(probe);
    expect(probe.matches(darkVariantSelector)).toBe(expected);
    probe.remove();
    document.documentElement.removeAttribute('data-theme');
  });
});
