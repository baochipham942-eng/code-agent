// ============================================================================
// External side-effect risk classification (B1 — EXTERNAL 一等风险类)
// ============================================================================
// 「对外可见副作用」= 产生离开本机、发出去收不回效果的工具调用（发邮件、发 IM 消息）。
// 与 permissionLevel（read/write/execute/network）正交：一个工具可以同时是 network + external
// （如 IM 类 MCP）。本判据不改变任何审批/放行行为（B1），只打标；下游消费：
//   - B2 无人值守停车挂起：EXTERNAL 工具在无人值守下停车挂起等待人工审批
//   - B4 target 粒度长期授权：EXTERNAL 工具按 target（收件人/频道）授权
//
// 标注面按 Neo 显式清单（native 工具白名单 + IM MCP server 白名单），不信第三方 MCP 自报。
// 首版只收「发出去收不回」的出站工具；绝不误伤只读联网——webSearch/webFetch 是 network
// 读、不是 external。宁可漏标（EXTERNAL 候选见下方注释）也不错标（错标会造成无人值守审批风暴）。

import { normalizeToolName } from './toolNames';

/** decisionTrace 里 EXTERNAL 打标步骤的 rule / reason（供 toolExecutor 复用，B2/B4/审计读取）。 */
export const EXTERNAL_SIDE_EFFECT_TRACE_RULE = 'external_side_effect';
export const EXTERNAL_SIDE_EFFECT_TRACE_REASON =
  '对外可见副作用工具（EXTERNAL 风险类；B2 无人值守停车 / B4 target 授权判据）';

/**
 * Native 工具白名单：产生对外可见副作用的内置工具。
 * - mail_send：真发邮件。
 * v1 刻意不收（宁可漏标）：mail_draft（只存草稿不发送）、calendar_create/update/delete_event
 * （发邀请是对外副作用，但需按 attendees 参数细分，留待后续期）、github_pr（开 PR 对外可见，
 * 后续期评估）。新增出站类 native 工具在这里补一条。
 */
const EXTERNAL_SIDE_EFFECT_TOOLS = new Set<string>([
  'mail_send',
]);

/**
 * 即时通讯类 MCP server 白名单（server 名与 renderer/utils/humanizeToolStep.ts 的
 * MESSAGING_MCP_SERVERS 一致；两层各持一份，改动时同步）。ponytail: 名字启发式而非精确
 * schema 判定——命中 server 且工具名是「出站发送」动作才判 EXTERNAL；新增 IM 类 MCP server
 * 在这里补一条。
 */
const MESSAGING_MCP_SERVERS = new Set(['lark', 'feishu', 'slack', 'telegram']);

/**
 * IM 出站发送动作模式：只收真正「发出去」的调用，绝不误伤读消息/列频道（im_chat_list、
 * message_list、users_info 等）。humanizeToolStep 的显示启发式（message|_im_|^im_|send）在这里
 * 太宽（会把 im_chat_list 当发消息），对 EXTERNAL 风险类会造成无人值守审批风暴——宁可漏标不错标。
 * 命中：send_message / sendMessage / chat_postMessage / im_v1_message_create / message_reply。
 * 不命中：im_chat_list / message_list / message_get。
 */
const MESSAGING_SEND_PATTERN = /send|post.*message|message.*(?:create|reply)|(?:create|reply).*message/i;

/** 解析 MCP 工具名（现行 mcp__server__tool，历史遗留 mcp_server_tool），与 mcpToolRegistry 同款口径。 */
function parseMcpToolName(fullName: string): { server: string; tool: string } | null {
  if (fullName.startsWith('mcp__')) {
    const rest = fullName.slice('mcp__'.length);
    const idx = rest.indexOf('__');
    if (idx <= 0 || idx + 2 >= rest.length) return null;
    return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) };
  }
  const legacy = fullName.match(/^mcp_([^_]+)_(.+)$/);
  if (legacy) return { server: legacy[1], tool: legacy[2] };
  return null;
}

/**
 * 判定一个工具是否为「对外可见副作用」（EXTERNAL 风险类）。
 *
 * 这是 B2（无人值守停车挂起）/ B4（target 粒度长期授权）与审计的统一判据。
 * 只依赖工具名（Neo 显式清单），不改变任何审批/放行行为。
 */
export function isExternalSideEffectTool(toolName: string): boolean {
  if (EXTERNAL_SIDE_EFFECT_TOOLS.has(normalizeToolName(toolName))) return true;
  const mcp = parseMcpToolName(toolName);
  if (mcp && MESSAGING_MCP_SERVERS.has(mcp.server.toLowerCase())) {
    return MESSAGING_SEND_PATTERN.test(mcp.tool);
  }
  return false;
}

// ============================================================================
// B4 target 提取：只有能确定性提取 target 的 external 工具才有铸权资格
// ============================================================================
// 铸权铁律（逐条守）：target 是白名单精确串，无 glob 无前缀模糊——提取不到就返回 null
// （该调用不具备铸权资格，回退每次询问）。绝不猜字段：宁可漏（回退询问）不可错（错字段
// = 授权面失控/提权）。每个 external 工具在这里显式登记一个提取器；没登记的（哪怕 external）
// 一律不具资格。exec/写文件等非 external 工具永远走不到这里（调用方先过 isExternalSideEffectTool）。

/** 归一化一组收件人/目标为稳定精确串：去空、去重、排序后 join。集合不同即不同 target。 */
function normalizeTargetSet(value: unknown): string | null {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,\n;]/)
      : [];
  const items = [...new Set(
    list
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean),
  )].sort();
  return items.length > 0 ? items.join(',') : null;
}

/**
 * 从入参里取一个标量目标字段。lark-mcp 形如 { params:{receive_id_type}, data:{receive_id} }，
 * 模型也常把它们摊平到顶层——顶层、data.<key>、params.<key> 三处都探（先到先得）。
 */
function readScalarField(params: Record<string, unknown>, key: string): string | null {
  const pick = (obj: unknown): string | null => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const v = (obj as Record<string, unknown>)[key];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };
  return pick(params) ?? pick(params.data) ?? pick(params.params);
}

/**
 * 逐工具白名单式 target 提取器。key = 归一化工具名（native）或 MCP 工具名后缀匹配。
 * 每条只处理它认得的入参形状，取不到返回 null。
 */
function extractNativeTarget(toolName: string, params: Record<string, unknown>): string | null {
  switch (toolName) {
    case 'mail_send':
      // 收件人集合（to）为 target；cc/bcc 不纳入 key（面向「发给谁」，cc 变体不该各自铸权）。
      return normalizeTargetSet(params.to);
    default:
      return null;
  }
}

/**
 * IM 出站发送的 target = 收件人/频道 id。lark-mcp@0.5.1 的 im.v1.message.create 入参
 * 形如 { params:{receive_id_type}, data:{receive_id,...} }，模型常摊平——两处都探。
 * 把 receive_id_type 纳入 key：同一 id 在 open_id/chat_id 语义不同，绝不跨类型复用授权。
 * ponytail: 仅认 receive_id 这一约定字段；其它 IM server（slack/telegram）字段不同、
 * 当前无人值守下也不可达，先不登记（漏 = 回退询问，安全）。
 */
function extractMessagingTarget(tool: string, params: Record<string, unknown>): string | null {
  const receiveId = readScalarField(params, 'receive_id');
  if (!receiveId) return null;
  const idType = readScalarField(params, 'receive_id_type');
  return idType ? `${idType}:${receiveId}` : receiveId;
}

/**
 * 提取一个 external 工具调用的授权 target 精确串，取不到返回 null（不具铸权资格）。
 * 调用方必须先确认 isExternalSideEffectTool(toolName)——本函数不重复判 external，
 * 只负责「这个 external 工具的 target 怎么取」。
 */
export function extractStandingGrantTarget(
  toolName: string,
  params: Record<string, unknown>,
): string | null {
  const native = extractNativeTarget(normalizeToolName(toolName), params);
  if (native) return native;
  const mcp = parseMcpToolName(toolName);
  if (mcp && MESSAGING_MCP_SERVERS.has(mcp.server.toLowerCase()) && MESSAGING_SEND_PATTERN.test(mcp.tool)) {
    return extractMessagingTarget(mcp.tool, params);
  }
  return null;
}
