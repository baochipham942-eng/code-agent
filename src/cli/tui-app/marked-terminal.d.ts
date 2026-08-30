// marked-terminal 不带类型声明（v7 双包 ESM/CJS），这里只声明我们用到的最小面
declare module 'marked-terminal' {
  import type { MarkedExtension } from 'marked';
  export function markedTerminal(
    options?: {
      width?: number;
      reflowText?: boolean;
      showSectionPrefix?: boolean;
      emoji?: boolean;
      tab?: number;
    },
    highlightOptions?: Record<string, unknown>,
  ): MarkedExtension;
}
