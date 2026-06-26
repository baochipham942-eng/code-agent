// ============================================================================
// Skill Repositories - Preconfigured and Recommended Repositories
// ============================================================================
// 推荐仓库 / 分类 / 推荐 skill / 角色场景包的静态数据统一放在
// @shared/constants/skillCatalog（main 与 renderer 共用），此处只保留
// main 进程专属的默认配置与帮助函数，并 re-export 数据保持既有导入不变。
// ============================================================================

// ============================================================================
// Recommended Repositories（re-export 自 shared catalog）
// ============================================================================

export {
  RECOMMENDED_REPOSITORIES,
  RECOMMENDED_SKILLS,
  SKILL_CATEGORIES,
  SKILL_ROLE_BUNDLES,
  findRecommendedRepository,
  groupRecommendedSkillsByCategory,
} from '@shared/constants/skillCatalog';

// ============================================================================
// Default Settings
// ============================================================================

/**
 * Recommended repositories that may be auto-downloaded only when the operator
 * explicitly opts in. Distributed builds should not fetch third-party skill
 * code on first launch.
 */
export const RECOMMENDED_AUTO_DOWNLOAD_REPOS: string[] = ['anthropic-skills', 'superpowers'];

export const RECOMMENDED_SKILL_AUTO_DOWNLOAD_ENV = 'CODE_AGENT_ALLOW_RECOMMENDED_SKILL_AUTO_DOWNLOAD';

export const AUTO_DOWNLOAD_REPOS: string[] = [];

export function isRecommendedSkillAutoDownloadAllowed(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): boolean {
  return env[RECOMMENDED_SKILL_AUTO_DOWNLOAD_ENV] === '1';
}

export function getDefaultAutoDownloadRepos(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): string[] {
  return isRecommendedSkillAutoDownloadAllowed(env)
    ? [...RECOMMENDED_AUTO_DOWNLOAD_REPOS]
    : [];
}

/**
 * 各仓库默认启用的 Skills
 */
export const DEFAULT_ENABLED_SKILLS: Record<string, string[]> = {
  'anthropic-skills': [
    // Remote repository skills are opt-in after the user downloads and enables them.
  ],
  superpowers: [
    // superpowers skill 名称与实际仓库不一致，暂不自动挂载
  ],
  builtin: [
    'data-cleaning', // 数据清洗与分析
    'xlsx', // Excel 创建、公式、格式
  ],
  'composio-skills': [
    // Composio 默认不自动启用，用户需手动选择
  ],
  'pm-claude-skills': [
    // 远程仓库 skill 下载后由用户手动选择启用
  ],
  'marketing-skills': [
    // 远程仓库 skill 下载后由用户手动选择启用
  ],
  'second-brain-skills': [
    // 远程仓库 skill 下载后由用户手动选择启用
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
  'frontend-slides': ['ppt', 'powerpoint', '演示', '幻灯片', 'slides', 'presentation'],
  xlsx: ['excel', '表格', '数据', 'spreadsheet', 'csv'],
  docx: ['word', '文档', 'document', '报告'],
  pdf: ['pdf', '阅读', '提取'],
  design: ['前端', 'ui', '界面', '设计', 'frontend', 'react', 'css'],
  'data-cleaning': ['清洗', '数据清洗', 'clean', 'cleaning', '去重', '缺失值', '异常值'],
  'task-brief-builder': [
    'brief',
    '任务简报',
    '范围',
    '边界',
    '验收',
    'definition of done',
    'scope',
    '拆一下需求',
  ],
  'research-brief-and-split': [
    '研究',
    '调研',
    '对标',
    '竞品',
    '版本对比',
    'release note',
    '借鉴',
    'explore',
    '分析一下',
  ],
  'implementation-closure': [
    '实现',
    '修复',
    'bug',
    '验证',
    'typecheck',
    '测试',
    'build',
    '收尾',
    '闭环',
  ],
  'reviewer-facing-delivery': [
    '审批',
    '可读性',
    'reviewer',
    '交付材料',
    'pr summary',
    'handoff',
    '发布说明',
    '申请表',
  ],
  'opencli-search': [
    'opencli',
    '复杂搜索',
    '社媒搜索',
    '登录态抓取',
    '反爬',
    '小红书',
    '知乎',
    '微博',
    'bilibili',
    'b站',
    'youtube',
    'twitter',
    'x.com',
    'reddit',
    '站内搜索',
  ],
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
