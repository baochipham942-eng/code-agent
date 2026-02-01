// ============================================================================
// Skills Service - Agent Skills Standard
// ============================================================================

export {
  parseSkillMd,
  hasSkillMd,
} from './skillParser';

export {
  checkSkillDependencies,
  loadSkillReferences,
  loadSkillFull,
  loadSkillsBatch,
  getDependencyStatusSummary,
} from './skillLoader';

export {
  BUILTIN_SKILLS,
  getBuiltinSkills,
  getBuiltinSkill,
  isBuiltinSkill,
} from './builtinSkills';

export {
  getSkillDiscoveryService,
  resetSkillDiscoveryService,
  SkillDiscoveryService,
} from './skillDiscoveryService';

export {
  bridgeCloudSkill,
  unbridgeSkill,
} from './skillBridge';

export {
  parseGitHubUrl,
  downloadRepository,
  getLatestCommit,
  checkForUpdates,
  updateRepository,
  readRepoMeta,
  saveRepoMeta,
  readRepoMetaAsync,
  type GitHubRepoInfo,
  type DownloadOptions,
  type DownloadResult,
  type RepoMeta,
} from './gitDownloader';

export {
  RECOMMENDED_REPOSITORIES,
  AUTO_DOWNLOAD_REPOS,
  DEFAULT_ENABLED_SKILLS,
  SKILL_KEYWORDS,
  findSkillsByKeyword,
  getDefaultEnabledSkills,
  findRecommendedRepository,
} from './skillRepositories';

export {
  getSkillRepositoryService,
  resetSkillRepositoryService,
  SkillRepositoryService,
} from './skillRepositoryService';

export {
  getSessionSkillService,
  resetSessionSkillService,
  SessionSkillService,
} from './sessionSkillService';

export {
  getSkillWatcher,
  initSkillWatcher,
  resetSkillWatcher,
  SkillWatcher,
} from './skillWatcher';
