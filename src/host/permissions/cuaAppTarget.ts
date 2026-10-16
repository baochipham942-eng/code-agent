// ============================================================================
// cua-driver 原生 MCP 工具（mcp__cua-driver__*）的按应用授权：分类表 + 目标解析。
//
// 生产桌面控制走原生 cua-driver MCP 工具（V2 computer_use 需 CODE_AGENT_CUA_STATE_V2=1
// 才开，默认关），而 extractComputerTargetApp 只认 V2 computer_use——原生工具永远拿
// 不到应用身份，per-app 授权卡（PR #2247）对真实链路不生效。本模块在 host 侧补齐：
//
//   metadata         —— 不面向单个应用，不卡（list_apps / list_windows / …）
//   desktop-read     —— 整桌面读取，无单一应用可归属，留作已知缺口不卡
//   app-content-read —— 读单个应用内容（get_window_state / zoom）。requiresPermission
//                       是 false（CUA_READONLY_TOOLS），必须靠 toolExecutor 的
//                       force flag 进审批链，见 cuaToolNeedsAppGrant。
//   app-action       —— 操控单个应用（click / type_text / launch_app / …）。
//                       表外未知的工具名同样按 app-action 处理（fail closed）。
//
// 应用身份绝不采信模型自报：launch_app 取参数 bundle_id/name；带 pid 的工具用驱动
// list_apps 实时反查（只有 window_id 时退回 list_windows 反查），不做长存活缓存
// （pid 会被复用，cuaNarration 的 pid→app 映射是叙事增强，不是权威）。
// 反查失败 / 既无 pid 又无 window_id：不调驱动，返回给模型的 plain-language 错误。
// 反查记录的读取顺序（0.14.2 实测形状）：structuredContent 优先——驱动的 JSON 记录
// 只在 structuredContent（Neo 经 buildCuaStructuredMetadata 暴露为
// result.metadata.mcpStructuredContent），output 是拼接的 MCP 文本内容、给人读的
// `✅ Found N app(s): …` / `Found N window(s).`；output 恰为 JSON 时作次级 fallback，
// list_apps 的 `- Name (pid N) [bundle]` 文本行作第三源（list_windows 文本无逐窗行）。
// 分类依据 cua-driver 0.14.2（tag cua-driver-rs-v0.14.2）各工具 input_schema 的
// required/properties，证据表见本单证据档 ①。
// ============================================================================

import { MCP_TIMEOUTS } from '../../shared/constants';
import { CUA_DRIVER_SERVER_NAME } from '../mcp/types';
import type { ComputerTargetApp } from './computerAppTarget';

/** 不面向单个应用的工具：桌面/会话元数据、agent cursor、录制状态、驱动自身健康。 */
const METADATA_CUA_TOOLS = new Set([
  'list_apps',
  'list_windows',
  'check_permissions',
  'get_screen_size',
  'get_cursor_position',
  'get_config',
  'set_config',
  'set_agent_cursor_enabled',
  'set_agent_cursor_motion',
  'set_agent_cursor_theme',
  'get_agent_cursor_state',
  'get_recording_state',
  'health_report',
  'check_for_update',
  'start_session',
  'end_session',
  'move_cursor',
]);

/**
 * 整桌面读取：无单一应用可归属，留作已知缺口（证据档 ⑦）不卡。
 * screenshot 在 0.14.2 已从 tools/list 移除（mod.rs #1692），留着兼容旧驱动。
 * get_accessibility_tree 在 0.14.2 无参数、返回整桌面快照（apps+windows），
 * 与任务书把它列为 app-content read 不同——按「读单个应用内容」的判据它落这里。
 */
const DESKTOP_READ_CUA_TOOLS = new Set([
  'get_desktop_state',
  'screenshot',
  'get_accessibility_tree',
]);

// app-content read（get_window_state / zoom，requiresPermission=false）与其余全部
// app action（含未知工具名）同走「需要按应用授权」，判据即 cuaToolNeedsAppGrant：
// 不在 METADATA / DESKTOP_READ 两表内 = fail closed。

const CUA_MCP_TOOL_PREFIX = `mcp__${CUA_DRIVER_SERVER_NAME}__`;

/** 命名空间 MCP 全名 → cua-driver 裸工具名；非 cua-driver 工具返回 null。 */
function parseCuaToolName(executionToolName: string): string | null {
  return executionToolName.startsWith(CUA_MCP_TOOL_PREFIX)
    ? executionToolName.slice(CUA_MCP_TOOL_PREFIX.length)
    : null;
}

/**
 * 需要「按应用授权」的 cua 工具 = app-content read + app action（含表外未知名）。
 * toolExecutor 两个消费点：① force flag 进审批块——app-content read 的
 * requiresPermission=false（CUA_READONLY_TOOLS），原来进不了审批链；② isPreApproved
 * 排除——skill 预授权（allowed-tools 含 mcp__cua-driver__click 等）不得绕过按应用卡。
 */
export function cuaToolNeedsAppGrant(executionToolName: string): boolean {
  const tool = parseCuaToolName(executionToolName);
  if (tool === null) return false;
  return !METADATA_CUA_TOOLS.has(tool) && !DESKTOP_READ_CUA_TOOLS.has(tool);
}

// ----------------------------------------------------------------------------
// 驱动只读反查（可注入，测试替换 mcpClient）
// ----------------------------------------------------------------------------

/** 反查原始返回：output=MCP 文本内容拼接，structured=structuredContent（JSON 记录）。 */
type CuaDriverLookupPayload = {
  output: string | null;
  structured: unknown;
};

type CuaDriverReadLookup = (
  toolName: 'list_apps' | 'list_windows',
  args: Record<string, unknown>,
) => Promise<CuaDriverLookupPayload | null>;

async function defaultCuaDriverReadLookup(
  toolName: 'list_apps' | 'list_windows',
  args: Record<string, unknown>,
): Promise<CuaDriverLookupPayload | null> {
  try {
    // 懒加载：permissions 层不静态依赖 mcpClient，避免 import 环。
    const { getMCPClient } = await import('../mcp/mcpClient');
    const result = await getMCPClient().callTool(
      `cua-app-target:${toolName}:${Date.now()}`,
      CUA_DRIVER_SERVER_NAME,
      toolName,
      args,
      { timeoutMs: MCP_TIMEOUTS.TOOL_RETRY },
    );
    if (!result.success) return null;
    return {
      output: typeof result.output === 'string' ? result.output : null,
      structured: result.metadata?.mcpStructuredContent,
    };
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// 目标解析
// ----------------------------------------------------------------------------

type CuaAppResolution =
  | { kind: 'none' }
  | { kind: 'app'; app: ComputerTargetApp }
  | { kind: 'unresolved'; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** structuredContent → 记录数组（0.14.2 真实形状：{apps|windows: […]}）。 */
function recordsFromStructured(
  structured: unknown,
  key: 'apps' | 'windows',
): Array<Record<string, unknown>> | null {
  if (!isRecord(structured) || !Array.isArray(structured[key])) return null;
  return (structured[key] as unknown[]).filter(isRecord);
}

/** output 恰为 JSON 字符串（裸数组或 {apps|windows: []}）→ 记录数组（次级 fallback）。 */
function recordsFromJsonOutput(output: string | null, key: 'apps' | 'windows'): Array<Record<string, unknown>> | null {
  if (!output) return null;
  const trimmed = output.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.filter(isRecord);
    if (isRecord(parsed) && Array.isArray(parsed[key])) {
      return (parsed[key] as unknown[]).filter(isRecord);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * list_apps 文本行 `- Name (pid N) [bundle]`（platform-macos apps/mod.rs format_app_list，
 * 只列 running 应用，bundle 段可缺）→ 记录数组。output 不是 list_apps 文本时返回 null。
 */
function recordsFromAppListText(output: string | null): Array<Record<string, unknown>> | null {
  if (!output || !/^✅ Found \d+ app\(s\):/m.test(output)) return null;
  const records: Array<Record<string, unknown>> = [];
  for (const rawLine of output.split('\n')) {
    const match = /^- (.+?) \(pid (\d+)\)(?: \[([^\]]+)\])?$/.exec(rawLine.trim());
    if (!match) continue;
    records.push({ name: match[1], pid: Number(match[2]), bundle_id: match[3] });
  }
  return records;
}

/**
 * 反查返回 → 记录数组，三源按优先级：structuredContent（真实 JSON 所在）→ JSON in
 * output（异构/旧驱动）→ list_apps 文本行。全部落空返回 null（按反查不可用处理）。
 */
function parseToolRecords(
  payload: CuaDriverLookupPayload | null,
  key: 'apps' | 'windows',
): Array<Record<string, unknown>> | null {
  return (
    recordsFromStructured(payload?.structured, key)
    ?? recordsFromJsonOutput(payload?.output ?? null, key)
    ?? (key === 'apps' ? recordsFromAppListText(payload?.output ?? null) : null)
  );
}

function appFromPidAndEntry(pid: number, entry: Record<string, unknown> | undefined): ComputerTargetApp | null {
  if (entry?.pid !== pid) return null;
  const name = cleanText(entry.name);
  const bundleId = cleanText(entry.bundle_id);
  if (!name && !bundleId) return null;
  return bundleId ? { name: name ?? bundleId, bundleId } : { name: name as string };
}

function appFromWindowEntry(windowId: number, entry: Record<string, unknown> | undefined): ComputerTargetApp | null {
  if (entry?.window_id !== windowId) return null;
  const name = cleanText(entry.app_name);
  return name ? { name } : null;
}

/**
 * 解析一次 cua-driver 原生工具调用的按应用授权目标。
 * - 非 cua-driver 工具 / metadata / desktop-read → { kind: 'none' }（不卡，不反查）
 * - launch_app → 参数 bundle_id（优先）/ name 直接构成身份
 * - 其余（app-content read + app-action）→ pid 实时反查 list_apps；
 *   只有 window_id 时反查 list_windows
 * - 反查失败 / 既无 pid 又无 window_id → { kind: 'unresolved' }：调用方不得再碰驱动
 */
export async function resolveCuaAppTarget(
  executionToolName: string,
  params: Record<string, unknown> | null | undefined,
  lookup: CuaDriverReadLookup = defaultCuaDriverReadLookup,
): Promise<CuaAppResolution> {
  const tool = parseCuaToolName(executionToolName);
  if (tool === null) return { kind: 'none' };
  if (METADATA_CUA_TOOLS.has(tool) || DESKTOP_READ_CUA_TOOLS.has(tool)) return { kind: 'none' };

  if (tool === 'launch_app') {
    const bundleId = cleanText(params?.bundle_id);
    const name = cleanText(params?.name);
    if (bundleId) return { kind: 'app', app: { name: name ?? bundleId, bundleId } };
    if (name) return { kind: 'app', app: { name } };
    return {
      kind: 'unresolved',
      reason: 'launch_app was NOT performed: neither bundle_id nor name was given, so the app to authorize cannot be identified. Retry with bundle_id (preferred) or name.',
    };
  }

  const pid = typeof params?.pid === 'number' ? params.pid : undefined;
  if (pid !== undefined) {
    const records = parseToolRecords(await lookup('list_apps', {}), 'apps');
    const app = appFromPidAndEntry(pid, records?.find((entry) => entry.pid === pid));
    if (app) return { kind: 'app', app };
    return {
      kind: 'unresolved',
      reason: `This desktop action was NOT performed: pid ${pid} could not be matched to a running app (driver list_apps unavailable, or the process is gone). Call list_apps (read-only, always allowed), confirm the app's pid, then retry with that pid.`,
    };
  }

  const windowId = typeof params?.window_id === 'number' ? params.window_id : undefined;
  if (windowId !== undefined) {
    const records = parseToolRecords(await lookup('list_windows', {}), 'windows');
    const app = appFromWindowEntry(windowId, records?.find((entry) => entry.window_id === windowId));
    if (app) return { kind: 'app', app };
    return {
      kind: 'unresolved',
      reason: `This desktop action was NOT performed: window_id ${windowId} could not be matched to an app (driver list_windows unavailable, or the window is gone). Call list_windows (read-only, always allowed), confirm the window_id, then retry.`,
    };
  }

  return {
    kind: 'unresolved',
    reason: `This desktop action (${tool}) was NOT performed: it names no target app, and global (pid-less) desktop input is not permitted. Call list_apps or list_windows (read-only, always allowed) and retry with pid (or window_id where the tool accepts it).`,
  };
}
