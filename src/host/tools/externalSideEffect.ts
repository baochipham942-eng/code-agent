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
