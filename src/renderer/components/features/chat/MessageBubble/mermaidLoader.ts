// mermaid 是最大的 renderer 依赖(~2.7MB)。它只在消息里出现 mermaid 代码块时才需要,
// 但绝大多数消息没有。此前在 messageContentParts 顶部静态 import,导致每次启动都全量
// 下载+解析,拖慢首屏。改为按需动态 import + 初始化一次,把这 ~2.7MB 移出首屏关键路径。

type MermaidApi = typeof import('mermaid').default;

let instance: MermaidApi | null = null;
let initialized = false;

/** 按需加载并初始化 mermaid(dark 主题),初始化幂等。首次调用才真正下载 chunk。 */
export async function loadMermaid(): Promise<MermaidApi> {
  if (!instance) {
    instance = (await import('mermaid')).default;
  }
  if (!initialized) {
    instance.initialize({
      startOnLoad: false,
      theme: 'dark',
      themeVariables: {
        // ds-allow:start Mermaid 主题，第三方库只吃字面色、不读 app CSS 变量
        darkMode: true,
        background: '#18181b',
        primaryColor: '#3b82f6',
        primaryTextColor: '#e4e4e7',
        primaryBorderColor: '#3f3f46',
        lineColor: '#71717a',
        secondaryColor: '#27272a',
        tertiaryColor: '#1f1f23',
        // ds-allow:end
      },
    });
    initialized = true;
  }
  return instance;
}
