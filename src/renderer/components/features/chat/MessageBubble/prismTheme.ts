// prismTheme — 代码块高亮 palette 按当前主题选择。
//
// 主题读取走仓内既有机制:useTheme(hooks/useTheme.ts)把解析后的主题写到
// <html data-theme>,这里用 useSyncExternalStore + MutationObserver 订阅该属性,
// 不新建 theme store。四套 data-theme 的 palette 映射:
//   dark                → oneDark(现状保持)
//   light               → oneLight(react-syntax-highlighter 自带亮色)
//   high-contrast-dark  → a11yDark(自带无障碍主题;全部 token 对 hc-dark 的
//                         --code-bg ≥ 9.9:1,达 WCAG AAA)
//   high-contrast-light → oneLight + 下方 AAA 覆盖(自带亮色主题里最深的
//                         a11y-one-light 未从包 index 导出,且其对 hc-light 的
//                         --code-bg 只有 4.4~6.2:1;故在 oneLight 基础上
//                         把各色 token 换成 AAA(≥7:1)深色,见映射表注释,
//                         对比度由 tests/renderer/components/prismTheme.test.ts 钉死)

import { useSyncExternalStore } from 'react';
import { oneDark, oneLight, a11yDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

export type PrismStyle = typeof oneDark;

// ds-allow:start 语法高亮 AAA 调色板:token 体系无 syntax 分类,此处 hex 是
// 高亮色定义而非 UI 色;每个值对 #F5F5F5 的对比度见行尾注释,由 prismTheme 测试钉死
const HC_LIGHT_AAA_COLORS: Record<string, string> = {
  'hsl(230, 4%, 64%)': '#374151', // comment 类:2.4 → 9.4
  'hsl(35, 99%, 36%)': '#7C2D12', // attr-name/number/constant:3.8 → 8.6
  'hsl(301, 63%, 40%)': '#86198F', // keyword:5.6 → 7.6
  'hsl(5, 74%, 59%)': '#991B1B', // property/tag:3.4 → 7.6
  'hsl(119, 34%, 47%)': '#365314', // string/selector:2.9 → 8.0
  'hsl(221, 87%, 60%)': '#1E40AF', // function/variable:3.7 → 8.0
  'hsl(198, 99%, 37%)': '#164E63', // url:3.8 → 8.4
  'hsl(344, 84%, 43%)': '#9F1239', // template 插值标点:5.2 → 7.4
  'hsl(230, 6%, 44%)': '#374151', // 工具条文字(本组件不渲染,顺手对齐):4.8 → 9.4
  'hsl(230, 1%, 62%)': '#374151', // prism 插件行号(本组件不渲染,顺手对齐):2.5 → 9.4
};
// ds-allow:end

function withAaaColors(base: PrismStyle): PrismStyle {
  return Object.fromEntries(
    Object.entries(base).map(([key, value]) => {
      const color = value && typeof value === 'object' && 'color' in value
        ? (value as { color?: unknown }).color
        : undefined;
      const replacement = typeof color === 'string' ? HC_LIGHT_AAA_COLORS[color] : undefined;
      return [key, replacement ? { ...value, color: replacement } : value];
    }),
  ) as PrismStyle;
}

const highContrastLightStyle = withAaaColors(oneLight);

/** 主题(data-theme 值)→ 高亮 palette。未知/缺省一律回退 oneDark(与仓默认主题一致)。 */
export function getPrismStyleForTheme(theme: string | null): PrismStyle {
  switch (theme) {
    case 'light':
      return oneLight;
    case 'high-contrast-dark':
      return a11yDark;
    case 'high-contrast-light':
      return highContrastLightStyle;
    default:
      return oneDark;
  }
}

const DATA_THEME_FALLBACK = 'dark';

function subscribeDataTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

function getDataTheme(): string {
  return document.documentElement.getAttribute('data-theme') ?? DATA_THEME_FALLBACK;
}

/** 订阅 <html data-theme> 并返回当前主题对应的高亮 palette。 */
export function usePrismStyle(): PrismStyle {
  const theme = useSyncExternalStore(subscribeDataTheme, getDataTheme, () => DATA_THEME_FALLBACK);
  return getPrismStyleForTheme(theme);
}
