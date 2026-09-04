// 本地最小类型声明：项目未安装 @types/shell-quote。
// 仅声明本仓使用的 quote()/parse()。完整 API 见 https://github.com/ljharb/shell-quote
declare module 'shell-quote' {
  export type ParseEntry = string
    | { op: string; pattern?: string }
    | { comment: string };

  /** 将 argv 数组拼成可安全交给 shell 解析的单条命令字符串。 */
  export function quote(args: ReadonlyArray<string>): string;

  /** 解析 shell 词边界与控制操作符；env 回调用于保留变量字面量。 */
  export function parse(
    command: string,
    env?: Record<string, string | undefined> | ((key: string) => string | object | undefined),
  ): ParseEntry[];
}
