// ============================================================================
// Skill Catalog - 推荐 Skill 目录（分类 / 条目 / 角色场景包 / 推荐仓库）
// ============================================================================
// 纯静态数据，main 与 renderer 共用。
// 后续运营化时由 cloudConfigService 云端下发覆盖，此处作为离线兜底默认值。
// 所有 skill 名称均与来源仓库的 skill 目录名核实一致（2026-06-02）。
// ============================================================================

import type {
  RecommendedSkillEntry,
  SkillCatalogPayload,
  SkillCategoryMeta,
  SkillRepository,
  SkillRoleBundle,
} from '../contract/skillRepository';
import { BUILTIN_REPO_ID } from '../contract/skillRepository';

// ----------------------------------------------------------------------------
// 推荐仓库（安装来源）
// ----------------------------------------------------------------------------

export const RECOMMENDED_REPOSITORIES: SkillRepository[] = [
  {
    id: 'anthropic-skills',
    name: 'Anthropic Skills（社区镜像）',
    url: 'https://github.com/baochipham942-eng/skills',
    branch: 'main',
    skillsPath: 'skills',
    category: 'core',
    recommended: true,
    description: 'Anthropic 文档与创意 Skills（Word/PPT/PDF/前端设计/主题工厂），托管于社区镜像仓库',
    author: 'Anthropic（社区镜像）',
  },
  {
    id: 'superpowers',
    name: 'Superpowers Workflow',
    url: 'https://github.com/obra/superpowers',
    branch: 'main',
    skillsPath: 'skills',
    category: 'workflow',
    recommended: true,
    description: '开发工作流 Skills（TDD、调试、代码审查、实施计划）',
    author: 'obra',
  },
  {
    id: 'composio-skills',
    name: 'Composio Productivity',
    url: 'https://github.com/ComposioHQ/awesome-claude-skills',
    branch: 'master',
    skillsPath: '.', // skills 在根目录
    category: 'productivity',
    recommended: true,
    description: '生产力 Skills（文件整理, 会议分析, 简历生成）',
    author: 'ComposioHQ',
  },
  {
    id: 'pm-claude-skills',
    name: 'PM Professional Skills',
    url: 'https://github.com/mohitagw15856/pm-claude-skills',
    branch: 'main',
    skillsPath: 'skills',
    category: 'productivity',
    recommended: true,
    description: '160+ 职业 Skills（产品/数据/销售/HR/法律/财务/客户成功）',
    author: 'mohitagw15856',
  },
  {
    id: 'marketing-skills',
    name: 'Marketing Skills',
    url: 'https://github.com/coreyhaines31/marketingskills',
    branch: 'main',
    skillsPath: 'skills',
    category: 'productivity',
    recommended: true,
    description: '40+ 营销 Skills（SEO/文案/CRO/增长/定价/竞品）',
    author: 'coreyhaines31',
  },
  {
    id: 'second-brain-skills',
    name: 'Second Brain Skills',
    url: 'https://github.com/coleam00/second-brain-skills',
    branch: 'main',
    skillsPath: '.claude/skills',
    category: 'productivity',
    recommended: true,
    description: '知识工作 Skills（品牌系统/SOP/程序化视频/PPT 生成）',
    author: 'coleam00',
  },
];

// ----------------------------------------------------------------------------
// 产物分类
// ----------------------------------------------------------------------------

export const SKILL_CATEGORIES: SkillCategoryMeta[] = [
  { id: 'docs-office', label: '文档办公', description: 'PPT、Excel、Word、PDF、会议纪要' },
  { id: 'data-analysis', label: '数据分析', description: '数据清洗、图表提取、留存分析' },
  { id: 'design-creative', label: '设计创意', description: '界面设计、海报、品牌、视频' },
  { id: 'content-marketing', label: '内容营销', description: '文案、SEO、社媒、竞品情报' },
  { id: 'product', label: '产品管理', description: '需求梳理、PRD、评审准备' },
  { id: 'research', label: '研究调研', description: '深度调研、文献综述、用户研究' },
  { id: 'automation', label: '效率自动化', description: '文件整理、流程文档、状态报告' },
  { id: 'development', label: '开发工程', description: '调试、测试、代码审查、MCP 构建' },
];

export type AlmaBundledSkillRecommendation =
  | 'covered'
  | 'default_visible'
  | 'conditional'
  | 'unsupported';

export interface AlmaBundledSkillMapping {
  name: string;
  displayName: string;
  recommendation: AlmaBundledSkillRecommendation;
  codeAgentSurface: string;
  rationale: string;
}

export const ALMA_BUNDLED_SKILL_MAPPINGS: AlmaBundledSkillMapping[] = [
  { name: 'browser', displayName: 'Browser', recommendation: 'covered', codeAgentSurface: 'Browser / Playwright / Live Preview', rationale: '网页读取、验证和浏览器自动化已由原生能力覆盖。' },
  { name: 'computer-use', displayName: 'Computer Use', recommendation: 'default_visible', codeAgentSurface: 'cua-driver / Computer Use Panel', rationale: '高价值本机能力，默认可见，保持显式启用和权限门。' },
  { name: 'daily-report', displayName: 'Daily Report', recommendation: 'conditional', codeAgentSurface: 'Cron / Summary workflow', rationale: '适合固定汇报场景，按用户启用定时工作流后推荐。' },
  { name: 'discord', displayName: 'Discord', recommendation: 'conditional', codeAgentSurface: 'Plugin / connector backlog', rationale: '社交平台能力，等对应 connector 或 plugin 权限边界明确后推荐。' },
  { name: 'file-manager', displayName: 'File Manager', recommendation: 'covered', codeAgentSurface: 'Workspace files / native file tools', rationale: '文件读取、搜索、编辑和附件处理已是主路径能力。' },
  { name: 'image-gen', displayName: 'Image Gen', recommendation: 'conditional', codeAgentSurface: 'Media generation service', rationale: '适合设计和内容生成场景，按任务意图推荐。' },
  { name: 'memory-management', displayName: 'Memory Management', recommendation: 'default_visible', codeAgentSurface: 'Memory settings / context memory', rationale: '和长期记忆、会话记忆强相关，建议默认可见。' },
  { name: 'music-gen', displayName: 'Music Gen', recommendation: 'conditional', codeAgentSurface: 'Media plugin backlog', rationale: '偏创意媒体，脱离 coding 主路径，按明确需求出现。' },
  { name: 'music-listener', displayName: 'Music Listener', recommendation: 'conditional', codeAgentSurface: 'Media plugin backlog', rationale: '需要音频输入与版权边界，暂放条件推荐。' },
  { name: 'notebook', displayName: 'Notebook', recommendation: 'default_visible', codeAgentSurface: 'Workspace / notes / docs', rationale: '适合研究和工作记录，可作为已有 workspace 能力入口。' },
  { name: 'plan-mode', displayName: 'Plan Mode', recommendation: 'default_visible', codeAgentSurface: 'Plan mode / todos', rationale: '和 code-agent 计划、todo、goal 流程直接相关。' },
  { name: 'programmatic-tools', displayName: 'Programmatic Tools', recommendation: 'covered', codeAgentSurface: 'Tool runtime / MCP / shell', rationale: '工具调用和程序化能力已在运行时内建。' },
  { name: 'reactions', displayName: 'Reactions', recommendation: 'unsupported', codeAgentSurface: 'No primary surface', rationale: '偏聊天社交反馈，暂不进入 code-agent 主工作流。' },
  { name: 'scheduler', displayName: 'Scheduler', recommendation: 'default_visible', codeAgentSurface: 'Cron / /schedule', rationale: '已有定时任务主路径，适合默认可见。' },
  { name: 'screenshot', displayName: 'Screenshot', recommendation: 'covered', codeAgentSurface: 'Appshots / desktop capture', rationale: '截图、Appshot 和桌面观察已有产品入口。' },
  { name: 'self-management', displayName: 'Self Management', recommendation: 'unsupported', codeAgentSurface: 'No primary surface', rationale: '偏个人助理和人格化管理，不进入默认 coding 工作面。' },
  { name: 'self-reflection', displayName: 'Self Reflection', recommendation: 'unsupported', codeAgentSurface: 'No primary surface', rationale: '偏个人助理反思，不进入默认 coding 工作面。' },
  { name: 'selfie', displayName: 'Selfie', recommendation: 'unsupported', codeAgentSurface: 'No primary surface', rationale: '偏社交表达，不进入 code-agent 主路径。' },
  { name: 'send-file', displayName: 'Send File', recommendation: 'covered', codeAgentSurface: 'Attachments / file sharing', rationale: '附件和文件发送已有 composer 能力。' },
  { name: 'skill-hub', displayName: 'Skill Hub', recommendation: 'covered', codeAgentSurface: 'Skills settings / discover', rationale: 'Skills 安装与发现页已承担这个入口。' },
  { name: 'skill-search', displayName: 'Skill Search', recommendation: 'covered', codeAgentSurface: 'SkillsMP search / skill catalog', rationale: '社区搜索和推荐目录已存在。' },
  { name: 'system-info', displayName: 'System Info', recommendation: 'covered', codeAgentSurface: 'Diagnostics / shell / native status', rationale: '系统诊断可由内置工具和诊断面板覆盖。' },
  { name: 'tasks', displayName: 'Tasks', recommendation: 'covered', codeAgentSurface: 'Todos / Task panel / Goal mode', rationale: '任务、todo 和 goal 已是产品主路径。' },
  { name: 'telegram', displayName: 'Telegram', recommendation: 'conditional', codeAgentSurface: 'Channel connector', rationale: '需要账号、消息权限和隐私边界，按用户启用后推荐。' },
  { name: 'thread-management', displayName: 'Thread Management', recommendation: 'covered', codeAgentSurface: 'Session / thread commands', rationale: '会话和线程管理已有原生入口。' },
  { name: 'todo', displayName: 'Todo', recommendation: 'covered', codeAgentSurface: 'Todos / task panel', rationale: '待办能力已在会话和任务面板中内建。' },
  { name: 'travel', displayName: 'Travel', recommendation: 'conditional', codeAgentSurface: 'Research / calendar / map MCP', rationale: '偏生活场景，可由搜索、日历、地图组合支持。' },
  { name: 'twitter-media', displayName: 'Twitter Media', recommendation: 'conditional', codeAgentSurface: 'OpenCLI / social connector', rationale: '需要登录态和平台边界，按社媒任务推荐。' },
  { name: 'video-reader', displayName: 'Video Reader', recommendation: 'conditional', codeAgentSurface: 'Media analysis backlog', rationale: '视频理解依赖媒体管线，按内容分析场景推荐。' },
  { name: 'voice', displayName: 'Voice', recommendation: 'conditional', codeAgentSurface: 'Voice input / audio services', rationale: '语音输入已有入口，更多语音能力按任务场景扩展。' },
  { name: 'web-fetch', displayName: 'Web Fetch', recommendation: 'covered', codeAgentSurface: 'Native web fetch / browser tools', rationale: '网页读取已有内置路径。' },
  { name: 'web-search', displayName: 'Web Search', recommendation: 'covered', codeAgentSurface: 'Search tools / MCP search catalog', rationale: '搜索可由内置搜索和 MCP 搜索目录覆盖。' },
  { name: 'xiaohongshu-cli', displayName: 'Xiaohongshu CLI', recommendation: 'conditional', codeAgentSurface: 'OpenCLI / social connector', rationale: '中文社媒场景高价值，但需要登录态和平台边界。' },
];

// ----------------------------------------------------------------------------
// 推荐 Skill 条目（skill 粒度，按产物分类）
// ----------------------------------------------------------------------------

export const RECOMMENDED_SKILLS: RecommendedSkillEntry[] = [
  // ---- 文档办公 ----
  {
    name: 'pptx',
    displayName: 'PPT 演示文稿',
    description: '创建/编辑 PowerPoint，支持模板、版式、演讲备注',
    category: 'docs-office',
    repoId: 'anthropic-skills',
    badge: '官方生产级',
    keywords: ['ppt', 'powerpoint', '演示', '幻灯片', 'slides', '汇报'],
  },
  {
    name: 'docx',
    displayName: 'Word 文档',
    description: '创建/编辑 Word 文档，支持目录、表格、批注、修订',
    category: 'docs-office',
    repoId: 'anthropic-skills',
    badge: '官方生产级',
    keywords: ['word', '文档', '报告', '合同模板'],
  },
  {
    name: 'pdf',
    displayName: 'PDF 处理',
    description: '提取文本/表格、合并拆分、表单填写、OCR',
    category: 'docs-office',
    repoId: 'anthropic-skills',
    badge: '官方生产级',
    keywords: ['pdf', '提取', '合并', '表单'],
  },
  {
    name: 'xlsx',
    displayName: 'Excel 表格',
    description: '创建/编辑电子表格，公式、图表、数据转换',
    category: 'docs-office',
    repoId: BUILTIN_REPO_ID,
  },
  {
    name: 'meeting-summary',
    displayName: '会议纪要',
    description: '会议录音/转录整理为结构化纪要与待办',
    category: 'docs-office',
    repoId: BUILTIN_REPO_ID,
  },
  {
    name: 'doc-coauthoring',
    displayName: '文档共创',
    description: '引导式协作撰写提案、技术规范、决策文档',
    category: 'docs-office',
    repoId: 'anthropic-skills',
    badge: '官方',
    keywords: ['提案', '技术规范', '决策文档', '共创'],
  },
  {
    name: 'internal-comms',
    displayName: '内部沟通',
    description: '撰写状态报告、领导层更新、公告、FAQ',
    category: 'docs-office',
    repoId: 'anthropic-skills',
    badge: '官方',
    keywords: ['周报', '公告', '状态报告', 'faq', '内部沟通'],
  },
  {
    name: 'reviewer-facing-delivery',
    displayName: '面向评审的交付',
    description: '把表格、PR、handoff、审批材料整理成一眼可审的产物',
    category: 'docs-office',
    repoId: BUILTIN_REPO_ID,
    keywords: ['审批', '申请表', '交付材料', 'PR 摘要', 'handoff', '可读性'],
  },

  // ---- 数据分析 ----
  {
    name: 'data-cleaning',
    displayName: '数据清洗',
    description: '去重、缺失值、异常值处理与数据规整',
    category: 'data-analysis',
    repoId: BUILTIN_REPO_ID,
  },
  {
    name: 'data-analysis-helper',
    displayName: '数据分析助手',
    description: '探索性分析、统计洞察、自动可视化',
    category: 'data-analysis',
    repoId: BUILTIN_REPO_ID,
  },
  {
    name: 'chart-data-extractor',
    displayName: '图表数据提取',
    description: '从图表截图中提取出结构化数据表格',
    category: 'data-analysis',
    repoId: 'pm-claude-skills',
    keywords: ['图表', '截图提取', '图片转表格'],
  },
  {
    name: 'cohort-analysis',
    displayName: '留存分群分析',
    description: 'Cohort 留存分析框架与解读',
    category: 'data-analysis',
    repoId: 'pm-claude-skills',
    keywords: ['留存', '分群', 'cohort'],
  },
  {
    name: 'sql-query-explainer',
    displayName: 'SQL 解释器',
    description: '把 SQL 查询翻译成业务语言，辅助非技术人员理解',
    category: 'data-analysis',
    repoId: 'pm-claude-skills',
    keywords: ['sql', '查询解释'],
  },
  {
    name: 'dashboard-brief',
    displayName: '仪表盘设计',
    description: '指标看板的设计 brief 与指标框架',
    category: 'data-analysis',
    repoId: 'pm-claude-skills',
  },

  // ---- 设计创意 ----
  {
    name: 'frontend-design',
    displayName: '前端界面设计',
    description: '生成有辨识度的生产级 Web 界面，摆脱 AI 模板审美',
    category: 'design-creative',
    repoId: 'anthropic-skills',
    badge: '官方热门',
    keywords: ['界面', '前端设计', 'ui', '网页设计', 'landing'],
  },
  {
    name: 'canvas-design',
    displayName: '视觉海报设计',
    description: '用设计哲学生成海报、封面等静态视觉作品',
    category: 'design-creative',
    repoId: 'anthropic-skills',
    badge: '官方',
    keywords: ['海报', '封面', '视觉设计'],
  },
  {
    name: 'theme-factory',
    displayName: '主题工厂',
    description: '给幻灯片/文档/落地页套用 10 套字体配色主题',
    category: 'design-creative',
    repoId: 'anthropic-skills',
    badge: '官方',
  },
  {
    name: 'brand-voice-generator',
    displayName: '品牌系统生成',
    description: '一次定义品牌色/语气，供其他产物复用保持一致',
    category: 'design-creative',
    repoId: 'second-brain-skills',
    keywords: ['品牌', 'vi', '品牌系统'],
  },
  {
    name: 'remotion',
    displayName: '程序化视频',
    description: '用 Remotion + React 以代码生成视频',
    category: 'design-creative',
    repoId: 'second-brain-skills',
    keywords: ['视频', '动画视频', '宣传片'],
  },
  {
    name: 'slack-gif-creator',
    displayName: 'GIF 动图制作',
    description: '制作适配聊天工具的小尺寸动画 GIF',
    category: 'design-creative',
    repoId: 'anthropic-skills',
    badge: '官方',
  },

  // ---- 内容营销 ----
  {
    name: 'copywriting',
    displayName: '营销文案',
    description: '落地页、广告、邮件等营销文案撰写',
    category: 'content-marketing',
    repoId: 'marketing-skills',
    badge: '社区热门',
    keywords: ['文案', '营销文案', '广告语', '落地页文案'],
  },
  {
    name: 'content-strategy',
    displayName: '内容策略',
    description: '内容规划、选题、分发渠道策略',
    category: 'content-marketing',
    repoId: 'marketing-skills',
    keywords: ['内容策略', '选题', '内容规划'],
  },
  {
    name: 'seo-audit',
    displayName: 'SEO 审计',
    description: '网站 SEO 问题诊断与优化建议',
    category: 'content-marketing',
    repoId: 'marketing-skills',
    keywords: ['seo', '搜索优化', '收录'],
  },
  {
    name: 'social-media-strategy',
    displayName: '社媒策略',
    description: '社交媒体运营策略与内容日历',
    category: 'content-marketing',
    repoId: 'pm-claude-skills',
    keywords: ['社媒', '小红书', '抖音', '运营策略'],
  },
  {
    name: 'notes-humanizer',
    displayName: '去 AI 腔',
    description: '改写 AI 生成内容，保留个人声音去除机器感',
    category: 'content-marketing',
    repoId: 'pm-claude-skills',
    keywords: ['去ai味', '人味', '改写', '降ai'],
  },
  {
    name: 'competitor-profiling',
    displayName: '竞品画像',
    description: '竞争对手定位、信息流与营销策略画像',
    category: 'content-marketing',
    repoId: 'marketing-skills',
    keywords: ['竞品画像', '对手分析'],
  },

  // ---- 研究调研 ----
  {
    name: 'literature-review',
    displayName: '文献综述',
    description: '多来源文献检索、对比与综述生成',
    category: 'research',
    repoId: BUILTIN_REPO_ID,
  },
  {
    name: 'paper-distillation',
    displayName: '论文蒸馏',
    description: '长论文提炼核心论点、方法与数据',
    category: 'research',
    repoId: BUILTIN_REPO_ID,
  },
  {
    name: 'research-monitor',
    displayName: '研究监控',
    description: '跟踪研究领域的最新进展',
    category: 'research',
    repoId: BUILTIN_REPO_ID,
    keywords: ['研究监控', '追踪论文', '监控竞品', 'release notes', '定时调研'],
  },
  {
    name: 'research-brief-and-split',
    displayName: '研究拆题',
    description: '把竞品、版本、模型、能力对标拆成可审阅研究 brief',
    category: 'research',
    repoId: BUILTIN_REPO_ID,
    keywords: ['研究', '调研', '竞品', '对标', '版本对比', 'release note', '借鉴'],
  },
  {
    name: 'opencli-search',
    displayName: 'OpenCLI 复杂搜索',
    description: '用本机 OpenCLI 处理登录态网站、社交平台、反爬页面和站点专用抓取',
    category: 'research',
    repoId: BUILTIN_REPO_ID,
    keywords: [
      'opencli',
      '复杂搜索',
      '社媒搜索',
      '登录态抓取',
      '反爬',
      '小红书',
      '知乎',
      '微博',
      'B站',
      'bilibili',
      'youtube',
      'twitter',
      'x.com',
      'reddit',
      '站内搜索',
    ],
  },
  {
    name: 'competitive-analysis',
    displayName: '竞品分析',
    description: '结构化竞品对比分析与战略建议',
    category: 'research',
    repoId: 'pm-claude-skills',
    keywords: ['竞品分析', '竞品对比', '竞争分析'],
  },
  {
    name: 'user-research-synthesis',
    displayName: '用户研究综合',
    description: '访谈/调研原始数据综合成洞察报告',
    category: 'research',
    repoId: 'pm-claude-skills',
    keywords: ['用户研究', '访谈', '调研综合'],
  },
  {
    name: 'customer-research',
    displayName: '客户调研',
    description: '客户需求挖掘与调研方案设计',
    category: 'research',
    repoId: 'marketing-skills',
    keywords: ['客户调研', '需求挖掘'],
  },

  // ---- 效率自动化 ----
  {
    name: 'computer-housekeeper',
    displayName: '电脑管家',
    description: '本机文件整理、磁盘清理、重复文件检测',
    category: 'automation',
    repoId: BUILTIN_REPO_ID,
  },
  {
    name: 'photo-archive',
    displayName: '照片整理',
    description: '照片按时间/主题自动归档整理',
    category: 'automation',
    repoId: BUILTIN_REPO_ID,
  },
  {
    name: 'image-ocr-search',
    displayName: '图片文字搜索',
    description: 'OCR 识别图片文字并建立可搜索索引',
    category: 'automation',
    repoId: BUILTIN_REPO_ID,
  },
  {
    name: 'contract-review',
    displayName: '合同审查',
    description: '合同条款风险识别与审查要点',
    category: 'automation',
    repoId: BUILTIN_REPO_ID,
  },
  {
    name: 'sop-creator',
    displayName: 'SOP 流程文档',
    description: '把口述流程整理成标准操作程序文档',
    category: 'automation',
    repoId: 'second-brain-skills',
    keywords: ['sop', '流程文档', '操作手册'],
  },
  {
    name: 'project-status-report',
    displayName: '项目状态报告',
    description: '生成结构化项目进展报告',
    category: 'automation',
    repoId: 'pm-claude-skills',
    keywords: ['项目报告', '进展汇报', '状态报告'],
  },
  {
    name: 'task-brief-builder',
    displayName: '任务简报',
    description: '先明确目标、现场、边界和验收，再选择研究或实现路线',
    category: 'automation',
    repoId: BUILTIN_REPO_ID,
    keywords: ['任务简报', 'brief', '边界', '验收', 'scope', 'definition of done'],
  },

  // ---- 开发工程 ----
  {
    name: 'systematic-debugging',
    displayName: '系统化调试',
    description: '先定位根因再修复的四阶段调试流程',
    category: 'development',
    repoId: 'superpowers',
    badge: '社区最热',
  },
  {
    name: 'test-driven-development',
    displayName: '测试驱动开发',
    description: 'TDD 工作流：先写测试再写实现',
    category: 'development',
    repoId: 'superpowers',
  },
  {
    name: 'implementation-closure',
    displayName: '实现闭环',
    description: '读代码、最小改动、跑验证，避免停在方案或未证实的修复',
    category: 'development',
    repoId: BUILTIN_REPO_ID,
    keywords: ['实现', '修复', '验证', 'typecheck', '测试', 'build', '闭环'],
  },
  {
    name: 'brainstorming',
    displayName: '需求梳理',
    description: '动手前先梳理意图、需求与设计',
    category: 'development',
    repoId: 'superpowers',
  },
  {
    name: 'writing-plans',
    displayName: '实施计划',
    description: '把需求拆解成可执行的多步实施计划',
    category: 'development',
    repoId: 'superpowers',
  },
  {
    name: 'webapp-testing',
    displayName: 'Web 应用测试',
    description: '用 Playwright 真实浏览器测试本地应用',
    category: 'development',
    repoId: 'anthropic-skills',
    badge: '官方',
  },
  {
    name: 'mcp-builder',
    displayName: 'MCP 构建器',
    description: '引导构建高质量 MCP Server（Python/TS）',
    category: 'development',
    repoId: 'anthropic-skills',
    badge: '官方',
  },
  {
    name: 'skill-creator',
    displayName: 'Skill 创建器',
    description: '创建和改进你自己的 Skill',
    category: 'development',
    repoId: 'anthropic-skills',
    badge: '官方',
  },
];

// ----------------------------------------------------------------------------
// 角色场景包
// ----------------------------------------------------------------------------

export const SKILL_ROLE_BUNDLES: SkillRoleBundle[] = [
  {
    id: 'product-manager',
    name: '产品经理包',
    description: 'PRD、竞品分析、用户研究、OKR、路线图一站式',
    skills: [
      { name: 'prd-template', displayName: 'PRD 模板', repoId: 'pm-claude-skills' },
      { name: 'competitive-analysis', displayName: '竞品分析', repoId: 'pm-claude-skills' },
      { name: 'user-research-synthesis', displayName: '用户研究综合', repoId: 'pm-claude-skills' },
      { name: 'okr-builder', displayName: 'OKR 制定', repoId: 'pm-claude-skills' },
      { name: 'roadmap-narrative', displayName: '路线图叙事', repoId: 'pm-claude-skills' },
      { name: 'rice-prioritisation', displayName: 'RICE 优先级', repoId: 'pm-claude-skills' },
      { name: 'meeting-summary', displayName: '会议纪要', repoId: BUILTIN_REPO_ID },
    ],
  },
  {
    id: 'growth-ops',
    name: '运营增长包',
    description: '内容、SEO、社媒、A/B 测试、数据分析全链路',
    skills: [
      { name: 'content-strategy', displayName: '内容策略', repoId: 'marketing-skills' },
      { name: 'seo-audit', displayName: 'SEO 审计', repoId: 'marketing-skills' },
      { name: 'copywriting', displayName: '营销文案', repoId: 'marketing-skills' },
      { name: 'ab-testing', displayName: 'A/B 测试', repoId: 'marketing-skills' },
      { name: 'social-media-strategy', displayName: '社媒策略', repoId: 'pm-claude-skills' },
      { name: 'data-analysis-helper', displayName: '数据分析助手', repoId: BUILTIN_REPO_ID },
    ],
  },
  {
    id: 'office-worker',
    name: '职场办公包',
    description: 'PPT、Word、Excel、会议纪要、周报日常全覆盖',
    skills: [
      { name: 'pptx', displayName: 'PPT 演示文稿', repoId: 'anthropic-skills' },
      { name: 'docx', displayName: 'Word 文档', repoId: 'anthropic-skills' },
      { name: 'xlsx', displayName: 'Excel 表格', repoId: BUILTIN_REPO_ID },
      { name: 'meeting-summary', displayName: '会议纪要', repoId: BUILTIN_REPO_ID },
      { name: 'internal-comms', displayName: '内部沟通', repoId: 'anthropic-skills' },
      { name: 'project-status-report', displayName: '项目状态报告', repoId: 'pm-claude-skills' },
    ],
  },
  {
    id: 'researcher',
    name: '研究者包',
    description: '文献综述、论文蒸馏、深度调研、竞品研究',
    skills: [
      { name: 'literature-review', displayName: '文献综述', repoId: BUILTIN_REPO_ID },
      { name: 'paper-distillation', displayName: '论文蒸馏', repoId: BUILTIN_REPO_ID },
      { name: 'research-monitor', displayName: '研究监控', repoId: BUILTIN_REPO_ID },
      { name: 'opencli-search', displayName: 'OpenCLI 复杂搜索', repoId: BUILTIN_REPO_ID },
      { name: 'competitive-analysis', displayName: '竞品分析', repoId: 'pm-claude-skills' },
      { name: 'customer-research', displayName: '客户调研', repoId: 'marketing-skills' },
    ],
  },
];

// ----------------------------------------------------------------------------
// Helper
// ----------------------------------------------------------------------------

/** 内置 skill 推荐目录载荷（云端未下发时的兜底） */
export function getBuiltinSkillCatalogPayload(): SkillCatalogPayload {
  return {
    categories: SKILL_CATEGORIES,
    skills: RECOMMENDED_SKILLS,
    bundles: SKILL_ROLE_BUNDLES,
    repositories: RECOMMENDED_REPOSITORIES,
  };
}

/** 按分类分组推荐 skill（保持分类顺序）；不传 catalog 时用内置目录 */
export function groupRecommendedSkillsByCategory(
  catalog: SkillCatalogPayload = getBuiltinSkillCatalogPayload()
): Array<{
  category: SkillCategoryMeta;
  skills: RecommendedSkillEntry[];
}> {
  return catalog.categories.map((category) => ({
    category,
    skills: catalog.skills.filter((skill) => skill.category === category.id),
  })).filter((group) => group.skills.length > 0);
}

/** 根据 ID 查找推荐仓库；不传 repositories 时在内置目录中查找 */
export function findRecommendedRepository(
  repoId: string,
  repositories: SkillRepository[] = RECOMMENDED_REPOSITORIES
): SkillRepository | undefined {
  return repositories.find((r) => r.id === repoId);
}
