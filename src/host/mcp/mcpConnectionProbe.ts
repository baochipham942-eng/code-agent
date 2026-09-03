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

/**
 * turn scope 收窄要的「这台 server 可用吗」判据。
 *
 * 🔴 lazy 要算可用：stdio server 默认 lazyLoad，装好了但状态停在 'lazy' 直到第一次
 * 真被调用（tool 调用走到时会触发 lazy-load）——它是「装好了、用到就连」，和
 * 「没装 / 已关 / 名字写错」不同类。只认 'connected' 的话，收窄在 stdio server 上
 * 一直不生效，又在它被懒加载后的某一轮无声翻转（同一句话两轮工具面不同）。
 * 安全侧不变：状态不存在（没装 / 拼错）、enabled=false、'error' 一律 false ⇒ 不收窄。
 */
export function isMcpStatusUsableForScope(
  status: 'lazy' | 'disconnected' | 'connecting' | 'connected' | 'error' | undefined,
  enabled: boolean,
): boolean {
  if (!status || !enabled) return false;
  return status === 'connected' || status === 'lazy' || status === 'connecting';
}

export function isMcpServerConnected(serverName: string): boolean {
  return probe?.(serverName) ?? false;
}

type InProcessServerIdsProvider = () => string[];

let inProcessProvider: InProcessServerIdsProvider | undefined;

export function setInProcessMcpServerIdsProvider(next: InProcessServerIdsProvider | undefined): void {
  inProcessProvider = next;
}

/**
 * 内置进程内 server（memory-kv / code-index）的名单。
 *
 * 它们是基础设施不是「连接器」：专家声明的 MCP 收窄是背后自动生效的，若把整个
 * MCP 面一刀切，这些 server 会在该专家的**每一轮**里被静默滤掉——用户看到的是
 * 「这个专家突然不会用记忆和代码索引了」，界面无任何提示。收窄时要把它们并回来
 * （与「没连上就不收窄」同一条保护理由：自动生效的东西，代价不该落到用户头上）。
 * 没人注册过就答空表——落到「不并」的保守侧，与探针未注册不收窄同向。
 */
export function getBuiltinInProcessMcpServerIds(): string[] {
  return inProcessProvider?.() ?? [];
}
