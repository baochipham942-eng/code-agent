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
  'bash',
  'read_file',
  'write_file',
  'edit_file',

  // Gen 2: 代码搜索
  'glob',
  'grep',
  'list_directory',

  // Gen 3: 规划和任务（核心 Task API）
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'todo_write',
  'ask_user_question',

  // 工具发现
  'tool_search',
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
    name: 'kill_shell',
    shortDescription: '终止正在运行的后台 shell',
    tags: ['shell'],
    aliases: ['kill', 'stop'],
    source: 'builtin',
    generations: ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'task_output',
    shortDescription: '获取后台任务的输出',
    tags: ['shell'],
    aliases: ['output', 'background'],
    source: 'builtin',
    generations: ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'notebook_edit',
    shortDescription: '编辑 Jupyter Notebook 单元格',
    tags: ['file', 'document'],
    aliases: ['jupyter', 'notebook', 'ipynb'],
    source: 'builtin',
    generations: ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
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
    generations: ['gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'confirm_action',
    shortDescription: '请求用户确认危险操作',
    tags: ['planning'],
    aliases: ['confirm', 'approve'],
    source: 'builtin',
    generations: ['gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'read_clipboard',
    shortDescription: '读取系统剪贴板内容',
    tags: ['file'],
    aliases: ['clipboard', 'paste'],
    source: 'builtin',
    generations: ['gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'plan_read',
    shortDescription: '读取当前任务计划',
    tags: ['planning'],
    aliases: ['plan'],
    source: 'builtin',
    generations: ['gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'plan_update',
    shortDescription: '更新任务计划',
    tags: ['planning'],
    aliases: ['plan'],
    source: 'builtin',
    generations: ['gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'findings_write',
    shortDescription: '记录调查发现',
    tags: ['planning'],
    aliases: ['findings', 'notes'],
    source: 'builtin',
    generations: ['gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'enter_plan_mode',
    shortDescription: '进入计划模式',
    tags: ['planning'],
    aliases: ['plan'],
    source: 'builtin',
    generations: ['gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'exit_plan_mode',
    shortDescription: '退出计划模式',
    tags: ['planning'],
    aliases: ['plan'],
    source: 'builtin',
    generations: ['gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  },

  // ============================================================================
  // Gen 4: 网络和 Skill
  // ============================================================================
  {
    name: 'skill',
    shortDescription: '执行已注册的 skill（如 commit、review-pr）',
    tags: ['planning'],
    aliases: ['slash', 'command'],
    source: 'builtin',
    generations: ['gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'web_fetch',
    shortDescription: '获取网页内容',
    tags: ['network'],
    aliases: ['fetch', 'http', 'url', 'webpage'],
    source: 'builtin',
    generations: ['gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'web_search',
    shortDescription: '搜索网络信息',
    tags: ['network', 'search'],
    aliases: ['google', 'search', 'bing'],
    source: 'builtin',
    generations: ['gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'read_pdf',
    shortDescription: '读取 PDF 文件内容',
    tags: ['document', 'file'],
    aliases: ['pdf'],
    source: 'builtin',
    generations: ['gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'lsp',
    shortDescription: 'LSP 语言服务协议操作',
    tags: ['file', 'search'],
    aliases: ['language-server', 'definition', 'references'],
    source: 'builtin',
    generations: ['gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'http_request',
    shortDescription: '发送 HTTP API 请求',
    tags: ['network'],
    aliases: ['api', 'rest', 'request'],
    source: 'builtin',
    generations: ['gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  },

  // ============================================================================
  // Gen 4: MCP 工具
  // ============================================================================
  {
    name: 'mcp',
    shortDescription: '调用 MCP 服务器工具',
    tags: ['mcp', 'network'],
    aliases: ['mcp-call', 'mcp-tool'],
    source: 'builtin',
    generations: ['gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'mcp_list_tools',
    shortDescription: '列出 MCP 服务器的可用工具',
    tags: ['mcp'],
    aliases: ['mcp-tools'],
    source: 'builtin',
    generations: ['gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'mcp_list_resources',
    shortDescription: '列出 MCP 服务器的资源',
    tags: ['mcp'],
    aliases: ['mcp-resources'],
    source: 'builtin',
    generations: ['gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'mcp_read_resource',
    shortDescription: '读取 MCP 资源内容',
    tags: ['mcp'],
    aliases: ['mcp-read'],
    source: 'builtin',
    generations: ['gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'mcp_get_status',
    shortDescription: '获取 MCP 服务器状态',
    tags: ['mcp'],
    aliases: ['mcp-status'],
    source: 'builtin',
    generations: ['gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'mcp_add_server',
    shortDescription: '添加新的 MCP 服务器',
    tags: ['mcp'],
    aliases: ['mcp-add'],
    source: 'builtin',
    generations: ['gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  },

  // ============================================================================
  // Gen 5: 文档和媒体生成
  // ============================================================================
  {
    name: 'ppt_generate',
    shortDescription: '生成 PowerPoint 演示文稿',
    tags: ['document', 'media'],
    aliases: ['ppt', 'powerpoint', 'slides', 'presentation'],
    source: 'builtin',
    generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'image_generate',
    shortDescription: 'AI 生成图片',
    tags: ['media'],
    aliases: ['dalle', 'image', 'picture', 'draw'],
    source: 'builtin',
    generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'video_generate',
    shortDescription: 'AI 生成视频',
    tags: ['media'],
    aliases: ['video', 'movie', 'animation'],
    source: 'builtin',
    generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'image_analyze',
    shortDescription: '分析图片内容',
    tags: ['vision', 'media'],
    aliases: ['analyze', 'vision', 'ocr'],
    source: 'builtin',
    generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'docx_generate',
    shortDescription: '生成 Word 文档',
    tags: ['document'],
    aliases: ['docx', 'word', 'doc'],
    source: 'builtin',
    generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'excel_generate',
    shortDescription: '生成 Excel 表格',
    tags: ['document'],
    aliases: ['excel', 'xlsx', 'spreadsheet'],
    source: 'builtin',
    generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'chart_generate',
    shortDescription: '生成图表',
    tags: ['media', 'document'],
    aliases: ['chart', 'graph', 'plot'],
    source: 'builtin',
    generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'qrcode_generate',
    shortDescription: '生成二维码',
    tags: ['media'],
    aliases: ['qrcode', 'qr'],
    source: 'builtin',
    generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'read_docx',
    shortDescription: '读取 Word 文档',
    tags: ['document', 'file'],
    aliases: ['docx', 'word'],
    source: 'builtin',
    generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'read_xlsx',
    shortDescription: '读取 Excel 表格',
    tags: ['document', 'file'],
    aliases: ['excel', 'xlsx'],
    source: 'builtin',
    generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'jira',
    shortDescription: 'Jira 项目管理操作',
    tags: ['network'],
    aliases: ['jira', 'ticket', 'issue'],
    source: 'builtin',
    generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'youtube_transcript',
    shortDescription: '获取 YouTube 视频字幕',
    tags: ['network', 'document'],
    aliases: ['youtube', 'transcript', 'subtitle'],
    source: 'builtin',
    generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'twitter_fetch',
    shortDescription: '获取 Twitter/X 内容',
    tags: ['network'],
    aliases: ['twitter', 'x', 'tweet'],
    source: 'builtin',
    generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'mermaid_export',
    shortDescription: '导出 Mermaid 图表为图片',
    tags: ['media', 'document'],
    aliases: ['mermaid', 'diagram'],
    source: 'builtin',
    generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'pdf_generate',
    shortDescription: '生成 PDF 文档',
    tags: ['document'],
    aliases: ['pdf'],
    source: 'builtin',
    generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'image_process',
    shortDescription: '图片处理和编辑',
    tags: ['media'],
    aliases: ['image', 'resize', 'crop', 'convert'],
    source: 'builtin',
    generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'screenshot_page',
    shortDescription: '网页截图',
    tags: ['vision', 'network'],
    aliases: ['screenshot', 'capture', 'webpage'],
    source: 'builtin',
    generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'academic_search',
    shortDescription: '学术论文搜索',
    tags: ['network', 'search'],
    aliases: ['paper', 'academic', 'scholar', 'arxiv'],
    source: 'builtin',
    generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'speech_to_text',
    shortDescription: '语音转文字',
    tags: ['media'],
    aliases: ['stt', 'transcribe', 'speech', 'audio'],
    source: 'builtin',
    generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'text_to_speech',
    shortDescription: '文字转语音',
    tags: ['media'],
    aliases: ['tts', 'voice', 'speak'],
    source: 'builtin',
    generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'image_annotate',
    shortDescription: '图片标注',
    tags: ['media', 'vision'],
    aliases: ['annotate', 'mark', 'label'],
    source: 'builtin',
    generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  },

  // ============================================================================
  // Gen 5: 记忆系统
  // ============================================================================
  {
    name: 'memory_store',
    shortDescription: '存储信息到长期记忆',
    tags: ['memory'],
    aliases: ['remember', 'store', 'save'],
    source: 'builtin',
    generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'memory_search',
    shortDescription: '搜索长期记忆',
    tags: ['memory', 'search'],
    aliases: ['recall', 'memory'],
    source: 'builtin',
    generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'code_index',
    shortDescription: '索引代码库',
    tags: ['memory', 'search'],
    aliases: ['index', 'codebase'],
    source: 'builtin',
    generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'auto_learn',
    shortDescription: '自动学习模式',
    tags: ['memory', 'evolution'],
    aliases: ['learn', 'auto'],
    source: 'builtin',
    generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'fork_session',
    shortDescription: '分叉当前会话',
    tags: ['memory'],
    aliases: ['fork', 'branch'],
    source: 'builtin',
    generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  },

  // ============================================================================
  // Gen 6: 视觉和浏览器
  // ============================================================================
  {
    name: 'screenshot',
    shortDescription: '截取屏幕或窗口',
    tags: ['vision'],
    aliases: ['capture', 'screen'],
    source: 'builtin',
    generations: ['gen6', 'gen7', 'gen8'],
  },
  {
    name: 'computer_use',
    shortDescription: '控制计算机（鼠标、键盘）',
    tags: ['vision'],
    aliases: ['computer', 'control', 'mouse', 'keyboard'],
    source: 'builtin',
    generations: ['gen6', 'gen7', 'gen8'],
  },
  {
    name: 'browser_navigate',
    shortDescription: '浏览器导航',
    tags: ['vision', 'network'],
    aliases: ['browser', 'navigate', 'goto'],
    source: 'builtin',
    generations: ['gen6', 'gen7', 'gen8'],
  },
  {
    name: 'browser_action',
    shortDescription: '浏览器交互操作',
    tags: ['vision', 'network'],
    aliases: ['browser', 'click', 'type'],
    source: 'builtin',
    generations: ['gen6', 'gen7', 'gen8'],
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
    generations: ['gen7', 'gen8'],
  },
  {
    name: 'AgentSpawn',
    shortDescription: '生成新的子代理',
    tags: ['multiagent'],
    aliases: ['spawn', 'agent', 'create-agent'],
    source: 'builtin',
    generations: ['gen7', 'gen8'],
  },
  {
    name: 'AgentMessage',
    shortDescription: '向代理发送消息',
    tags: ['multiagent'],
    aliases: ['message', 'send'],
    source: 'builtin',
    generations: ['gen7', 'gen8'],
  },
  {
    name: 'WorkflowOrchestrate',
    shortDescription: '编排多代理工作流',
    tags: ['multiagent', 'planning'],
    aliases: ['workflow', 'orchestrate', 'dag'],
    source: 'builtin',
    generations: ['gen7', 'gen8'],
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
    generations: ['gen8'],
  },
  {
    name: 'tool_create',
    shortDescription: '动态创建新工具',
    tags: ['evolution'],
    aliases: ['create-tool', 'new-tool'],
    source: 'builtin',
    generations: ['gen8'],
  },
  {
    name: 'self_evaluate',
    shortDescription: '自我评估性能',
    tags: ['evolution'],
    aliases: ['evaluate', 'assess'],
    source: 'builtin',
    generations: ['gen8'],
  },
  {
    name: 'learn_pattern',
    shortDescription: '学习行为模式',
    tags: ['evolution', 'memory'],
    aliases: ['learn', 'pattern'],
    source: 'builtin',
    generations: ['gen8'],
  },

  // ============================================================================
  // 进程管理工具（PTY）
  // ============================================================================
  {
    name: 'process_list',
    shortDescription: '列出运行中的进程',
    tags: ['shell'],
    aliases: ['ps', 'processes'],
    source: 'builtin',
    generations: ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'process_poll',
    shortDescription: '轮询进程状态',
    tags: ['shell'],
    aliases: ['poll'],
    source: 'builtin',
    generations: ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'process_log',
    shortDescription: '获取进程日志',
    tags: ['shell'],
    aliases: ['log'],
    source: 'builtin',
    generations: ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'process_write',
    shortDescription: '向进程写入输入',
    tags: ['shell'],
    aliases: ['stdin'],
    source: 'builtin',
    generations: ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'process_submit',
    shortDescription: '提交进程输入',
    tags: ['shell'],
    aliases: ['submit'],
    source: 'builtin',
    generations: ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  },
  {
    name: 'process_kill',
    shortDescription: '终止进程',
    tags: ['shell'],
    aliases: ['kill'],
    source: 'builtin',
    generations: ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  },
];

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
