// ============================================================================
// Deferred Tools Configuration - 延迟工具配置
// ============================================================================

import type { DeferredToolMeta } from '../../../shared/types/toolSearch';
import type { ToolTag } from '../../../shared/types/tool';

/**
 * 核心工具列表
 * 这些工具始终发送给模型，无需通过 tool_search 发现
 */
export const CORE_TOOLS: string[] = [
  // Gen 1: 基础文件操作
  'Bash',
  'Read',
  'Write',
  'Edit',

  // Gen 2: 代码搜索
  'Glob',
  'Grep',
  'ListDirectory',

  // Gen 3: 规划和任务
  'TaskManager',
  // 'TodoWrite', // 已移除
  'AskUserQuestion',

  // Gen 4: 网络搜索
  'WebSearch',

  // Light Memory (File-as-Memory)
  'MemoryWrite',
  'MemoryRead',

  // 工具发现
  'ToolSearch',

  // Skill 元工具（始终可见，动态描述聚合可用 skills）
  'Skill',
];

/**
 * 延迟工具元数据
 * 用于搜索匹配，不包含完整的工具定义
 */
export const DEFERRED_TOOLS_META: DeferredToolMeta[] = [
  // ============================================================================
  // Gen 1: 扩展 Shell 工具
  // ============================================================================
  {
    name: 'notebook_edit',
    shortDescription: '编辑 Jupyter Notebook 单元格',
    tags: ['file', 'document'],
    aliases: ['jupyter', 'notebook', 'ipynb'],
    source: 'builtin',
  },

  // ============================================================================
  // Gen 3: 扩展规划工具
  // ============================================================================
  {
    name: 'Task',
    shortDescription: '启动子代理执行复杂任务',
    tags: ['planning', 'multiagent'],
    aliases: ['subagent', 'agent'],
    source: 'builtin',
  },
  {
    name: 'confirm_action',
    shortDescription: '请求用户确认危险操作',
    tags: ['planning'],
    aliases: ['confirm', 'approve'],
    source: 'builtin',
  },
  {
    name: 'read_clipboard',
    shortDescription: '读取系统剪贴板内容',
    tags: ['file'],
    aliases: ['clipboard', 'paste'],
    source: 'builtin',
  },
  {
    name: 'findings_write',
    shortDescription: '记录调查发现',
    tags: ['planning'],
    aliases: ['findings', 'notes'],
    source: 'builtin',
  },

  // ============================================================================
  // Gen 4: 网络和 Skill
  // ============================================================================
  // web_search → WebSearch: promoted to CORE_TOOLS, no longer deferred
  {
    name: 'lsp',
    shortDescription: 'LSP 语言服务协议操作',
    tags: ['file', 'search'],
    aliases: ['language-server', 'definition', 'references'],
    source: 'builtin',
  },

  // ============================================================================
  // Phase 2: Unified Tools (consolidated from multiple tools)
  // ============================================================================
  {
    name: 'Process',
    shortDescription: '进程管理（列出/轮询/日志/写入/提交/终止/输出）',
    tags: ['shell'],
    aliases: ['process', 'ps', 'kill', 'output', 'background', 'pty'],
    source: 'builtin',
  },
  {
    name: 'MCPUnified',
    shortDescription: 'MCP 服务器操作（调用/列表/资源/状态/添加）',
    tags: ['mcp', 'network'],
    aliases: ['mcp', 'mcp-call', 'mcp-tools', 'mcp-resources', 'mcp-status', 'mcp-add'],
    source: 'builtin',
  },
  {
    name: 'TaskManager',
    shortDescription: '任务管理 CRUD（创建/获取/列表/更新）',
    tags: ['planning', 'multiagent'],
    aliases: ['task-create', 'task-get', 'task-list', 'task-update', 'tasks'],
    source: 'builtin',
  },
  {
    name: 'Plan',
    shortDescription: '读取和更新任务计划',
    tags: ['planning'],
    aliases: ['plan', 'plan-read', 'plan-update'],
    source: 'builtin',
  },
  {
    name: 'PlanMode',
    shortDescription: '进入/退出规划模式',
    tags: ['planning'],
    aliases: ['plan-mode', 'enter-plan', 'exit-plan'],
    source: 'builtin',
  },
  {
    name: 'WebFetch',
    shortDescription: '网页获取和 HTTP API 请求',
    tags: ['network'],
    aliases: ['fetch', 'http', 'url', 'api', 'request', 'webpage'],
    source: 'builtin',
  },
  {
    name: 'ReadDocument',
    shortDescription: '读取文档（PDF/Word/Excel）',
    tags: ['document', 'file'],
    aliases: ['pdf', 'docx', 'xlsx', 'word', 'excel', 'document'],
    source: 'builtin',
  },
  {
    name: 'Browser',
    shortDescription: '浏览器自动化（导航/点击/输入/截图）',
    tags: ['vision', 'network'],
    aliases: ['browser', 'navigate', 'click', 'playwright'],
    source: 'builtin',
  },
  {
    name: 'Computer',
    shortDescription: '计算机控制（截图/鼠标/键盘）',
    tags: ['vision'],
    aliases: ['computer', 'screen', 'mouse', 'keyboard', 'capture'],
    source: 'builtin',
  },
  {
    name: 'desktop_context_now',
    shortDescription: '读取最新的本机桌面上下文',
    tags: ['memory', 'vision'],
    aliases: ['desktop now', 'current context', 'what am i doing now'],
    source: 'builtin',
  },
  {
    name: 'desktop_activity_recent',
    shortDescription: '读取最近的本机桌面活动记录',
    tags: ['memory', 'vision'],
    aliases: ['desktop', 'recent activity', 'what was i doing', 'screen history'],
    source: 'builtin',
  },
  {
    name: 'desktop_activity_stats',
    shortDescription: '统计指定时间范围内的本机桌面活动',
    tags: ['memory', 'search'],
    aliases: ['desktop stats', 'activity stats', 'app usage'],
    source: 'builtin',
  },
  {
    name: 'desktop_activity_by_app',
    shortDescription: '按应用汇总本机桌面活动记录',
    tags: ['memory', 'search'],
    aliases: ['desktop by app', 'top apps', 'activity by app'],
    source: 'builtin',
  },
  {
    name: 'desktop_activity_timeline',
    shortDescription: '按时间范围查询本机桌面活动时间线',
    tags: ['memory', 'vision'],
    aliases: ['desktop timeline', 'activity timeline', 'timeline', 'work history'],
    source: 'builtin',
  },
  {
    name: 'desktop_activity_search',
    shortDescription: '按关键词搜索本机桌面活动记录',
    tags: ['memory', 'search'],
    aliases: ['desktop search', 'activity search', 'browser history', 'search history'],
    source: 'builtin',
  },
  {
    name: 'desktop_activity_summary',
    shortDescription: '读取桌面活动的时间片摘要',
    tags: ['memory', 'search'],
    aliases: ['desktop summary', 'activity summary', 'work summary'],
    source: 'builtin',
  },
  {
    name: 'desktop_activity_todo_candidates',
    shortDescription: '读取桌面活动推导出的待办候选',
    tags: ['memory', 'planning'],
    aliases: ['desktop todos', 'activity todos', 'todo candidates'],
    source: 'builtin',
  },
  {
    name: 'desktop_activity_semantic_search',
    shortDescription: '语义检索桌面活动时间片摘要',
    tags: ['memory', 'search'],
    aliases: ['desktop semantic search', 'activity semantic search', 'work summary search'],
    source: 'builtin',
  },
  {
    name: 'workspace_activity_search',
    shortDescription: '统一检索桌面活动摘要与本地 mail/calendar/reminders',
    tags: ['memory', 'search', 'planning'],
    aliases: ['workspace search', 'activity search', 'unified activity search', 'recent work search'],
    source: 'builtin',
  },
  {
    name: 'calendar',
    shortDescription: '读取 macOS 日历中的本地日程信息',
    tags: ['planning'],
    aliases: ['calendar', 'schedule', 'events'],
    source: 'builtin',
  },
  {
    name: 'calendar_create_event',
    shortDescription: '在 macOS 日历中创建本地事件',
    tags: ['planning'],
    aliases: ['create calendar event', 'new calendar event'],
    source: 'builtin',
  },
  {
    name: 'calendar_delete_event',
    shortDescription: '在 macOS 日历中删除本地事件',
    tags: ['planning'],
    aliases: ['delete calendar event', 'remove calendar event'],
    source: 'builtin',
  },
  {
    name: 'calendar_update_event',
    shortDescription: '在 macOS 日历中更新本地事件',
    tags: ['planning'],
    aliases: ['update calendar event', 'edit calendar event'],
    source: 'builtin',
  },
  {
    name: 'mail',
    shortDescription: '读取 macOS Mail 中的本地邮件账户、邮箱和邮件内容',
    tags: ['planning', 'search'],
    aliases: ['mail', 'email', 'mailbox', 'read email'],
    source: 'builtin',
  },
  {
    name: 'mail_draft',
    shortDescription: '在 macOS Mail 中创建本地邮件草稿',
    tags: ['planning'],
    aliases: ['draft email', 'mail draft', 'create draft'],
    source: 'builtin',
  },
  {
    name: 'mail_send',
    shortDescription: '通过 macOS Mail 发送真实邮件',
    tags: ['planning'],
    aliases: ['send email', 'mail send', 'send mail'],
    source: 'builtin',
  },
  {
    name: 'reminders',
    shortDescription: '读取 macOS 提醒事项中的本地待办信息',
    tags: ['planning'],
    aliases: ['reminders', 'todo', 'tasks'],
    source: 'builtin',
  },
  {
    name: 'reminders_create',
    shortDescription: '在 macOS 提醒事项中创建本地待办',
    tags: ['planning'],
    aliases: ['create reminder', 'new reminder'],
    source: 'builtin',
  },
  {
    name: 'reminders_delete',
    shortDescription: '在 macOS 提醒事项中删除本地待办',
    tags: ['planning'],
    aliases: ['delete reminder', 'remove reminder'],
    source: 'builtin',
  },
  {
    name: 'reminders_update',
    shortDescription: '在 macOS 提醒事项中更新或完成本地待办',
    tags: ['planning'],
    aliases: ['update reminder', 'complete reminder', 'edit reminder'],
    source: 'builtin',
  },

  // ============================================================================
  // Gen 5: 文档和媒体生成
  // ============================================================================
  {
    name: 'ppt_generate',
    shortDescription: '遗留 PPT 生成器，默认禁用；优先使用 frontend-slides skill 或 /ppt',
    tags: ['document', 'media'],
    aliases: ['legacy ppt', 'legacy powerpoint'],
    source: 'builtin',
  },
  {
    name: 'image_generate',
    shortDescription: 'AI 生成图片',
    tags: ['media'],
    aliases: ['dalle', 'image', 'picture', 'draw'],
    source: 'builtin',
  },
  {
    name: 'video_generate',
    shortDescription: 'AI 生成视频',
    tags: ['media'],
    aliases: ['video', 'movie', 'animation'],
    source: 'builtin',
  },
  {
    name: 'image_analyze',
    shortDescription: '分析图片内容',
    tags: ['vision', 'media'],
    aliases: ['analyze', 'vision', 'ocr'],
    source: 'builtin',
  },
  {
    name: 'docx_generate',
    shortDescription: '生成 Word 文档',
    tags: ['document'],
    aliases: ['docx', 'word', 'doc'],
    source: 'builtin',
  },
  {
    name: 'ExcelAutomate',
    shortDescription: 'Excel 自动化（读取/生成/原子编辑/实时操作/列出工作表/读取范围）',
    tags: ['document', 'shell'],
    aliases: ['excel', 'xlsx', 'spreadsheet', 'xlwings', 'excel_generate', 'excel_edit', 'read_xlsx', 'xlwings_execute'],
    source: 'builtin',
  },
  {
    name: 'excel_generate',
    shortDescription: '生成 Excel 表格',
    tags: ['document'],
    aliases: ['excel', 'xlsx', 'spreadsheet'],
    source: 'builtin',
  },
  {
    name: 'DocEdit',
    shortDescription: '文档增量编辑（Excel/PPT/Word 原子操作 + 自动快照）',
    tags: ['document'],
    aliases: ['doc_edit', 'docx_edit', 'document_edit', 'edit_document'],
    source: 'builtin',
  },
  {
    name: 'chart_generate',
    shortDescription: '生成图表',
    tags: ['media', 'document'],
    aliases: ['chart', 'graph', 'plot'],
    source: 'builtin',
  },
  {
    name: 'qrcode_generate',
    shortDescription: '生成二维码',
    tags: ['media'],
    aliases: ['qrcode', 'qr'],
    source: 'builtin',
  },
  {
    name: 'jira',
    shortDescription: 'Jira 项目管理操作',
    tags: ['network'],
    aliases: ['jira', 'ticket', 'issue'],
    source: 'builtin',
  },
  {
    name: 'github_pr',
    shortDescription: 'GitHub PR 管理（创建/查看/列表/评论/审查/合并）',
    tags: ['network'] as ToolTag[],
    aliases: ['github', 'pr', 'pull-request', 'merge'],
    source: 'builtin',
  },
  {
    name: 'youtube_transcript',
    shortDescription: '获取 YouTube 视频字幕',
    tags: ['network', 'document'],
    aliases: ['youtube', 'transcript', 'subtitle'],
    source: 'builtin',
  },
  {
    name: 'twitter_fetch',
    shortDescription: '获取 Twitter/X 内容',
    tags: ['network'],
    aliases: ['twitter', 'x', 'tweet'],
    source: 'builtin',
  },
  {
    name: 'mermaid_export',
    shortDescription: '导出 Mermaid 图表为图片',
    tags: ['media', 'document'],
    aliases: ['mermaid', 'diagram'],
    source: 'builtin',
  },
  {
    name: 'pdf_generate',
    shortDescription: '生成 PDF 文档',
    tags: ['document'],
    aliases: ['pdf'],
    source: 'builtin',
  },
  {
    name: 'PdfAutomate',
    shortDescription: 'PDF 自动化（生成/压缩/读取/合并/拆分/表格提取/转 DOCX）',
    tags: ['document'] as ToolTag[],
    aliases: ['pdf', 'pdf_merge', 'pdf_split', 'pdf_tables', 'pdf_convert', 'pdf_automate', 'pdf_generate', 'pdf_compress', 'read_pdf'],
    source: 'builtin',
  },
  {
    name: 'image_process',
    shortDescription: '图片处理和编辑',
    tags: ['media'],
    aliases: ['image', 'resize', 'crop', 'convert'],
    source: 'builtin',
  },
  {
    name: 'screenshot_page',
    shortDescription: '网页截图',
    tags: ['vision', 'network'],
    aliases: ['screenshot', 'capture', 'webpage'],
    source: 'builtin',
  },
  {
    name: 'academic_search',
    shortDescription: '学术论文搜索',
    tags: ['network', 'search'],
    aliases: ['paper', 'academic', 'scholar', 'arxiv'],
    source: 'builtin',
  },
  {
    name: 'speech_to_text',
    shortDescription: '语音转文字',
    tags: ['media'],
    aliases: ['stt', 'transcribe', 'speech', 'audio'],
    source: 'builtin',
  },
  {
    name: 'text_to_speech',
    shortDescription: '文字转语音',
    tags: ['media'],
    aliases: ['tts', 'voice', 'speak'],
    source: 'builtin',
  },
  {
    name: 'image_annotate',
    shortDescription: '图片标注',
    tags: ['media', 'vision'],
    aliases: ['annotate', 'mark', 'label'],
    source: 'builtin',
  },

  // ============================================================================
  // Gen 5: 记忆系统
  // ============================================================================
  {
    name: 'memory',
    shortDescription: '统一记忆工具：存储和搜索长期记忆',
    tags: ['memory', 'search'],
    aliases: ['remember', 'store', 'save', 'recall', 'memory_store', 'memory_search'],
    source: 'builtin',
  },
  {
    name: 'code_index',
    shortDescription: '索引代码库',
    tags: ['memory', 'search'],
    aliases: ['index', 'codebase'],
    source: 'builtin',
  },
  {
    name: 'auto_learn',
    shortDescription: '自动学习模式',
    tags: ['memory', 'evolution'],
    aliases: ['learn', 'auto'],
    source: 'builtin',
  },
  {
    name: 'fork_session',
    shortDescription: '分叉当前会话',
    tags: ['memory'],
    aliases: ['fork', 'branch'],
    source: 'builtin',
  },

  // ============================================================================
  // Gen 7: 多代理
  // ============================================================================
  {
    name: 'SdkTask',
    shortDescription: 'SDK 兼容的任务执行',
    tags: ['multiagent'],
    aliases: ['sdk', 'task'],
    source: 'builtin',
  },
  {
    name: 'AgentSpawn',
    shortDescription: '生成新的子代理',
    tags: ['multiagent'],
    aliases: ['spawn', 'agent', 'create-agent'],
    source: 'builtin',
  },
  {
    name: 'AgentMessage',
    shortDescription: '向代理发送消息',
    tags: ['multiagent'],
    aliases: ['message', 'send'],
    source: 'builtin',
  },
  {
    name: 'WorkflowOrchestrate',
    shortDescription: '编排多代理工作流',
    tags: ['multiagent', 'planning'],
    aliases: ['workflow', 'orchestrate', 'dag'],
    source: 'builtin',
  },

  // ============================================================================
  // Gen 8: 自我进化
  // ============================================================================
  {
    name: 'strategy_optimize',
    shortDescription: '优化执行策略',
    tags: ['evolution'],
    aliases: ['optimize', 'strategy'],
    source: 'builtin',
  },
  {
    name: 'tool_create',
    shortDescription: '动态创建新工具',
    tags: ['evolution'],
    aliases: ['create-tool', 'new-tool'],
    source: 'builtin',
  },
  {
    name: 'self_evaluate',
    shortDescription: '自我评估性能',
    tags: ['evolution'],
    aliases: ['evaluate', 'assess'],
    source: 'builtin',
  },
  {
    name: 'learn_pattern',
    shortDescription: '学习行为模式',
    tags: ['evolution', 'memory'],
    aliases: ['learn', 'pattern'],
    source: 'builtin',
  },
  {
    name: 'code_execute',
    shortDescription: '在沙箱中执行 JS 代码，可循环/条件调用工具，中间结果不消耗上下文',
    tags: ['evolution', 'shell'],
    aliases: ['programmatic', 'batch_tools', 'code_run', 'ptc'],
    source: 'builtin',
  },

  // ============================================================================
  // 进程管理工具（PTY）
  // ============================================================================
];

// ============================================================================
// Tool Aliases — legacy/alternate names → canonical names
// ============================================================================
// Claude Code 使用 TOOL_ALIASES 将旧名称映射到新名称，确保向后兼容
// 例如 model 生成 "read_file" 时自动映射到 "Read"

export const TOOL_ALIASES: Record<string, string> = {
  // snake_case → PascalCase (legacy compatibility)
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  list_directory: 'ListDirectory',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  ask_user_question: 'AskUserQuestion',
  tool_search: 'ToolSearch',
  memory_write: 'MemoryWrite',
  memory_read: 'MemoryRead',
  // Common model hallucinations
  search: 'WebSearch',
  bash: 'Bash',
  grep: 'Grep',
  glob: 'Glob',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  // Multi-agent aliases
  spawn_agent: 'AgentSpawn',
  agent_message: 'AgentMessage',
  send_input: 'SendInput',
  wait_agent: 'WaitAgent',
  close_agent: 'CloseAgent',
};

/**
 * Resolve a tool name through alias mapping.
 * Returns the canonical name if aliased, or the original name.
 */
export function resolveToolAlias(name: string): string {
  return TOOL_ALIASES[name] ?? TOOL_ALIASES[name.toLowerCase()] ?? name;
}

/**
 * 构建延迟工具索引（name → meta）
 */
export function buildDeferredToolIndex(): Map<string, DeferredToolMeta> {
  const index = new Map<string, DeferredToolMeta>();
  for (const meta of DEFERRED_TOOLS_META) {
    index.set(meta.name, meta);
  }
  return index;
}

/**
 * 判断工具是否为核心工具
 */
export function isCoreToolName(name: string): boolean {
  return CORE_TOOLS.includes(name);
}
