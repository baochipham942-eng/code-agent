// ============================================================================
// humanizeToolStep — 把工具调用（工具名 + 参数）合成一句人话步骤文案
// 消费方：ToolStepGroup 的步骤行主文案。原工具名/参数继续留在展开详情
// （ToolHeader/ToolDetails）里，本模块只管折叠态那一行给非程序员用户看的话。
// ============================================================================

import { isSemanticToolUIEnabled } from './featureFlags';
import type { Translations } from '../i18n';

const ARG_PREVIEW_MAX = 80;

function takePreview(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= ARG_PREVIEW_MAX) return trimmed;
  return trimmed.slice(0, ARG_PREVIEW_MAX) + '…';
}

function shortenPath(path: string): string {
  if (!path) return '';
  const segments = path.split('/').filter(Boolean);
  if (segments.length <= 2) return path;
  return '.../' + segments.slice(-2).join('/');
}

function firstString(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const preview = takePreview(args[key]);
    if (preview) return preview;
  }
  return '';
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
  | 'skill' | 'screenshot' | 'computerUse' | 'browserAction'
  | 'askUser' | 'memoryStore' | 'memorySearch' | 'unknown';

const READ_TOOLS = new Set(['Read', 'read_file', 'read_pdf', 'read_xlsx', 'ReadDocument']);
const WRITE_TOOLS = new Set(['Write', 'write_file']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'edit_file', 'NotebookEdit', 'notebook_edit']);
const BASH_TOOLS = new Set(['Bash', 'bash', 'Process', 'code_execute']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'academic_search', 'ocr_search']);
const LISTDIR_TOOLS = new Set(['LS', 'list_directory']);
const WEBSEARCH_TOOLS = new Set(['WebSearch']);
const WEBFETCH_TOOLS = new Set(['WebFetch', 'web_fetch', 'http_request', 'screenshot_page', 'twitter_fetch', 'youtube_transcript']);
const SUBAGENT_SPAWN_TOOLS = new Set(['spawn_agent', 'AgentSpawn', 'Task', 'Explore']);
const SUBAGENT_MESSAGE_TOOLS = new Set(['agent_message', 'send_input', 'wait_agent', 'close_agent']);
const TODO_TOOLS = new Set(['todo_write']);
const PLAN_UPDATE_TOOLS = new Set(['plan_update', 'Plan', 'PlanMode']);
const PLAN_READ_TOOLS = new Set(['plan_read']);
const SKILL_TOOLS = new Set(['skill']);
const SCREENSHOT_TOOLS = new Set(['screenshot']);
const COMPUTER_TOOLS = new Set(['computer_use']);
const BROWSER_TOOLS = new Set(['browser_action']);
const ASK_USER_TOOLS = new Set(['AskUserQuestion']);
const MEMORY_STORE_TOOLS = new Set(['memory_store']);
const MEMORY_SEARCH_TOOLS = new Set(['memory_search']);

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
  if (SKILL_TOOLS.has(name)) return 'skill';
  if (SCREENSHOT_TOOLS.has(name)) return 'screenshot';
  if (COMPUTER_TOOLS.has(name)) return 'computerUse';
  if (BROWSER_TOOLS.has(name)) return 'browserAction';
  if (ASK_USER_TOOLS.has(name)) return 'askUser';
  if (MEMORY_STORE_TOOLS.has(name)) return 'memoryStore';
  if (MEMORY_SEARCH_TOOLS.has(name)) return 'memorySearch';
  const mcp = parseMcpName(name);
  if (mcp) return isMessagingMcpTool(mcp.server, mcp.tool) ? 'mcpChannel' : 'mcp';
  return 'unknown';
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

/**
 * 把单个工具调用合成一句步骤人话。模型自写的 shortDescription（产品视角语义标签）
 * 优先级最高——比机械模板更贴近"在干什么"；没有时按工具类目落到对应模板，
 * 未识别的工具兜底"使用了 <工具名>"（不裸露英文工具名之外的黑话）。
 */
export function humanizeToolStep(
  name: string,
  args: Record<string, unknown> | undefined,
  t: Translations,
  shortDescription?: string,
): string {
  if (
    isSemanticToolUIEnabled()
    && typeof shortDescription === 'string'
    && shortDescription.trim().length > 0
  ) {
    return shortDescription.trim();
  }

  const a = args || {};
  const h = t.toolStepHumanize;

  switch (classifyToolName(name)) {
    case 'read': {
      const target = shortenPath(firstString(a, ['file_path', 'path']));
      return target ? h.read.replace('{target}', target) : h.readFallback;
    }
    case 'write': {
      const target = shortenPath(firstString(a, ['file_path', 'path']));
      return target ? h.write.replace('{target}', target) : h.writeFallback;
    }
    case 'edit': {
      const target = shortenPath(firstString(a, ['file_path', 'path']));
      return target ? h.edit.replace('{target}', target) : h.editFallback;
    }
    case 'bash': {
      const command = takePreview(a.command);
      return command ? h.bash.replace('{command}', command) : h.bashFallback;
    }
    case 'search': {
      const query = firstString(a, ['pattern', 'query']);
      return query ? h.search.replace('{query}', query) : h.searchFallback;
    }
    case 'listDir': {
      const target = shortenPath(firstString(a, ['path']));
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
      if (!mcp) return h.fallback.replace('{name}', name);
      const channel = h.channelNames[mcp.server] || mcp.server;
      return h.channelMessage.replace('{channel}', channel);
    }
    case 'mcp': {
      const mcp = parseMcpName(name);
      if (!mcp) return h.fallback.replace('{name}', name);
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
    case 'skill': {
      const skillName = firstString(a, ['skill', 'name']);
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
    default:
      return h.fallback.replace('{name}', name);
  }
}

// ============================================================================
// 多工具聚合（相邻工具调用折叠成一个 tool_group 时的组头文案）
// ponytail: 按大类计数（查看/运行/联网/工具调用/子任务/其它），不细分到具体文件数 vs
// 列表数 vs 搜索数——这层是折叠态的粗粒度概览，细节在展开态每个工具自己的人话行里。
// 需要更细的分类计数时再拆 group 模板。
// ============================================================================

type GroupBucket = 'explored' | 'ran' | 'searchedWeb' | 'mcp' | 'subagent' | 'used';

function groupBucketFor(category: ToolCategory): GroupBucket {
  switch (category) {
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
    default:
      return 'used';
  }
}

/**
 * 把一组相邻工具调用聚合成一句人话概览，例如 "查看了 3 次内容、运行了 1 条命令"。
 */
export function humanizeToolGroupLabel(toolNames: string[], t: Translations): string {
  const counts = new Map<GroupBucket, number>();
  const order: GroupBucket[] = [];
  for (const name of toolNames) {
    const bucket = groupBucketFor(classifyToolName(name));
    if (!counts.has(bucket)) order.push(bucket);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  const g = t.toolStepHumanize.group;
  return order
    .map((bucket) => g[bucket].replace('{count}', String(counts.get(bucket))))
    .join('、');
}
