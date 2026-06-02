// ============================================================================
// Skill Catalog - 推荐 Skill 目录（分类 / 条目 / 角色场景包 / 推荐仓库）
// ============================================================================
// 纯静态数据，main 与 renderer 共用。
// 后续运营化时由 cloudConfigService 云端下发覆盖，此处作为离线兜底默认值。
// 所有 skill 名称均与来源仓库的 skill 目录名核实一致（2026-06-02）。
// ============================================================================

import type {
  RecommendedSkillEntry,
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
    name: 'Anthropic Official Skills',
    url: 'https://github.com/baochipham942-eng/skills',
    branch: 'main',
    skillsPath: 'skills',
    category: 'core',
    recommended: true,
    description: '官方文档与创意 Skills（Word/PPT/PDF/前端设计/主题工厂）',
    author: 'Anthropic',
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
  { id: 'research', label: '研究调研', description: '深度调研、文献综述、用户研究' },
  { id: 'automation', label: '效率自动化', description: '文件整理、流程文档、状态报告' },
  { id: 'development', label: '开发工程', description: '调试、测试、代码审查、MCP 构建' },
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
  },
  {
    name: 'docx',
    displayName: 'Word 文档',
    description: '创建/编辑 Word 文档，支持目录、表格、批注、修订',
    category: 'docs-office',
    repoId: 'anthropic-skills',
    badge: '官方生产级',
  },
  {
    name: 'pdf',
    displayName: 'PDF 处理',
    description: '提取文本/表格、合并拆分、表单填写、OCR',
    category: 'docs-office',
    repoId: 'anthropic-skills',
    badge: '官方生产级',
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
  },
  {
    name: 'internal-comms',
    displayName: '内部沟通',
    description: '撰写状态报告、领导层更新、公告、FAQ',
    category: 'docs-office',
    repoId: 'anthropic-skills',
    badge: '官方',
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
  },
  {
    name: 'cohort-analysis',
    displayName: '留存分群分析',
    description: 'Cohort 留存分析框架与解读',
    category: 'data-analysis',
    repoId: 'pm-claude-skills',
  },
  {
    name: 'sql-query-explainer',
    displayName: 'SQL 解释器',
    description: '把 SQL 查询翻译成业务语言，辅助非技术人员理解',
    category: 'data-analysis',
    repoId: 'pm-claude-skills',
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
  },
  {
    name: 'canvas-design',
    displayName: '视觉海报设计',
    description: '用设计哲学生成海报、封面等静态视觉作品',
    category: 'design-creative',
    repoId: 'anthropic-skills',
    badge: '官方',
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
  },
  {
    name: 'remotion',
    displayName: '程序化视频',
    description: '用 Remotion + React 以代码生成视频',
    category: 'design-creative',
    repoId: 'second-brain-skills',
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
  },
  {
    name: 'content-strategy',
    displayName: '内容策略',
    description: '内容规划、选题、分发渠道策略',
    category: 'content-marketing',
    repoId: 'marketing-skills',
  },
  {
    name: 'seo-audit',
    displayName: 'SEO 审计',
    description: '网站 SEO 问题诊断与优化建议',
    category: 'content-marketing',
    repoId: 'marketing-skills',
  },
  {
    name: 'social-media-strategy',
    displayName: '社媒策略',
    description: '社交媒体运营策略与内容日历',
    category: 'content-marketing',
    repoId: 'pm-claude-skills',
  },
  {
    name: 'notes-humanizer',
    displayName: '去 AI 腔',
    description: '改写 AI 生成内容，保留个人声音去除机器感',
    category: 'content-marketing',
    repoId: 'pm-claude-skills',
  },
  {
    name: 'competitor-profiling',
    displayName: '竞品画像',
    description: '竞争对手定位、信息流与营销策略画像',
    category: 'content-marketing',
    repoId: 'marketing-skills',
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
  },
  {
    name: 'competitive-analysis',
    displayName: '竞品分析',
    description: '结构化竞品对比分析与战略建议',
    category: 'research',
    repoId: 'pm-claude-skills',
  },
  {
    name: 'user-research-synthesis',
    displayName: '用户研究综合',
    description: '访谈/调研原始数据综合成洞察报告',
    category: 'research',
    repoId: 'pm-claude-skills',
  },
  {
    name: 'customer-research',
    displayName: '客户调研',
    description: '客户需求挖掘与调研方案设计',
    category: 'research',
    repoId: 'marketing-skills',
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
  },
  {
    name: 'project-status-report',
    displayName: '项目状态报告',
    description: '生成结构化项目进展报告',
    category: 'automation',
    repoId: 'pm-claude-skills',
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
      { name: 'competitive-analysis', displayName: '竞品分析', repoId: 'pm-claude-skills' },
      { name: 'customer-research', displayName: '客户调研', repoId: 'marketing-skills' },
    ],
  },
];

// ----------------------------------------------------------------------------
// Helper
// ----------------------------------------------------------------------------

/** 按分类分组推荐 skill（保持 SKILL_CATEGORIES 顺序） */
export function groupRecommendedSkillsByCategory(): Array<{
  category: SkillCategoryMeta;
  skills: RecommendedSkillEntry[];
}> {
  return SKILL_CATEGORIES.map((category) => ({
    category,
    skills: RECOMMENDED_SKILLS.filter((skill) => skill.category === category.id),
  })).filter((group) => group.skills.length > 0);
}

/** 根据 ID 查找推荐仓库 */
export function findRecommendedRepository(repoId: string): SkillRepository | undefined {
  return RECOMMENDED_REPOSITORIES.find((r) => r.id === repoId);
}
