// ============================================================================
// humanizeToolStep — 把工具调用（工具名 + 参数）合成一句人话步骤文案
// 消费方：ToolStepGroup 的步骤行主文案 + ToolHeader。原工具名/参数继续留在展开详情
// 次级小字里，本模块管折叠态那一行给非程序员用户看的话。
// ============================================================================

import { isSemanticToolUIEnabled } from './featureFlags';
import { formatDisplayPath } from './displayPath';
import type { Translations } from '../i18n';
import type { ToolCallTargetContext } from '@shared/contract';

const ARG_PREVIEW_MAX = 80;

function takePreview(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= ARG_PREVIEW_MAX) return trimmed;
  return trimmed.slice(0, ARG_PREVIEW_MAX) + '…';
}

/** 路径专用：不走 takePreview 尾部截断，交给 formatDisplayPath 做中段省略 */
function firstPath(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    // 清理偶发的参数串扰（file_path 后带 offset/limit）
    const cleaned = trimmed.includes(' offset=') || trimmed.includes(' limit=')
      ? trimmed.split(' ')[0]
      : trimmed;
    return formatDisplayPath(cleaned);
  }
  return '';
}

function firstString(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const preview = takePreview(args[key]);
    if (preview) return preview;
  }
  return '';
}

/**
 * 从工具参数里取完整文件路径（未做展示截断），供点击打开预览。
 * 读/写/编类工具共用。
 */
export function getToolFilePath(
  name: string,
  args: Record<string, unknown> | undefined,
): string | null {
  if (!args) return null;
  const category = classifyToolName(name);
  if (category !== 'read' && category !== 'write' && category !== 'edit' && category !== 'listDir') {
    return null;
  }
  for (const key of ['file_path', 'path']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) {
      const trimmed = value.trim();
      return trimmed.includes(' offset=') || trimmed.includes(' limit=')
        ? trimmed.split(' ')[0]
        : trimmed;
    }
  }
  return null;
}

// mcp 工具命名：现行 mcp__server__tool（双下划线），历史遗留 mcp_server_tool（单下划线），
// 与 ToolCallDisplay/utils.ts 的 formatMcpServerName 同款解析口径。
function parseMcpName(name: string): { server: string; tool: string } | null {
  if (name.startsWith('mcp__')) {
    const rest = name.slice('mcp__'.length);
    const idx = rest.indexOf('__');
    if (idx > 0) return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) };
    return null;
  }
  const legacy = name.match(/^mcp_([^_]+)_(.+)$/);
  if (legacy) return { server: legacy[1], tool: legacy[2] };
  return null;
}

// 已知即时通讯类 MCP server：命中 + 工具名带 message/im/send 关键字才判定为"发消息"这一更
// 具体的人话，其余 MCP 调用一律走通用"调用了 X 的 Y"。
// ponytail: 名字启发式而非精确 schema 判定；新增即时通讯类 MCP server 需要在这里补一条。
const MESSAGING_MCP_SERVERS = new Set(['lark', 'feishu', 'slack', 'telegram']);

function isMessagingMcpTool(server: string, tool: string): boolean {
  if (!MESSAGING_MCP_SERVERS.has(server)) return false;
  return /message|_im_|^im_|send/i.test(tool);
}

type ToolCategory =
  | 'read' | 'write' | 'edit' | 'bash' | 'search' | 'listDir'
  | 'webSearch' | 'webFetch' | 'mcpChannel' | 'mcp'
  | 'subagentSpawn' | 'subagentMessage' | 'todo' | 'planUpdate' | 'planRead'
  | 'taskManager' | 'skill' | 'screenshot' | 'computerUse' | 'browserAction'
  | 'askUser' | 'memoryStore' | 'memorySearch' | 'toolSearch' | 'unknown';

const READ_TOOLS = new Set(['Read', 'read_file', 'read_pdf', 'read_xlsx', 'ReadDocument']);
const WRITE_TOOLS = new Set(['Write', 'write_file']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'edit_file', 'NotebookEdit', 'notebook_edit']);
// terminal_write 归 bash 档：它就是「往终端敲了一条命令」，聊天里必须显示敲了什么
// （本批「注入对用户可见」红线在会话侧的那一半）。只读的 terminal_read/list/wait
// 不并进来——它们不是「运行了命令」，混进 ran 桶会谎报动作。
const BASH_TOOLS = new Set(['Bash', 'bash', 'Process', 'code_execute', 'terminal_write']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'academic_search', 'ocr_search']);
const LISTDIR_TOOLS = new Set(['LS', 'list_directory']);
const WEBSEARCH_TOOLS = new Set(['WebSearch']);
const WEBFETCH_TOOLS = new Set(['WebFetch', 'web_fetch', 'http_request', 'screenshot_page', 'twitter_fetch', 'youtube_transcript']);
const SUBAGENT_SPAWN_TOOLS = new Set(['spawn_agent', 'AgentSpawn', 'Task', 'Explore']);
const SUBAGENT_MESSAGE_TOOLS = new Set(['agent_message', 'send_input', 'wait_agent', 'close_agent']);
const TODO_TOOLS = new Set(['todo_write']);
const PLAN_UPDATE_TOOLS = new Set(['plan_update', 'Plan', 'PlanMode']);
const PLAN_READ_TOOLS = new Set(['plan_read']);
// TaskManager：会话任务清单统一入口（create/list/update/replace/patch）
const TASK_MANAGER_TOOLS = new Set(['TaskManager']);
// Skill 工具 schema 名是 PascalCase `Skill`；历史小写也认
const SKILL_TOOLS = new Set(['skill', 'Skill']);
const SCREENSHOT_TOOLS = new Set(['screenshot']);
const COMPUTER_TOOLS = new Set(['computer_use']);
const BROWSER_TOOLS = new Set(['browser_action']);
const ASK_USER_TOOLS = new Set(['AskUserQuestion']);
const MEMORY_STORE_TOOLS = new Set(['memory_store']);
const MEMORY_SEARCH_TOOLS = new Set(['memory_search']);
// ToolSearch：工具目录检索，对用户零意义的纯内部动作，不进主流聚合行
const TOOL_SEARCH_TOOLS = new Set(['ToolSearch', 'tool_search']);

function classifyToolName(name: string): ToolCategory {
  if (READ_TOOLS.has(name)) return 'read';
  if (WRITE_TOOLS.has(name)) return 'write';
  if (EDIT_TOOLS.has(name)) return 'edit';
  if (BASH_TOOLS.has(name)) return 'bash';
  if (SEARCH_TOOLS.has(name)) return 'search';
  if (LISTDIR_TOOLS.has(name)) return 'listDir';
  if (WEBSEARCH_TOOLS.has(name)) return 'webSearch';
  if (WEBFETCH_TOOLS.has(name)) return 'webFetch';
  if (SUBAGENT_SPAWN_TOOLS.has(name)) return 'subagentSpawn';
  if (SUBAGENT_MESSAGE_TOOLS.has(name)) return 'subagentMessage';
  if (TODO_TOOLS.has(name)) return 'todo';
  if (PLAN_UPDATE_TOOLS.has(name)) return 'planUpdate';
  if (PLAN_READ_TOOLS.has(name)) return 'planRead';
  if (TASK_MANAGER_TOOLS.has(name)) return 'taskManager';
  if (SKILL_TOOLS.has(name)) return 'skill';
  if (SCREENSHOT_TOOLS.has(name)) return 'screenshot';
  if (COMPUTER_TOOLS.has(name)) return 'computerUse';
  if (BROWSER_TOOLS.has(name)) return 'browserAction';
  if (ASK_USER_TOOLS.has(name)) return 'askUser';
  if (MEMORY_STORE_TOOLS.has(name)) return 'memoryStore';
  if (MEMORY_SEARCH_TOOLS.has(name)) return 'memorySearch';
  if (TOOL_SEARCH_TOOLS.has(name)) return 'toolSearch';
  const mcp = parseMcpName(name);
  if (mcp) return isMessagingMcpTool(mcp.server, mcp.tool) ? 'mcpChannel' : 'mcp';
  return 'unknown';
}

/**
 * 纯内部动作：不出现在用户可见主流聚合行（可进展开明细次级小字）。
 * 口径对齐「Bash/Read 执行流水不进上下文」——对用户零意义的运行时动作。
 */
export function isInternalStreamTool(name: string): boolean {
  return classifyToolName(name) === 'toolSearch';
}

/**
 * 展开明细次级小字：原始工具名（仅在展开态露出，不进主行）。
 */
export function toolNameForDetail(name: string): string {
  return name;
}

/**
 * cua-driver / browser_action 类"动作型"工具的人话：{verb} {action} {target}。
 * 沿用既有格式（tests/renderer/utils/toolStepGrouping.browserComputer.test.ts 钉死的输出）。
 */
function buildActionSentence(verb: string, args: Record<string, unknown>): string {
  const action = takePreview(args.action);
  if (!action) return verb;
  const rawAction = typeof args.action === 'string' ? args.action : '';
  const isTypingAction = rawAction === 'type' || rawAction === 'smart_type';
  const target = takePreview(
    isTypingAction
      ? args.selector ?? args.targetApp ?? args.role ?? args.name
      : args.selector ?? args.url ?? args.text ?? args.key ?? args.role ?? args.targetApp,
  );
  return target ? `${verb} ${action} ${target}` : `${verb} ${action}`;
}

const CJK_PATTERN = /[㐀-䶿一-鿿豈-﫿]/;

/**
 * shortDescription 是模型自写的自由文本，语种不受控（工具 schema 里给的示例本身
 * 就是英文），实测会在中文界面上原样上屏、还被 CSS 截成半句英文。
 * 语种与界面不一致时判定不可用，退回本地化模板。
 * 判据从 t 自己取（拿一条已知译文当界面语种的样本），不新增参数——调用方漏传
 * 就静默失去保护的门不算门。
 * ponytail: 只按"有没有汉字"分两种字形，不做真正的语种识别；新增非拉丁语界面
 * 时这里会把汉字描述判为不匹配，退模板，仍然安全。
 */
function matchesUiScript(text: string, t: Translations): boolean {
  return CJK_PATTERN.test(t.toolStepHumanize.writeFallback) === CJK_PATTERN.test(text);
}

/**
 * 把单个工具调用合成一句步骤人话。模型自写的 shortDescription（产品视角语义标签）
 * 优先级最高——比机械模板更贴近"在干什么"；没有（或语种与界面不一致）时按工具
 * 类目落到对应模板。
 *
 * 未识别工具兜底把工具名带进主行（「MemoryWrite 执行了一个步骤」）——纯占位文案
 * 在失败时没有任何信息量。例外只有 isInternalStreamTool 命中的纯内部动作
 * （ToolSearch 这类），它们的主行仍不暴露内部名（只在展开明细次级小字）。
 *
 * failed=true（toolCall.result 已存在且 success===false）时，写/编类目不再输出过去时
 * 肯定式（「写入了/编辑了」）——它会与状态词「写入失败/编辑失败」同屏自相矛盾；
 * 改用意图式中性表述（「写入 X」），结果语义交给状态词表达。进行中/成功场景文案不变。
 */
export function humanizeToolStep(
  name: string,
  args: Record<string, unknown> | undefined,
  t: Translations,
  shortDescription?: string,
  failed?: boolean,
): string {
  if (
    isSemanticToolUIEnabled()
    && typeof shortDescription === 'string'
    && shortDescription.trim().length > 0
    && matchesUiScript(shortDescription.trim(), t)
  ) {
    return shortDescription.trim();
  }

  const a = args || {};
  const h = t.toolStepHumanize;

  switch (classifyToolName(name)) {
    case 'read': {
      const target = firstPath(a, ['file_path', 'path']);
      return target ? h.read.replace('{target}', target) : h.readFallback;
    }
    case 'write': {
      const target = firstPath(a, ['file_path', 'path']);
      if (failed) return target ? h.writeIntent.replace('{target}', target) : h.writeIntentFallback;
      return target ? h.write.replace('{target}', target) : h.writeFallback;
    }
    case 'edit': {
      const target = firstPath(a, ['file_path', 'path']);
      if (failed) return target ? h.editIntent.replace('{target}', target) : h.editIntentFallback;
      return target ? h.edit.replace('{target}', target) : h.editFallback;
    }
    case 'bash': {
      // terminal_write 把命令放在 input 里，不是 command
      const command = takePreview(a.command ?? a.input);
      return command ? h.bash.replace('{command}', command) : h.bashFallback;
    }
    case 'search': {
      const query = firstString(a, ['pattern', 'query']);
      return query ? h.search.replace('{query}', query) : h.searchFallback;
    }
    case 'listDir': {
      const target = firstPath(a, ['path']);
      return target ? h.listDir.replace('{target}', target) : h.listDirFallback;
    }
    case 'webSearch': {
      const query = takePreview(a.query);
      return query ? h.webSearch.replace('{query}', query) : h.webSearchFallback;
    }
    case 'webFetch': {
      const target = takePreview(a.url);
      return target ? h.webFetch.replace('{target}', target) : h.webFetchFallback;
    }
    case 'mcpChannel': {
      const mcp = parseMcpName(name);
      if (!mcp) return h.fallback;
      const channel = h.channelNames[mcp.server] || mcp.server;
      return h.channelMessage.replace('{channel}', channel);
    }
    case 'mcp': {
      const mcp = parseMcpName(name);
      if (!mcp) return h.fallback;
      return h.mcpTool.replace('{server}', mcp.server).replace('{tool}', mcp.tool);
    }
    case 'subagentSpawn': {
      const description = firstString(a, ['description', 'prompt', 'task', 'goal', 'role']);
      return description
        ? h.subagentSpawn.replace('{description}', description)
        : h.subagentSpawnFallback;
    }
    case 'subagentMessage':
      return h.subagentMessage;
    case 'todo':
      return h.todo;
    case 'planUpdate':
      return h.planUpdate;
    case 'planRead':
      return h.planRead;
    case 'taskManager':
      return h.taskManager;
    case 'skill': {
      // Skill schema 用 command 传技能名；历史/别名可能用 skill / name
      const skillName = firstString(a, ['command', 'skill', 'name']);
      return skillName ? h.skill.replace('{skill}', skillName) : h.skillFallback;
    }
    case 'screenshot':
      return h.screenshot;
    case 'computerUse':
      return buildActionSentence(h.computerUse, a);
    case 'browserAction':
      return buildActionSentence(h.browserAction, a);
    case 'askUser':
      return h.askUser;
    case 'memoryStore':
      return h.memoryStore;
    case 'memorySearch':
      return h.memorySearch;
    case 'toolSearch':
      // 仅用于展开明细；主流聚合行会过滤 isInternalStreamTool
      return h.toolSearch;
    default: {
      // 「内部工具名绝不进主行」这条规矩只针对 isInternalStreamTool（ToolSearch 这类
      // 对用户零意义的纯内部动作）——不是一刀切到所有未识别工具。
      if (isInternalStreamTool(name)) return h.fallback;
      // 其余未识别工具：把工具名带进主行。否则失败时用户面对一句纯占位
      // 「执行了一个步骤」，得展开才知道是 MemoryWrite 还是别的、为什么失败。
      return h.fallbackWithTool.replace('{tool}', name);
    }
  }
}

// ============================================================================
// 多工具聚合（相邻工具调用折叠成一个 tool_group 时的组头文案）
// 动词桶 + 计数（Claude Code 式）。纯内部动作（ToolSearch）不进主流。
// ============================================================================

type GroupBucket = 'explored' | 'ran' | 'searchedWeb' | 'mcp' | 'subagent' | 'planned' | 'skill' | 'used';

function groupBucketFor(category: ToolCategory): GroupBucket | null {
  switch (category) {
    case 'toolSearch':
      // 主流不计数
      return null;
    case 'read':
    case 'write':
    case 'edit':
    case 'listDir':
    case 'search':
    case 'memorySearch':
      return 'explored';
    case 'bash':
      return 'ran';
    case 'webSearch':
    case 'webFetch':
      return 'searchedWeb';
    case 'mcp':
    case 'mcpChannel':
      return 'mcp';
    case 'subagentSpawn':
    case 'subagentMessage':
      return 'subagent';
    case 'todo':
    case 'planUpdate':
    case 'planRead':
    case 'taskManager':
      return 'planned';
    case 'skill':
      return 'skill';
    default:
      return 'used';
  }
}

/**
 * 把一组相邻工具调用聚合成一句人话概览，例如 "查看了 3 次内容、运行了 1 条命令"。
 * ToolSearch 等纯内部动作被过滤，不进主流聚合语。
 * 若过滤后无可见工具，返回空串（调用方应不渲染主流行 / 整组）。
 */
export function humanizeToolGroupLabel(toolNames: string[], t: Translations): string {
  const counts = new Map<GroupBucket, number>();
  const order: GroupBucket[] = [];
  for (const name of toolNames) {
    const bucket = groupBucketFor(classifyToolName(name));
    if (!bucket) continue;
    if (!counts.has(bucket)) order.push(bucket);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  if (order.length === 0) return '';

  const g = t.toolStepHumanize.group;
  return order
    .map((bucket) => g[bucket].replace('{count}', String(counts.get(bucket))))
    .join('、');
}

// ============================================================================
// targetContext 推导（2026-08-07）
// ============================================================================
// 原来这个字段是让模型在 `_meta` 里填的。真库数据说它不该由模型填：
//   - 它渲染出来是 TargetContextIcon 里**由 kind 唯一决定的一个 12px 图标**，
//     `label` 只进 aria-label、从不作为可见文字出现；
//   - 模型给 18 个工具里的 7 个填出自相矛盾的 kind（Bash→file/app、
//     WebSearch→browser/mcp_server、AskUserQuestion→app/file/memory）；
//   - 而它填对的那 11 个，全是从工具名就能推出来的。
// 所以改成这里推导，模型侧的 schema 与提示词同步删掉（省 ~1.8K token/请求）。
//
// 复用上面的 classifyToolName，**不新建工具名表**——新工具进了那边的集合，
// 这边自动跟上；没进的落到 'unknown' → 返回 undefined（无图标）。
// 2026-07 起 5357 次真实调用实测：browser 36.9% / file 27.0% / mcp_server 0.5%，
// 其余 35.5% 无图标。无图标是正确行为，不是缺口——Bash 的目标是一条命令，
// 不是可图标化的实体，那正是 shortDescription 存在的理由。
//
// app kind 刻意不在这里推：它是唯一带真信息的 kind（NSWorkspace 真 app logo），
// 需要 bundleId，由宿主的 cuaNarration 推导后写进 ToolCall，这里不抢。
// ============================================================================

const TOOL_CATEGORY_TO_TARGET_KIND: Partial<Record<ToolCategory, ToolCallTargetContext['kind']>> = {
  read: 'file',
  write: 'file',
  edit: 'file',
  search: 'file',
  listDir: 'file',
  webSearch: 'browser',
  webFetch: 'browser',
  browserAction: 'browser',
  screenshot: 'browser',
  mcp: 'mcp_server',
  mcpChannel: 'mcp_server',
  memoryStore: 'memory',
  memorySearch: 'memory',
};

/** label 只进 aria-label（屏幕阅读器），不作为可见文字渲染。 */
function targetLabelFor(
  kind: ToolCallTargetContext['kind'],
  name: string,
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (kind === 'mcp_server') return parseMcpName(name)?.server;
  if (kind === 'file') {
    const path = getToolFilePath(name, args) ?? firstPath(args ?? {}, ['file_path', 'path', 'pattern']);
    if (!path) return undefined;
    return path.split('/').filter(Boolean).pop() || path;
  }
  if (kind === 'browser') {
    const url = firstString(args ?? {}, ['url']);
    if (!url) return undefined;
    try {
      return new URL(url).hostname || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * 从工具名 + 入参推 targetContext。推不出来返回 undefined——**不许兜底成某个
 * kind**，`TargetContextIcon` 拿不到 kind 就不渲染，那是正确行为。
 */
export function deriveToolTargetContext(
  name: string,
  args: Record<string, unknown> | undefined,
): ToolCallTargetContext | undefined {
  const kind = TOOL_CATEGORY_TO_TARGET_KIND[classifyToolName(name)];
  if (!kind) return undefined;
  const label = targetLabelFor(kind, name, args);
  return label ? { kind, label } : { kind };
}
