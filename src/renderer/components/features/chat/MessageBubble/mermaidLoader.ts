// mermaid 是最大的 renderer 依赖(~2.7MB)。它只在消息里出现 mermaid 代码块时才需要,
// 但绝大多数消息没有。此前在 messageContentParts 顶部静态 import,导致每次启动都全量
// 下载+解析,拖慢首屏。改为按需动态 import + 初始化一次,把这 ~2.7MB 移出首屏关键路径。
import type { MermaidThemeName } from './mermaidTheme';

type MermaidApi = typeof import('mermaid').default;

let instance: MermaidApi | null = null;
// 记的是「上次按哪个主题初始化的」而不是布尔位：主题切换必须能让幂等失效重初始化，
// 否则切到浅色后仍沿用深色配色（N-L5-MERMAIDTHEME：浅色下节点渲染成纯黑块压白底）。
let initializedTheme: MermaidThemeName | null = null;

// ds-allow:start Mermaid 主题，第三方库只吃字面色、不读 app CSS 变量
const THEME_VARIABLES: Record<MermaidThemeName, Record<string, string | boolean>> = {
  dark: {
    darkMode: true,
    background: '#18181b',
    primaryColor: '#3b82f6',
    primaryTextColor: '#e4e4e7',
    primaryBorderColor: '#3f3f46',
    lineColor: '#71717a',
    secondaryColor: '#27272a',
    tertiaryColor: '#1f1f23',
  },
  light: {
    darkMode: false,
    background: '#ffffff',
    primaryColor: '#dbeafe',
    primaryTextColor: '#18181b',
    primaryBorderColor: '#60a5fa',
    lineColor: '#71717a',
    secondaryColor: '#f4f4f5',
    tertiaryColor: '#fafafa',
  },
};
// ds-allow:end

// mermaid 内置主题名：dark 档用 'dark'，light 档用它的 'default'（那才是浅色底）。
const BASE_THEME: Record<MermaidThemeName, 'dark' | 'default'> = { dark: 'dark', light: 'default' };

/** 按需加载并按当前主题初始化 mermaid；同主题内幂等，主题变了会重初始化。 */
export async function loadMermaid(theme: MermaidThemeName = 'dark'): Promise<MermaidApi> {
  if (!instance) {
    instance = (await import('mermaid')).default;
  }
  if (initializedTheme !== theme) {
    instance.initialize({
      startOnLoad: false,
      // 流式中部分代码必然阶段性 parse 失败，禁止 mermaid 往 document.body 插错误炸弹 SVG
      suppressErrorRendering: true,
      theme: BASE_THEME[theme],
      themeVariables: THEME_VARIABLES[theme],
    });
    initializedTheme = theme;
  }
  return instance;
}
