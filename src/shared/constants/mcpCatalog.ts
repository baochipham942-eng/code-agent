// ============================================================================
// MCP Catalog - 推荐 MCP Server 目录（分类 / 条目）
// ============================================================================
// 纯静态数据，main 与 renderer 共用。
// 后续运营化时由 cloudConfigService 云端下发覆盖，此处作为离线兜底默认值。
// 所有 npm 包名 / 远程 URL 均已核实存在（2026-06-03，npm view / 官方文档）。
// builtin: true 的条目对应 cloud/builtinConfig.ts BUILTIN_MCP_SERVERS 中的同 id 预置配置。
// tools 静态策展清单：名录逐字抄自各 server 官方 README / 官方包源码（2026-07-27 核实），
// 宁缺毋滥——名录不确定的条目（tavily / notion / figma / task_master）不填，
// 发现面对缺失清单显示「安装后可见」占位；运行时真实工具以连接后上报为准。
// ============================================================================

import type {
  McpCatalogPayload,
  McpCategoryMeta,
  RecommendedMcpServerEntry,
} from '../contract/mcpCatalog';
import {
  FEISHU_CALENDAR_MIN_PAGE_SIZE,
  FEISHU_DEFAULT_DOMAIN,
  FEISHU_DEFAULT_HOST,
  FEISHU_READONLY_TOOLS,
  LARK_MCP_PINNED_VERSION,
} from './feishu';

// ----------------------------------------------------------------------------
// 用途分类
// ----------------------------------------------------------------------------

export const MCP_CATEGORIES: McpCategoryMeta[] = [
  { id: 'search-scrape', label: '搜索与抓取', description: '联网搜索、网页内容提取' },
  { id: 'office-collab', label: '办公协作', description: 'Notion、飞书等协作平台' },
  { id: 'data-table', label: '数据与表格', description: 'Excel、数据库查询' },
  { id: 'browser-auto', label: '浏览器自动化', description: '网页操作、截图、表单填写' },
  { id: 'design-media', label: '设计与多媒体', description: 'Figma 设计稿读写' },
  { id: 'dev-tools', label: '开发与效率', description: 'GitHub、文档、记忆、地图' },
];

// ----------------------------------------------------------------------------
// 推荐 MCP Server
// ----------------------------------------------------------------------------

export const RECOMMENDED_MCP_SERVERS: RecommendedMcpServerEntry[] = [
  // ---- 搜索与抓取 ----
  {
    id: 'exa',
    name: 'Exa AI 搜索',
    description: 'AI 驱动的语义搜索，支持代码搜索',
    category: 'search-scrape',
    builtin: true,
    requiredCredentials: ['EXA_API_KEY'],
    badge: '全球使用量第一',
    // 内置配置 URL 已用 ?tools= 锁定这两个（见 builtinConfig BUILTIN_MCP_SERVERS.exa）
    tools: [
      { name: 'web_search_exa', description: 'AI 语义网页搜索' },
      { name: 'web_fetch_exa', description: '抓取指定 URL 全文' },
    ],
  },
  {
    id: 'tavily',
    name: 'Tavily 搜索',
    description: '实时网络搜索与新闻，支持域名过滤',
    category: 'search-scrape',
    builtin: true,
    requiredCredentials: ['TAVILY_API_KEY'],
    // hosted mcp.tavily.com 的工具名录未经官方 README 证实，宁缺毋滥
  },
  {
    id: 'fetch',
    name: 'Fetch',
    description: '标准 MCP 网页读取与内容提取',
    category: 'search-scrape',
    builtin: false,
    connection: {
      type: 'stdio',
      command: 'uvx',
      args: ['mcp-server-fetch'],
    },
    badge: 'Alma 官方精选·免配置',
    officialFeatured: true,
    featuredSource: 'alma-mcp-registry',
    recommendationTier: 'conditional',
    riskNote: '普通网页读取已由内置 web fetch 覆盖；需要标准 MCP workflow 时再连接。',
    tools: [
      { name: 'fetch', description: '抓取网页并转为 markdown' },
    ],
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl 抓取',
    description: '默认网页数据层：免 key 试用搜索、网页抓取和公开 PDF 转 markdown',
    category: 'search-scrape',
    builtin: true,
    requiredCredentials: [],
    badge: '免 key 可试用',
    officialFeatured: true,
    featuredSource: 'alma-mcp-registry',
    recommendationTier: 'default_visible',
    riskNote: '免 key 模式有额度和工具范围限制；配置 FIRECRAWL_API_KEY 后获得更高额度和完整能力。',
    // 名录抄自 firecrawl/firecrawl-mcp-server README「Available Tools」（2026-07-27）
    tools: [
      { name: 'firecrawl_scrape', description: '抓取单页内容' },
      { name: 'firecrawl_map', description: '发现站点全部 URL' },
      { name: 'firecrawl_search', description: '网页搜索' },
      { name: 'firecrawl_search_feedback', description: '搜索结果反馈' },
      { name: 'firecrawl_feedback', description: '任务质量反馈' },
      { name: 'firecrawl_crawl', description: '整站爬取并轮询' },
      { name: 'firecrawl_check_crawl_status', description: '查询爬取状态' },
      { name: 'firecrawl_parse', description: '解析本地文档' },
      { name: 'firecrawl_extract', description: 'LLM 结构化抽取' },
      { name: 'firecrawl_agent', description: '自主网络研究' },
      { name: 'firecrawl_agent_status', description: '查询研究状态' },
      { name: 'firecrawl_interact', description: '页面交互操作' },
      { name: 'firecrawl_interact_stop', description: '结束交互会话' },
      { name: 'firecrawl_research_search_papers', description: '搜索论文' },
      { name: 'firecrawl_research_inspect_paper', description: '查看论文详情' },
      { name: 'firecrawl_research_related_papers', description: '找相关论文' },
      { name: 'firecrawl_research_read_paper', description: '读论文正文' },
      { name: 'firecrawl_research_search_github', description: '搜索 GitHub 仓库' },
      { name: 'firecrawl_monitor_create', description: '创建页面监控' },
      { name: 'firecrawl_monitor_list', description: '列出监控' },
      { name: 'firecrawl_monitor_get', description: '获取监控详情' },
      { name: 'firecrawl_monitor_update', description: '更新监控' },
      { name: 'firecrawl_monitor_run', description: '立即触发检查' },
      { name: 'firecrawl_monitor_delete', description: '删除监控' },
      { name: 'firecrawl_monitor_checks', description: '列出检查记录' },
      { name: 'firecrawl_monitor_check', description: '查看页面级 diff' },
    ],
  },
  {
    id: 'brave-search',
    name: 'Brave 搜索',
    description: '带免费额度的网页搜索',
    category: 'search-scrape',
    builtin: true,
    requiredCredentials: ['BRAVE_API_KEY'],
    tools: [
      { name: 'brave_web_search', description: '网页搜索' },
      { name: 'brave_local_search', description: '本地商户搜索' },
    ],
  },

  // ---- 办公协作 ----
  {
    id: 'notion',
    name: 'Notion',
    description: '读写 Notion 页面和数据库',
    category: 'office-collab',
    builtin: false,
    connection: {
      type: 'http',
      url: 'https://mcp.notion.com/mcp',
    },
    requiredCredentials: ['OAuth 授权'],
    badge: 'Notion 官方',
    // hosted Notion MCP 工具名录未公开稳定文档，宁缺毋滥
  },
  {
    id: 'lark',
    name: '飞书',
    description: `飞书多维表格与日历（只读）。需先在飞书开放平台建自建应用、开多维表格与日历的只读权限、启用机器人能力（日历接口的必要条件）、创建版本并发布，再把应用加进目标表格的协作者。日历要监听哪一本需自己提供日历 ID（应用身份列不出你新建的日历），取日程时每次至少取 ${FEISHU_CALENDAR_MIN_PAGE_SIZE} 条。`,
    category: 'office-collab',
    builtin: false,
    connection: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', `@larksuiteoapi/lark-mcp@${LARK_MCP_PINNED_VERSION}`, 'mcp', '-l', 'zh'],
      env: {
        APP_ID: '',
        APP_SECRET: '',
        LARK_TOKEN_MODE: 'tenant_access_token',
        LARK_TOOLS: FEISHU_READONLY_TOOLS.join(','),
        LARK_DOMAIN: FEISHU_DEFAULT_DOMAIN,
        MCP_NO_PROXY_HOSTS: FEISHU_DEFAULT_HOST,
      },
    },
    requiredCredentials: ['APP_ID', 'APP_SECRET'],
    badge: '飞书官方',
    chinaDirect: true,
    // 全 6 个都是只读（LARK_TOOLS 已锁死只读集，server 只能暴露这些）。
    // 无人值守 cron 里免审批放行，否则读日历/表格会撞 60s 交互权限门被拖死。
    readOnlyTools: [...FEISHU_READONLY_TOOLS],
    // 与 readOnlyTools 同源：LARK_TOOLS 锁死后 server 只暴露这 6 个
    tools: [
      { name: 'bitable.v1.appTableRecord.search', description: '搜索多维表格记录' },
      { name: 'bitable.v1.appTableField.list', description: '列出多维表格字段' },
      { name: 'bitable.v1.appTable.list', description: '列出多维表格数据表' },
      { name: 'calendar.v4.calendar.primary', description: '查询主日历' },
      { name: 'calendar.v4.calendarEvent.list', description: '列出日历日程' },
      { name: 'calendar.v4.freebusy.list', description: '查询忙闲状态' },
    ],
  },

  // ---- 数据与表格 ----
  {
    id: 'excel',
    name: 'Excel 表格',
    description: '不装 Office 直接创建/读写 .xlsx 文件',
    category: 'data-table',
    builtin: false,
    connection: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@negokaz/excel-mcp-server'],
    },
    badge: '免配置',
    chinaDirect: true,
    // 名录抄自 negokaz/excel-mcp-server README「Tools」（2026-07-27）
    tools: [
      { name: 'excel_describe_sheets', description: '列出工作簿所有 sheet' },
      { name: 'excel_read_sheet', description: '分页读取 sheet 数据' },
      { name: 'excel_screen_capture', description: 'sheet 截图（仅 Windows）' },
      { name: 'excel_write_to_sheet', description: '写入 sheet 数据' },
      { name: 'excel_create_table', description: '创建表格' },
      { name: 'excel_copy_sheet', description: '复制 sheet' },
      { name: 'excel_format_range', description: '设置单元格样式' },
    ],
  },
  {
    id: 'supabase',
    name: 'Supabase',
    description: '数据库管理、SQL 查询、日志分析',
    category: 'data-table',
    builtin: false,
    connection: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@supabase/mcp-server-supabase'],
      env: {
        SUPABASE_ACCESS_TOKEN: '',
      },
    },
    requiredCredentials: ['SUPABASE_ACCESS_TOKEN'],
    badge: '官方',
    // 名录抄自 supabase-community/supabase-mcp main 源码 tools 目录（2026-07-27）
    tools: [
      { name: 'list_organizations', description: '列出组织' },
      { name: 'get_organization', description: '组织详情' },
      { name: 'list_projects', description: '列出项目' },
      { name: 'get_project', description: '项目详情' },
      { name: 'get_cost', description: '查询操作费用' },
      { name: 'confirm_cost', description: '确认费用' },
      { name: 'create_project', description: '创建项目' },
      { name: 'pause_project', description: '暂停项目' },
      { name: 'restore_project', description: '恢复项目' },
      { name: 'create_branch', description: '创建开发分支' },
      { name: 'list_branches', description: '列出开发分支' },
      { name: 'delete_branch', description: '删除开发分支' },
      { name: 'merge_branch', description: '合并开发分支' },
      { name: 'reset_branch', description: '重置开发分支' },
      { name: 'rebase_branch', description: '变基开发分支' },
      { name: 'list_tables', description: '列出数据表' },
      { name: 'list_extensions', description: '列出扩展' },
      { name: 'list_migrations', description: '列出迁移' },
      { name: 'apply_migration', description: '执行迁移' },
      { name: 'execute_sql', description: '执行 SQL' },
      { name: 'get_advisors', description: '安全/性能建议' },
      { name: 'get_logs', description: '获取服务日志' },
      { name: 'get_project_url', description: '获取项目 API URL' },
      { name: 'get_publishable_keys', description: '获取公开 API 密钥' },
      { name: 'generate_typescript_types', description: '生成 TS 类型' },
      { name: 'search_docs', description: '搜索 Supabase 文档' },
      { name: 'list_edge_functions', description: '列出边缘函数' },
      { name: 'get_edge_function', description: '边缘函数详情' },
      { name: 'deploy_edge_function', description: '部署边缘函数' },
      { name: 'list_storage_buckets', description: '列出存储桶' },
      { name: 'get_storage_config', description: '获取存储配置' },
      { name: 'update_storage_config', description: '更新存储配置' },
    ],
  },

  // ---- 浏览器自动化 ----
  {
    id: 'playwright',
    name: 'Playwright',
    description: '浏览器自动化：打开网页、点击、截图、测试',
    category: 'browser-auto',
    builtin: false,
    connection: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@playwright/mcp'],
    },
    badge: '微软官方·免配置',
    chinaDirect: true,
    officialFeatured: true,
    featuredSource: 'alma-mcp-registry',
    recommendationTier: 'default_visible',
    riskNote: '和内置 Browser/Computer Use 有重叠；适合标准 MCP 浏览器自动化工作流。',
    // 名录抄自 microsoft/playwright-mcp README（2026-07-27）：只收默认启用组
    //（Core 23 个 + browser_tabs；--caps 的 storage/devtools/vision 等 opt-in 组不收）
    tools: [
      { name: 'browser_click', description: '点击页面元素' },
      { name: 'browser_close', description: '关闭页面' },
      { name: 'browser_console_messages', description: '获取控制台消息' },
      { name: 'browser_drag', description: '两元素间拖拽' },
      { name: 'browser_drop', description: '向元素拖放文件' },
      { name: 'browser_evaluate', description: '在页面执行 JS' },
      { name: 'browser_file_upload', description: '上传文件' },
      { name: 'browser_fill_form', description: '批量填表单' },
      { name: 'browser_find', description: '快照中搜索文本' },
      { name: 'browser_handle_dialog', description: '处理对话框' },
      { name: 'browser_hover', description: '悬停元素' },
      { name: 'browser_navigate', description: '导航到 URL' },
      { name: 'browser_navigate_back', description: '后退上一页' },
      { name: 'browser_network_request', description: '查看请求详情' },
      { name: 'browser_network_requests', description: '列出网络请求' },
      { name: 'browser_press_key', description: '按键' },
      { name: 'browser_resize', description: '调整窗口大小' },
      { name: 'browser_run_code_unsafe', description: '运行 Playwright 代码' },
      { name: 'browser_select_option', description: '下拉框选项' },
      { name: 'browser_snapshot', description: '抓取无障碍快照' },
      { name: 'browser_take_screenshot', description: '截图' },
      { name: 'browser_type', description: '输入文本' },
      { name: 'browser_wait_for', description: '等待文本/时间' },
      { name: 'browser_tabs', description: '管理标签页' },
    ],
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer',
    description: '网页截图、PDF 生成、表单填充',
    category: 'browser-auto',
    builtin: true,
    tools: [
      { name: 'puppeteer_navigate', description: '导航到 URL' },
      { name: 'puppeteer_screenshot', description: '页面截图' },
      { name: 'puppeteer_click', description: '点击元素' },
      { name: 'puppeteer_fill', description: '填写输入框' },
      { name: 'puppeteer_select', description: '下拉选择' },
      { name: 'puppeteer_hover', description: '悬停元素' },
      { name: 'puppeteer_evaluate', description: '在页面执行 JS' },
    ],
  },

  // ---- 设计与多媒体 ----
  {
    id: 'figma',
    name: 'Figma',
    description: '读写 Figma 设计稿，从设计生成代码',
    category: 'design-media',
    builtin: false,
    connection: {
      type: 'http',
      url: 'https://mcp.figma.com/mcp',
    },
    requiredCredentials: ['OAuth 授权'],
    badge: 'Figma 官方',
    // hosted Figma MCP 工具名录未公开稳定文档，宁缺毋滥
  },

  // ---- 开发与效率 ----
  {
    id: 'github',
    name: 'GitHub',
    description: '仓库、Issue、PR 管理',
    category: 'dev-tools',
    builtin: true,
    requiredCredentials: ['GITHUB_TOKEN'],
    officialFeatured: true,
    featuredSource: 'alma-mcp-registry',
    recommendationTier: 'conditional',
    riskNote: '涉及仓库 token 和写权限；建议优先配置只读或最小权限 token。',
    // 内置配置用的是 @modelcontextprotocol/server-github（归档参考 server），
    // 名录抄自 servers-archived/src/github README「Tools」（2026-07-27）
    tools: [
      { name: 'create_or_update_file', description: '创建或更新单文件' },
      { name: 'push_files', description: '单提交推送多文件' },
      { name: 'search_repositories', description: '搜索仓库' },
      { name: 'create_repository', description: '创建仓库' },
      { name: 'get_file_contents', description: '获取文件/目录内容' },
      { name: 'create_issue', description: '创建 issue' },
      { name: 'create_pull_request', description: '创建 PR' },
      { name: 'fork_repository', description: 'Fork 仓库' },
      { name: 'create_branch', description: '创建分支' },
      { name: 'list_issues', description: '列出/筛选 issue' },
      { name: 'update_issue', description: '更新 issue' },
      { name: 'add_issue_comment', description: '评论 issue' },
      { name: 'search_code', description: '搜索代码' },
      { name: 'search_issues', description: '搜索 issue/PR' },
      { name: 'search_users', description: '搜索用户' },
      { name: 'list_commits', description: '列出分支提交' },
      { name: 'get_issue', description: '获取单个 issue' },
      { name: 'get_pull_request', description: '获取 PR 详情' },
      { name: 'list_pull_requests', description: '列出/筛选 PR' },
      { name: 'create_pull_request_review', description: '提交 PR review' },
      { name: 'merge_pull_request', description: '合并 PR' },
      { name: 'get_pull_request_files', description: 'PR 变更文件列表' },
      { name: 'get_pull_request_status', description: 'PR 检查状态' },
      { name: 'update_pull_request_branch', description: '用 base 更新 PR 分支' },
      { name: 'get_pull_request_comments', description: 'PR review 评论' },
      { name: 'get_pull_request_reviews', description: 'PR review 列表' },
    ],
  },
  {
    id: 'context7',
    name: 'Context7',
    description: '获取最新框架文档和代码示例',
    category: 'dev-tools',
    builtin: true,
    badge: '免配置',
    officialFeatured: true,
    featuredSource: 'alma-mcp-registry',
    recommendationTier: 'default_visible',
    riskNote: '适合框架文档和 API 示例查询，凭证负担低。',
    // 名录抄自 upstash/context7 README「Available Tools」（2026-07-27）；工具名是连字符风格
    tools: [
      { name: 'resolve-library-id', description: '库名解析为 Context7 ID' },
      { name: 'query-docs', description: '按库 ID 检索最新文档' },
    ],
  },
  {
    id: 'deepwiki',
    name: 'DeepWiki',
    description: '解读 GitHub 项目架构和文档',
    category: 'dev-tools',
    builtin: true,
    badge: '免配置',
    tools: [
      { name: 'read_wiki_structure', description: '读取仓库文档结构' },
      { name: 'read_wiki_contents', description: '读取仓库文档内容' },
      { name: 'ask_question', description: '针对仓库提问' },
    ],
  },
  {
    id: 'memory',
    name: '知识图谱记忆',
    description: '跨会话的持久知识图谱记忆',
    category: 'dev-tools',
    builtin: true,
    badge: '免配置',
    tools: [
      { name: 'create_entities', description: '创建实体' },
      { name: 'create_relations', description: '创建实体关系' },
      { name: 'add_observations', description: '追加观察记录' },
      { name: 'delete_entities', description: '删除实体' },
      { name: 'delete_observations', description: '删除观察记录' },
      { name: 'delete_relations', description: '删除实体关系' },
      { name: 'read_graph', description: '读取整个知识图谱' },
      { name: 'search_nodes', description: '搜索节点' },
      { name: 'open_nodes', description: '按名称取节点' },
    ],
  },
  {
    id: 'sequential-thinking',
    name: '分步推理',
    description: '复杂任务的动态分解和逐步推理',
    category: 'dev-tools',
    builtin: true,
    badge: '免配置',
    tools: [
      { name: 'sequentialthinking', description: '动态分解并逐步推理' },
    ],
  },
  {
    id: 'amap',
    name: '高德地图',
    description: '地图、位置查询、路径规划',
    category: 'dev-tools',
    builtin: false,
    connection: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@amap/amap-maps-mcp-server'],
      env: {
        AMAP_MAPS_API_KEY: '',
      },
    },
    requiredCredentials: ['AMAP_MAPS_API_KEY'],
    badge: '高德官方',
    chinaDirect: true,
    // 高德无公开 GitHub 仓库；名录抄自 npm 包 amap-maps-mcp-server@0.0.8 源码（2026-07-27）
    tools: [
      { name: 'maps_geo', description: '地址转经纬度' },
      { name: 'maps_regeocode', description: '经纬度转地址' },
      { name: 'maps_ip_location', description: 'IP 定位' },
      { name: 'maps_weather', description: '按城市查天气' },
      { name: 'maps_bicycling', description: '骑行路径规划' },
      { name: 'maps_direction_walking', description: '步行路径规划' },
      { name: 'maps_direction_driving', description: '驾车路径规划' },
      { name: 'maps_direction_transit_integrated', description: '公交综合路径规划' },
      { name: 'maps_distance', description: '两点间距离测量' },
      { name: 'maps_text_search', description: '关键词搜 POI' },
      { name: 'maps_around_search', description: '周边搜 POI' },
      { name: 'maps_search_detail', description: 'POI 详情查询' },
    ],
  },
  {
    id: 'task_master',
    name: 'Task Master',
    description: '项目内任务拆解、计划和执行状态管理',
    category: 'dev-tools',
    builtin: false,
    connection: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'task-master-ai'],
      env: {
        ANTHROPIC_API_KEY: '',
      },
    },
    requiredCredentials: ['ANTHROPIC_API_KEY'],
    badge: 'Alma 官方精选',
    officialFeatured: true,
    featuredSource: 'alma-mcp-registry',
    recommendationTier: 'not_default',
    riskNote: '和 code-agent 的计划/任务体系重叠；只建议已有 Task Master 项目的用户连接。',
    // 工具名录随版本变动大，宁缺毋滥
  },
];

// ----------------------------------------------------------------------------
// Helper
// ----------------------------------------------------------------------------

/**
 * 运行时徽标语义：从既有 builtin/connection 字段推导，不新增目录字段。
 * - builtin：应用预置 server（随应用下发，只需启用）
 * - npx/uvx：stdio 本地运行时，按启动命令区分
 * - remote：sse/http 远程 server
 * 返回 null 表示无法推导（如未知 stdio 命令），前端不显示徽标。
 */
export type McpRuntimeBadge = 'builtin' | 'npx' | 'uvx' | 'remote';

export function getMcpRuntimeBadge(entry: RecommendedMcpServerEntry): McpRuntimeBadge | null {
  if (entry.builtin) return 'builtin';
  const connection = entry.connection;
  if (!connection) return null;
  if (connection.type === 'stdio') {
    if (connection.command === 'npx') return 'npx';
    if (connection.command === 'uvx') return 'uvx';
    return null;
  }
  return 'remote';
}

/** 内置 MCP 推荐目录载荷（云端未下发时的兜底） */
export function getBuiltinMcpCatalogPayload(): McpCatalogPayload {
  return {
    categories: MCP_CATEGORIES,
    servers: RECOMMENDED_MCP_SERVERS,
  };
}

/** 按分类分组推荐 MCP server（保持分类顺序）；不传 catalog 时用内置目录 */
export function groupRecommendedMcpServersByCategory(
  catalog: McpCatalogPayload = getBuiltinMcpCatalogPayload()
): Array<{
  category: McpCategoryMeta;
  servers: RecommendedMcpServerEntry[];
}> {
  return catalog.categories.map((category) => ({
    category,
    servers: catalog.servers.filter((server) => server.category === category.id),
  })).filter((group) => group.servers.length > 0);
}

/** 根据 ID 查找推荐 MCP server；不传 servers 时在内置目录中查找 */
export function findRecommendedMcpServer(
  id: string,
  servers: RecommendedMcpServerEntry[] = RECOMMENDED_MCP_SERVERS
): RecommendedMcpServerEntry | undefined {
  return servers.find((server) => server.id === id);
}

export function getAlmaFeaturedMcpServers(
  catalog: McpCatalogPayload = getBuiltinMcpCatalogPayload()
): RecommendedMcpServerEntry[] {
  return catalog.servers.filter((server) => server.officialFeatured && server.featuredSource === 'alma-mcp-registry');
}

export function mergeMcpCatalogWithBuiltinOfficialFeatured(
  catalog: McpCatalogPayload,
): McpCatalogPayload {
  const existingIds = new Set(catalog.servers.map((server) => server.id));
  const missingFeatured = getAlmaFeaturedMcpServers(getBuiltinMcpCatalogPayload())
    .filter((server) => !existingIds.has(server.id));

  if (missingFeatured.length === 0) {
    return catalog;
  }

  return {
    ...catalog,
    servers: [
      ...catalog.servers,
      ...missingFeatured,
    ],
  };
}
