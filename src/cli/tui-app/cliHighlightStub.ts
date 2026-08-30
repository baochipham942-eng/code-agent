/**
 * P1 代码块不做语法高亮：marked-terminal 顶层静态 import cli-highlight，
 * 会拖入 highlight.js + parse5（MB 级）。esbuild alias 把它重定向到这里，
 * 原样返回源码；后续要做高亮时移除 alias 即可。
 */
export function highlight(code: string): string {
  return code;
}
