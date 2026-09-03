// ============================================================================
// MCP 连接态探针（零依赖）
// ============================================================================
// 给「同步路径上只需要一个布尔」的消费方读——典型是每轮组装 toolScope 时判断
// 专家声明的 MCP 连上了没。直接 import mcpClient 会把它那张依赖图（cua / oauth /
// telemetry / windowBridge…）拉进调用方的加载图，为一个判断不值当（#1604 刚因
// 同类问题热修过），而且会把 mcpClient.ts 顶过单文件行数门。
//
// 方向是反的：持有真状态的那一方（MCPClient 模块加载时）把探针塞进来，这里只转发。
// 没人注册过就一律当「没连上」——落到调用方的「都没连上 ⇒ 不收窄」那条安全侧。
// ============================================================================

type McpConnectionProbe = (serverName: string) => boolean;

let probe: McpConnectionProbe | undefined;

export function setMcpConnectionProbe(next: McpConnectionProbe | undefined): void {
  probe = next;
}

export function isMcpServerConnected(serverName: string): boolean {
  return probe?.(serverName) ?? false;
}
