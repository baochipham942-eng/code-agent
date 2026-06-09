// ============================================================================
// cua-driver 操作叙事化（§10 人话文案 + targetContext）
//
// 问题：cua 工具调用到对话页只有图标 + 原始参数（element_index 数字），没人话。
//   `click({element_index:5})` 里的 5 对用户无意义——它的含义在上一步
//   get_window_state 返回的 AX 树里（element 5 = AXButton "7"）。
//
// 方案：AX 树缓存活在 cua-driver MCP server 进程里，Neo 读不到那块内存，所以
//   Neo 自建一份缓存——观察流经的 get_window_state / list_apps / list_windows /
//   launch_app 结果，建 (pid,window_id)→element_index→{role,label} 与 pid→{app,bundle}
//   映射；下一次 click/type_text 调用解析时反查，生成「点击『7』」这种叙事行，
//   并填 targetContext{kind:'app', iconHint:bundleId} 驱动真实 app 图标。
//
// 落点：结果侧 recordCuaResult() 挂在 toolResolver MCP 分支；
//   消费侧 narrateCuaToolCall() 挂在 shared.ts buildToolCallFromAccumulator。
// 详见 docs/proposals/computer-use-cua-migration.md §10。
// ============================================================================

import type { ToolCallTargetContext } from '../../../shared/contract';

/** cua-driver MCP server 标识（去前缀后用于判定）。 */
const CUA_SERVER_SLUG = 'cua-driver';

// 缓存上限：computer-use 任务通常只盯 1~3 个窗口，给足冗余即可，超出按插入序淘汰。
const MAX_WINDOWS = 24;
const MAX_APPS = 64;

interface AxElement {
  role: string;
  label?: string;
}

/** (pid:window_id) → element_index → 元素语义。索引跨快照即失效，故每次快照整体替换。 */
const windowElements = new Map<string, Map<number, AxElement>>();
/** pid → app 身份（名字 + bundleId），驱动文案与 app 图标。 */
const appByPid = new Map<number, { name?: string; bundleId?: string }>();

function evict<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function windowKey(pid: unknown, windowId: unknown): string | null {
  if (typeof pid !== 'number') return null;
  // window_id 可缺省（部分工具只给 pid）；用 'app' 兜底键便于按 app 维度反查 app 身份。
  return `${pid}:${typeof windowId === 'number' ? windowId : 'app'}`;
}

function rememberApp(pid: unknown, name?: unknown, bundleId?: unknown): void {
  if (typeof pid !== 'number') return;
  const prev = appByPid.get(pid) ?? {};
  const next = {
    name: typeof name === 'string' && name ? name : prev.name,
    bundleId: typeof bundleId === 'string' && bundleId ? bundleId : prev.bundleId,
  };
  appByPid.delete(pid);
  appByPid.set(pid, next);
  evict(appByPid, MAX_APPS);
}

// ----------------------------------------------------------------------------
// 结果解析（record 侧）
// ----------------------------------------------------------------------------

/**
 * 从 get_window_state 的 tree_markdown 解析 element_index → {role,label}。
 * 行形如：
 *   - [5] AXButton (7) [id=Seven actions=[press]]      ← 括号 label
 *   - [30] AXMenuItem "About This Mac" [id=...]         ← 引号 label
 *   - [217] AXButton [actions=[press]]                  ← 无 label
 * 非 actionable 节点（无 [N]）跳过。
 */
function parseTreeMarkdown(markdown: string): Map<number, AxElement> {
  const map = new Map<number, AxElement>();
  const lineRe = /\[(\d+)\]\s+(AX\w+)(?:\s+\(([^)]*)\)|\s+"([^"]*)")?/;
  for (const rawLine of markdown.split('\n')) {
    const m = rawLine.match(lineRe);
    if (!m) continue;
    const index = Number(m[1]);
    if (!Number.isInteger(index)) continue;
    const role = m[2];
    const label = (m[3] ?? m[4] ?? '').trim();
    map.set(index, { role, ...(label ? { label } : {}) });
  }
  return map;
}

/** 把工具输出尽量解析成对象（CLI/部分 MCP 返回 JSON），失败返回 null。 */
function tryParseObject(output: string): Record<string, unknown> | null {
  const trimmed = output.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 观察一次 cua 工具结果，更新本地缓存。仅在工具成功时调用。
 * @param toolName 去掉 mcp__cua-driver__ 前缀后的裸工具名（如 'get_window_state'）
 */
export function recordCuaResult(
  toolName: string,
  args: Record<string, unknown>,
  output: string,
): void {
  if (!output) return;
  try {
    switch (toolName) {
      case 'get_window_state':
      case 'get_accessibility_tree': {
        const key = windowKey(args.pid, args.window_id);
        if (!key) return;
        // 优先取 JSON 里的 tree_markdown（已转义还原）；否则把整段输出当 markdown 扫。
        const obj = tryParseObject(output);
        const markdown =
          obj && typeof obj.tree_markdown === 'string' ? obj.tree_markdown : output;
        const elements = parseTreeMarkdown(markdown);
        if (elements.size === 0) return;
        windowElements.delete(key); // 快照整体替换：旧索引作废
        windowElements.set(key, elements);
        evict(windowElements, MAX_WINDOWS);
        return;
      }
      case 'list_apps': {
        const obj = tryParseObject(output);
        const apps = obj && Array.isArray(obj.apps) ? obj.apps : Array.isArray(obj) ? obj : null;
        if (!apps) return;
        for (const app of apps as Array<Record<string, unknown>>) {
          rememberApp(app.pid, app.name, app.bundle_id);
        }
        return;
      }
      case 'list_windows': {
        const obj = tryParseObject(output);
        const wins = obj && Array.isArray(obj.windows) ? obj.windows : null;
        if (!wins) return;
        for (const w of wins as Array<Record<string, unknown>>) {
          rememberApp(w.pid, w.app_name);
        }
        return;
      }
      case 'launch_app': {
        // 结果常含新 pid；bundle_id/name 多来自调用参数。
        const obj = tryParseObject(output);
        const pid = obj && typeof obj.pid === 'number' ? obj.pid : undefined;
        rememberApp(pid ?? args.pid, args.name ?? args.app, args.bundle_id);
        return;
      }
      default:
        return;
    }
  } catch {
    // 叙事化是纯增强，任何解析异常都不得影响工具主流程
  }
}

// ----------------------------------------------------------------------------
// 文案生成（consume 侧）
// ----------------------------------------------------------------------------

function lookupElement(args: Record<string, unknown>): AxElement | undefined {
  const idx = args.element_index;
  if (typeof idx !== 'number') return undefined;
  const key = windowKey(args.pid, args.window_id);
  if (!key) return undefined;
  return windowElements.get(key)?.get(idx);
}

function appTargetContext(args: Record<string, unknown>): ToolCallTargetContext | undefined {
  const pid = args.pid;
  const fromPid = typeof pid === 'number' ? appByPid.get(pid) : undefined;
  const bundleId =
    (typeof args.bundle_id === 'string' && args.bundle_id) || fromPid?.bundleId || undefined;
  const label =
    (typeof args.name === 'string' && args.name) ||
    (typeof args.app === 'string' && args.app) ||
    fromPid?.name ||
    undefined;
  if (!bundleId && !label) return undefined;
  return {
    kind: 'app',
    ...(label ? { label } : {}),
    ...(bundleId ? { iconHint: bundleId } : {}),
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** 把 element 渲染成「『label』」或退化为「元素 N」。 */
function elementPhrase(args: Record<string, unknown>): string {
  const el = lookupElement(args);
  if (el?.label) return `「${truncate(el.label, 24)}」`;
  const idx = args.element_index;
  return typeof idx === 'number' ? `元素 ${idx}` : '目标';
}

/**
 * 把一次 cua 工具调用解析成 { shortDescription, targetContext }。
 * 仅当 toolName 含 cua-driver 时由 shared.ts 调用；非 cua 工具不会进来。
 */
export function narrateCuaToolCall(
  rawToolName: string,
  args: Record<string, unknown>,
): { shortDescription?: string; targetContext?: ToolCallTargetContext } {
  // 去掉 mcp__cua-driver__ 前缀（兼容 mcp_ 单下划线变体）
  const tool = rawToolName.replace(/^mcp_+/, '').replace(new RegExp(`^${CUA_SERVER_SLUG}_+`), '');
  const target = appTargetContext(args);
  const withTarget = (shortDescription: string) => ({
    shortDescription,
    ...(target ? { targetContext: target } : {}),
  });

  switch (tool) {
    case 'click':
      return withTarget(`点击 ${elementPhrase(args)}`);
    case 'double_click':
      return withTarget(`双击 ${elementPhrase(args)}`);
    case 'right_click':
      return withTarget(`右键点击 ${elementPhrase(args)}`);
    case 'type_text':
    case 'set_value': {
      const raw = args.text ?? args.value;
      const text = typeof raw === 'string' ? truncate(raw, 30) : '';
      return withTarget(text ? `在 ${elementPhrase(args)} 输入「${text}」` : `填写 ${elementPhrase(args)}`);
    }
    case 'press_key': {
      const key = typeof args.key === 'string' ? args.key : '';
      return withTarget(key ? `按 ${key}` : '按键');
    }
    case 'hotkey': {
      const keys = Array.isArray(args.keys)
        ? (args.keys as unknown[]).filter((k): k is string => typeof k === 'string')
        : [];
      return withTarget(keys.length ? `按 ${keys.join('+')}` : '按快捷键');
    }
    case 'scroll':
      return withTarget('滚动');
    case 'move_cursor':
      return withTarget('移动光标');
    case 'drag':
      return withTarget('拖拽');
    case 'launch_app': {
      const name = target?.label ?? (typeof args.bundle_id === 'string' ? args.bundle_id : '');
      return withTarget(name ? `打开 ${name}` : '打开应用');
    }
    case 'kill_app': {
      const name = (typeof args.pid === 'number' && appByPid.get(args.pid)?.name) || '';
      return withTarget(name ? `退出 ${name}` : '退出应用');
    }
    case 'bring_to_front':
      return withTarget('切换到应用');
    case 'screenshot':
      return withTarget('截图');
    case 'zoom':
      return withTarget('放大查看');
    case 'get_window_state':
    case 'get_accessibility_tree':
    case 'list_apps':
    case 'list_windows':
    case 'get_screen_size':
    case 'get_cursor_position':
    case 'check_permissions':
      return { shortDescription: '读取界面…' };
    case 'start_recording':
      return { shortDescription: '开始录制操作轨迹' };
    case 'stop_recording':
      return { shortDescription: '停止录制' };
    case 'replay_trajectory':
      return { shortDescription: '回放操作轨迹' };
    default:
      return {};
  }
}

/** 测试用：清空缓存。 */
export function __resetCuaNarrationCache(): void {
  windowElements.clear();
  appByPid.clear();
}
