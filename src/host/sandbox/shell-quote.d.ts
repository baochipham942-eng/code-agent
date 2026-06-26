// 本地最小类型声明：项目未安装 @types/shell-quote。
// 仅声明本模块用到的 quote()。完整 API 见 https://github.com/ljharb/shell-quote
declare module 'shell-quote' {
  /** 将 argv 数组拼成可安全交给 shell 解析的单条命令字符串。 */
  export function quote(args: ReadonlyArray<string>): string;
}
