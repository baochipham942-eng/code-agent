// ============================================================================
// MCP 派发前参数归一化
//
// 目的：把「模型摆参数的已知姿势坑」焊成确定性，避免每次调用都赌模型摆对。
// 只在检测到确切错位时改写入参，其余原样透传；非命中工具零改动。
//
// 落点在 mcpClient.callTool（唯一 chokepoint）：主 ToolExecutor 的命名空间工具、
// unified `mcp` 工具、subagent 快速路径、cua driver 四条调用路径全汇聚于此，
// 且此处拿到的已是解包后的 (serverName, toolName, 真实工具入参)。
// ============================================================================

type Args = Record<string, unknown>;

function isPlainObject(value: unknown): value is Args {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 飞书 bitable.v1.appTableField.list 的工具名（lark-mcp@0.5.1，点号形态）。
// 这是被修的那个 bug 的身份标识，刻意用本地字面量而不引白名单常量：
// 白名单表达的是"允许哪些只读工具"，与"哪个工具有 path 错位坑"是两件事。
const FEISHU_FIELD_LIST_TOOL = 'bitable.v1.appTableField.list';
const FEISHU_PATH_KEYS = ['app_token', 'table_id'] as const;

/**
 * 飞书 appTableField.list 的 zod schema 要求 path={app_token, table_id}（必填，
 * 与好使的 appTableRecord.search 逐字节相同），但模型在纯 GET-list 上常把
 * app_token/table_id 拍平到顶层、或塞进 params，丢掉 path 外壳，触发 zod 拒。
 * 这里把这俩键重新包回 path。
 *
 * 只在检测到错位时动手：已在 path 里的键不覆盖，两键都摆对时整体 no-op。
 * 上下文无关，任何拓扑都安全。
 */
function renestFeishuFieldListPath(args: Args): Args {
  const path = isPlainObject(args.path) ? { ...args.path } : {};
  const params = isPlainObject(args.params) ? { ...args.params } : undefined;
  const top: Args = { ...args };
  let changed = false;

  for (const key of FEISHU_PATH_KEYS) {
    if (path[key] !== undefined) continue; // 已在 path 里，别覆盖
    if (top[key] !== undefined) {
      path[key] = top[key];
      delete top[key];
      changed = true;
    } else if (params && params[key] !== undefined) {
      path[key] = params[key];
      delete params[key];
      changed = true;
    }
  }

  if (!changed) return args;
  top.path = path;
  if (params) top.params = params;
  return top;
}

interface NormalizeRule {
  appliesTo(serverName: string, toolName: string): boolean;
  normalize(args: Args): Args;
}

// 归一化规则表。每条规则最小可用，别为一条规则建过度框架。
// 匹配只看 toolName（lark-mcp 的全限定名全局唯一、不会与他源撞），不硬绑 serverName——
// 用户可能把飞书 server 改名，绑死 serverName 会让重命名后静默失效；且 normalize 本身
// 在参数已摆对时是 no-op，即便误命中也无副作用。serverName 仍留在签名里供未来规则用。
const RULES: NormalizeRule[] = [
  {
    appliesTo: (_serverName, toolName) => toolName === FEISHU_FIELD_LIST_TOOL,
    normalize: renestFeishuFieldListPath,
  },
];

/**
 * 派发前对 MCP 工具入参做确定性归一化。非命中工具原样返回同一引用。
 */
export function normalizeMcpToolArgs(serverName: string, toolName: string, args: Args): Args {
  let next = args;
  for (const rule of RULES) {
    if (rule.appliesTo(serverName, toolName)) {
      next = rule.normalize(next);
    }
  }
  return next;
}
