// ============================================================================
// Skill Repositories - Preconfigured and Recommended Repositories
// ============================================================================

import type { SkillRepository } from '@shared/types/skillRepository';

// ============================================================================
// Recommended Repositories
// ============================================================================

/**
 * 预配置的推荐 Skill 仓库
 */
export const RECOMMENDED_REPOSITORIES: SkillRepository[] = [
  {
    id: 'anthropic-skills',
    name: 'Anthropic Official Skills',
    url: 'https://github.com/baochipham942-eng/skills',
    branch: 'main',
    skillsPath: 'skills',
    category: 'core',
    recommended: true,
    description: '官方文档生成 Skills (PPT, Excel, Word, PDF)',
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
    description: '开发工作流 Skills (TDD, 调试, 代码审查)',
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
    description: '生产力 Skills (文件整理, 会议分析, 简历生成)',
    author: 'ComposioHQ',
  },
];

// ============================================================================
// Default Settings
// ============================================================================

/**
 * 应用启动时自动预下载的仓库 ID
 */
export const AUTO_DOWNLOAD_REPOS: string[] = ['anthropic-skills', 'superpowers'];

/**
 * 各仓库默认启用的 Skills
 */
export const DEFAULT_ENABLED_SKILLS: Record<string, string[]> = {
  'anthropic-skills': [
    'pptx', // PPT 生成
    'xlsx', // Excel 表格
    'docx', // Word 文档
    'pdf', // PDF 处理
    'frontend-design', // 前端设计
    'mcp-builder', // MCP 服务器构建
  ],
  superpowers: [
    'systematic-debugging', // 系统化调试
    'test-driven-development', // TDD
    'verification-before-completion', // 完成前验证
    'brainstorming', // 头脑风暴
  ],
  builtin: [
    'data-cleaning', // 数据清洗与分析
    'xlsx', // Excel 创建、公式、格式
  ],
  'composio-skills': [
    // Composio 默认不自动启用，用户需手动选择
  ],
};

// ============================================================================
// Keyword Mapping
// ============================================================================

/**
 * Skill 推荐关键词映射
 * 用于根据用户输入推荐相关 skills
 */
export const SKILL_KEYWORDS: Record<string, string[]> = {
  pptx: ['ppt', 'powerpoint', '演示', '幻灯片', 'slides', 'presentation'],
  xlsx: ['excel', '表格', '数据', 'spreadsheet', 'csv'],
  docx: ['word', '文档', 'document', '报告'],
  pdf: ['pdf', '阅读', '提取'],
  'frontend-design': ['前端', 'ui', '界面', '设计', 'frontend', 'react', 'css'],
  'systematic-debugging': ['调试', 'debug', 'bug', '错误', '问题'],
  'test-driven-development': ['测试', 'test', 'tdd', '单元测试'],
  brainstorming: ['创意', '头脑风暴', '想法', 'idea', 'brainstorm'],
  'data-cleaning': ['清洗', '数据清洗', 'clean', 'cleaning', '去重', '缺失值', '异常值'],
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * 根据关键词查找匹配的 Skill 名称
 */
export function findSkillsByKeyword(keyword: string): string[] {
  const lowerKeyword = keyword.toLowerCase();
  const matches: string[] = [];

  for (const [skillName, keywords] of Object.entries(SKILL_KEYWORDS)) {
    if (
      keywords.some(
        (kw) => kw.toLowerCase().includes(lowerKeyword) || lowerKeyword.includes(kw.toLowerCase())
      )
    ) {
      matches.push(skillName);
    }
  }

  return matches;
}

/**
 * 获取仓库的默认启用 Skills
 */
export function getDefaultEnabledSkills(repoId: string): string[] {
  return DEFAULT_ENABLED_SKILLS[repoId] || [];
}

/**
 * 根据 ID 查找推荐仓库
 */
export function findRecommendedRepository(repoId: string): SkillRepository | undefined {
  return RECOMMENDED_REPOSITORIES.find((r) => r.id === repoId);
}
