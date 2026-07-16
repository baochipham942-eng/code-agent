// ============================================================================
// Skill IPC Handlers - skill:* 通道
// 处理 Skill 仓库管理和会话挂载相关的 IPC 请求
// ============================================================================

import type { IpcMain } from '../platform';
import { SKILL_CHANNELS } from '../../shared/ipc/channels';
import { getSkillRepositoryService } from '../services/skills/skillRepositoryService';
import { getSessionSkillService } from '../services/skills/sessionSkillService';
import { getSkillDiscoveryService } from '../services/skills/skillDiscoveryService';
import { getProjectSkillPreferenceStore } from '../services/skills/projectSkillPreferenceService';
import { RECOMMENDED_REPOSITORIES } from '../services/skills/skillRepositories';
import { getCloudConfigService } from '../services/cloud';
import type { SkillRepository } from '../../shared/contract/skillRepository';
import { createLogger } from '../services/infra/logger';
import { getConfigService } from '../services/core/configService';
import { getComboRecorder } from '../services/skills/comboRecorder';
import { listSkillDrafts, confirmSkillDraft, rejectSkillDraft } from '../services/skills/skillDraftQueue';
import { getRemoteSkillRegistryService } from '../skills/marketplace/remoteSkillRegistryService';
import { installFromRegistryEntry } from '../skills/marketplace/installService';
import { matchSkillRegistryDraftRecommendations } from '../skills/marketplace/skillRegistryMatcher';
import { isProjectConfigTrusted } from '../security/folderTrustService';

const logger = createLogger('SkillIPC');
const registryDraftRecommendationsBySession = new Map<string, Set<string>>();

// ============================================================================
// Internal Handlers
// ============================================================================

function getSkillIpcWorkingDirectory(): string {
  const discovery = getSkillDiscoveryService();
  return discovery.getWorkingDirectory()
    || process.env.CODE_AGENT_WORKING_DIR
    || process.cwd();
}

async function ensureSkillDiscoveryForIpc(): Promise<void> {
  const discovery = getSkillDiscoveryService();
  await discovery.ensureInitialized(getSkillIpcWorkingDirectory());
}

// ----------------------------------------------------------------------------
// Repository Management
// ----------------------------------------------------------------------------

/**
 * 获取已下载仓库列表
 */
async function handleRepoList() {
  const service = getSkillRepositoryService();
  await service.initialize();
  return service.getLocalLibraries();
}

/**
 * 下载仓库
 */
async function handleRepoDownload(repo: SkillRepository) {
  const service = getSkillRepositoryService();
  const result = await service.downloadRepository(repo);

  if (result.success) {
    // 刷新 skill discovery service
    const discoveryService = getSkillDiscoveryService();
    await discoveryService.refreshLibraries();
  }

  return result;
}

/**
 * 更新仓库
 */
async function handleRepoUpdate(repoId: string) {
  const service = getSkillRepositoryService();
  const result = await service.updateRepository(repoId);

  if (result.success && result.hasUpdates) {
    // 刷新 skill discovery service
    const discoveryService = getSkillDiscoveryService();
    await discoveryService.refreshLibraries();
  }

  return result;
}

/**
 * 删除仓库
 */
async function handleRepoRemove(repoId: string) {
  const service = getSkillRepositoryService();
  await service.removeRepository(repoId);

  // 刷新 skill discovery service
  const discoveryService = getSkillDiscoveryService();
  await discoveryService.refreshLibraries();
}

/**
 * 添加自定义仓库
 */
async function handleRepoAddCustom(url: string, name?: string) {
  const service = getSkillRepositoryService();
  const result = await service.addCustomRepository(url, name);

  if (result.success) {
    // 刷新 skill discovery service
    const discoveryService = getSkillDiscoveryService();
    await discoveryService.refreshLibraries();
  }

  return result;
}

// ----------------------------------------------------------------------------
// Official Skill Registry（远程 marketplace）
// ----------------------------------------------------------------------------

/**
 * 拉取官方 registry 货架（签名信封校验，失败即空货架 + 原因码）
 */
async function handleRegistryList() {
  return getRemoteSkillRegistryService().listItems();
}

/**
 * 从 registry 条目安装/升级。
 * 只认 host 侧新鲜拉取的条目（renderer 只传 name）；下载按收录钉点 + hash 强校验。
 */
async function handleRegistryInstall(name: string): Promise<{ success: boolean; error?: string }> {
  const entry = await getRemoteSkillRegistryService().getEntry(name);
  if (!entry) {
    return { success: false, error: `Registry entry not found: ${name}` };
  }
  // force: 升级=按新钉点重装；首装时目标不存在，force 无副作用
  await installFromRegistryEntry(entry, { force: true, enableAfterInstall: true });
  // 全量 reload：marketplace plugin 来源的 skill 不在 refreshLibraries 覆盖面内
  await getSkillDiscoveryService().reload();
  getRemoteSkillRegistryService().invalidateListCache(); // installed 标记变了，推荐缓存失效
  return { success: true };
}

// ----------------------------------------------------------------------------
// Skill Management
// ----------------------------------------------------------------------------

/**
 * 获取所有可用 skills，附带三态启停信息：
 * - globalEnabled：用户全局黑名单状态
 * - projectOverride：当前项目覆盖（true/false=强制启停，null=跟随全局）
 * - enabled：生效态（项目覆盖优先，否则全局），供既有消费方沿用
 */
async function handleSkillList() {
  await ensureSkillDiscoveryForIpc();
  const repoService = getSkillRepositoryService();
  await repoService.initialize();
  const discoveryService = getSkillDiscoveryService();
  const workingDirectory = getSkillIpcWorkingDirectory();
  const projectPreferencesTrusted = await isProjectConfigTrusted(workingDirectory, 'project-skill-preferences');
  const prefStore = projectPreferencesTrusted
    ? getProjectSkillPreferenceStore(workingDirectory)
    : null;
  return discoveryService.getAllSkills().map((skill) => {
    const globalEnabled = repoService.isSkillEnabled(skill.name);
    const override = prefStore?.getOverride(skill.name);
    const projectOverride = override === undefined ? null : override;
    return {
      ...skill,
      globalEnabled,
      projectOverride,
      enabled: projectOverride ?? globalEnabled,
    };
  });
}

/**
 * 设置当前项目内的 skill 启停覆盖（项目级 > 全局）
 */
async function handleSkillProjectSet(skillName: string, enabled: boolean) {
  getProjectSkillPreferenceStore(getSkillIpcWorkingDirectory()).setOverride(skillName, enabled);
  await refreshToolSearchRegistration();
}

/**
 * 清除当前项目内的 skill 覆盖，回落全局语义
 */
async function handleSkillProjectClear(skillName: string) {
  getProjectSkillPreferenceStore(getSkillIpcWorkingDirectory()).clearOverride(skillName);
  await refreshToolSearchRegistration();
}

/**
 * 全局启用 skill
 */
async function handleSkillEnable(skillName: string) {
  const service = getSkillRepositoryService();
  await service.initialize();
  service.enableSkill(skillName);
  // 同步 ToolSearch 注册表，让启用立即对模型生效
  await refreshToolSearchRegistration();
}

/**
 * 全局禁用 skill
 */
async function handleSkillDisable(skillName: string) {
  const service = getSkillRepositoryService();
  await service.initialize();
  service.disableSkill(skillName);
  // 同步 ToolSearch 注册表，让禁用立即对模型生效
  await refreshToolSearchRegistration();
}

/**
 * 启用状态变更后刷新 ToolSearch 注册表
 */
async function refreshToolSearchRegistration(): Promise<void> {
  try {
    await ensureSkillDiscoveryForIpc();
    getSkillDiscoveryService().registerSkillsToToolSearch();
  } catch (error) {
    logger.warn('Failed to refresh ToolSearch registration after toggle', { error });
  }
}

// ----------------------------------------------------------------------------
// Session Mounting
// ----------------------------------------------------------------------------

/**
 * 挂载到会话
 */
async function handleSessionMount(
  sessionId: string,
  skillName: string,
  libraryId: string
): Promise<boolean> {
  await ensureSkillDiscoveryForIpc();
  const service = getSessionSkillService();
  return service.mountSkill(sessionId, skillName, libraryId, 'manual');
}

/**
 * 从会话卸载
 */
function handleSessionUnmount(sessionId: string, skillName: string) {
  const service = getSessionSkillService();
  return service.unmountSkill(sessionId, skillName);
}

/**
 * 获取会话挂载列表
 */
function handleSessionList(sessionId: string) {
  const service = getSessionSkillService();
  return service.getMountedSkills(sessionId);
}

/**
 * 获取输入期 marketplace skill 推荐。
 * 收窄版只推未安装 official registry 条目，不再走本地已装 skill 或泛化能力启发。
 */
async function handleSessionRecommend(sessionId: string, userInput?: string) {
  const input = userInput ?? '';
  if (!input.trim()) return [];
  const seen = registryDraftRecommendationsBySession.get(sessionId) ?? new Set<string>();
  const items = await getRemoteSkillRegistryService().listItemsCached();
  const recommendations = matchSkillRegistryDraftRecommendations(input, items, {
    alreadyRecommendedSkillNames: seen,
  });
  if (recommendations.length > 0) {
    for (const recommendation of recommendations) {
      seen.add(recommendation.skillName);
    }
    registryDraftRecommendationsBySession.set(sessionId, seen);
  }
  return recommendations;
}

// ----------------------------------------------------------------------------
// Recommended Repositories
// ----------------------------------------------------------------------------

/**
 * 获取推荐仓库列表
 * 云端目录下发优先，异常时降级到内置列表
 */
function handleRecommendedRepos() {
  try {
    return getCloudConfigService().getSkillCatalog().repositories;
  } catch {
    return RECOMMENDED_REPOSITORIES;
  }
}

/**
 * 获取 Skill 推荐目录（分类/条目/场景包/仓库）
 */
function handleSkillCatalog() {
  return getCloudConfigService().getSkillCatalog();
}

// ----------------------------------------------------------------------------
// SkillsMP Search
// ----------------------------------------------------------------------------

// API 返回的单个 skill 结构
interface SkillsMPAPISkill {
  id: string;
  name: string;
  author: string;
  description: string;
  githubUrl: string;
  skillUrl: string;
  stars: number;
  updatedAt: number;
}

// API 原始响应
interface SkillsMPAPIResponse {
  success: boolean;
  data?: {
    skills: SkillsMPAPISkill[];
    pagination: {
      total: number;
      page: number;
      limit: number;
    };
  };
  error?: string;
}

// 转换后给前端的结构
interface SkillsMPSearchResult {
  id: string;
  name: string;
  description: string;
  author: string;
  githubUrl: string;
  skillUrl: string;
  stars: number;
  updatedAt: number;
}

interface SkillsMPSearchResponse {
  success: boolean;
  data?: SkillsMPSearchResult[];
  total?: number;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * 搜索 SkillsMP 社区 Skills
 */
async function handleSkillsMPSearch(query: string, limit: number = 10): Promise<SkillsMPSearchResponse> {
  const configService = getConfigService();
  const apiKey = configService.getServiceApiKey('skillsmp');

  if (!apiKey) {
    return {
      success: false,
      error: {
        code: 'MISSING_API_KEY',
        message: '未配置 SkillsMP API Key。请在设置中配置 SKILLSMP_API_KEY 环境变量。',
      },
    };
  }

  try {
    const response = await fetch(
      `https://skillsmp.com/api/v1/skills/search?q=${encodeURIComponent(query)}&limit=${limit}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        // 30 second timeout
        signal: AbortSignal.timeout(30000),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('SkillsMP search failed', { status: response.status, error: errorText });

      if (response.status === 401 || response.status === 403) {
        return {
          success: false,
          error: {
            code: 'INVALID_API_KEY',
            message: 'SkillsMP API Key 无效或已过期。',
          },
        };
      }

      return {
        success: false,
        error: {
          code: 'HTTP_ERROR',
          message: `HTTP ${response.status}: ${errorText}`,
        },
      };
    }

    const apiResponse = await response.json() as SkillsMPAPIResponse;

    // 转换 API 响应为前端期望的格式
    if (apiResponse.success && apiResponse.data?.skills) {
      const skills = apiResponse.data.skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        author: skill.author,
        githubUrl: skill.githubUrl,
        skillUrl: skill.skillUrl,
        stars: skill.stars,
        updatedAt: skill.updatedAt,
      }));

      return {
        success: true,
        data: skills,
        total: apiResponse.data.pagination?.total,
      };
    }

    return {
      success: false,
      error: {
        code: 'EMPTY_RESPONSE',
        message: apiResponse.error || '搜索返回空结果',
      },
    };
  } catch (error) {
    logger.error('SkillsMP search error', { error });

    if (error instanceof Error && error.name === 'TimeoutError') {
      return {
        success: false,
        error: {
          code: 'TIMEOUT',
          message: '搜索请求超时，请稍后重试。',
        },
      };
    }

    return {
      success: false,
      error: {
        code: 'NETWORK_ERROR',
        message: '网络请求失败，请检查网络连接。',
      },
    };
  }
}

// ============================================================================
// Public Registration
// ============================================================================

/**
 * 注册 Skill 相关 IPC handlers
 */
export function registerSkillHandlers(ipcMain: IpcMain): void {
  logger.info('Registering skill handlers');

  // ------------------------------------------------------------------------
  // Repository Management
  // ------------------------------------------------------------------------

  ipcMain.handle(SKILL_CHANNELS.REPO_LIST, async () => {
    try {
      return await handleRepoList();
    } catch (error) {
      logger.error('Failed to list repositories', { error });
      throw error;
    }
  });

  ipcMain.handle(SKILL_CHANNELS.REPO_DOWNLOAD, async (_, repo: SkillRepository) => {
    try {
      return await handleRepoDownload(repo);
    } catch (error) {
      logger.error('Failed to download repository', { error });
      throw error;
    }
  });

  ipcMain.handle(SKILL_CHANNELS.REPO_UPDATE, async (_, repoId: string) => {
    try {
      return await handleRepoUpdate(repoId);
    } catch (error) {
      logger.error('Failed to update repository', { error });
      throw error;
    }
  });

  ipcMain.handle(SKILL_CHANNELS.REPO_REMOVE, async (_, repoId: string) => {
    try {
      await handleRepoRemove(repoId);
    } catch (error) {
      logger.error('Failed to remove repository', { error });
      throw error;
    }
  });

  ipcMain.handle(
    SKILL_CHANNELS.REPO_ADD_CUSTOM,
    async (_, url: string, name?: string) => {
      try {
        return await handleRepoAddCustom(url, name);
      } catch (error) {
        logger.error('Failed to add custom repository', { error });
        throw error;
      }
    }
  );

  // ------------------------------------------------------------------------
  // Official Skill Registry
  // ------------------------------------------------------------------------

  ipcMain.handle(SKILL_CHANNELS.REGISTRY_LIST, async () => {
    try {
      return await handleRegistryList();
    } catch (error) {
      logger.error('Failed to list skill registry', { error });
      throw error;
    }
  });

  ipcMain.handle(SKILL_CHANNELS.REGISTRY_INSTALL, async (_, name: string) => {
    try {
      return await handleRegistryInstall(name);
    } catch (error) {
      logger.error('Failed to install from skill registry', { name, error });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  // ------------------------------------------------------------------------
  // Skill Management
  // ------------------------------------------------------------------------

  ipcMain.handle(SKILL_CHANNELS.SKILL_LIST, async () => {
    try {
      return await handleSkillList();
    } catch (error) {
      logger.error('Failed to list skills', { error });
      throw error;
    }
  });

  ipcMain.handle(SKILL_CHANNELS.SKILL_ENABLE, async (_, skillName: string) => {
    try {
      await handleSkillEnable(skillName);
    } catch (error) {
      logger.error('Failed to enable skill', { skillName, error });
      throw error;
    }
  });

  ipcMain.handle(SKILL_CHANNELS.SKILL_DISABLE, async (_, skillName: string) => {
    try {
      await handleSkillDisable(skillName);
    } catch (error) {
      logger.error('Failed to disable skill', { skillName, error });
      throw error;
    }
  });

  ipcMain.handle(SKILL_CHANNELS.SKILL_PROJECT_SET, async (_, skillName: string, enabled: boolean) => {
    try {
      await handleSkillProjectSet(skillName, enabled);
    } catch (error) {
      logger.error('Failed to set project skill override', { skillName, enabled, error });
      throw error;
    }
  });

  ipcMain.handle(SKILL_CHANNELS.SKILL_PROJECT_CLEAR, async (_, skillName: string) => {
    try {
      await handleSkillProjectClear(skillName);
    } catch (error) {
      logger.error('Failed to clear project skill override', { skillName, error });
      throw error;
    }
  });

  // ------------------------------------------------------------------------
  // Session Mounting
  // ------------------------------------------------------------------------

  ipcMain.handle(
    SKILL_CHANNELS.SESSION_MOUNT,
    async (_, sessionId: string, skillName: string, libraryId: string) => {
      try {
        return await handleSessionMount(sessionId, skillName, libraryId);
      } catch (error) {
        logger.error('Failed to mount skill', { sessionId, skillName, error });
        throw error;
      }
    }
  );

  ipcMain.handle(
    SKILL_CHANNELS.SESSION_UNMOUNT,
    (_, sessionId: string, skillName: string) => {
      try {
        return handleSessionUnmount(sessionId, skillName);
      } catch (error) {
        logger.error('Failed to unmount skill', { sessionId, skillName, error });
        throw error;
      }
    }
  );

  ipcMain.handle(SKILL_CHANNELS.SESSION_LIST, (_, sessionId: string) => {
    try {
      return handleSessionList(sessionId);
    } catch (error) {
      logger.error('Failed to list session skills', { sessionId, error });
      throw error;
    }
  });

  ipcMain.handle(
    SKILL_CHANNELS.SESSION_RECOMMEND,
    async (_, sessionId: string, userInput?: string) => {
      try {
        return await handleSessionRecommend(sessionId, userInput);
      } catch (error) {
        logger.error('Failed to get recommendations', { sessionId, error });
        throw error;
      }
    }
  );

  // ------------------------------------------------------------------------
  // Recommended Repositories
  // ------------------------------------------------------------------------

  ipcMain.handle(SKILL_CHANNELS.RECOMMENDED_REPOS, () => {
    try {
      return handleRecommendedRepos();
    } catch (error) {
      logger.error('Failed to get recommended repos', { error });
      throw error;
    }
  });

  ipcMain.handle(SKILL_CHANNELS.CATALOG, () => {
    try {
      return handleSkillCatalog();
    } catch (error) {
      logger.error('Failed to get skill catalog', { error });
      throw error;
    }
  });

  // ------------------------------------------------------------------------
  // SkillsMP Search
  // ------------------------------------------------------------------------

  ipcMain.handle(
    SKILL_CHANNELS.SKILLSMP_SEARCH,
    async (_, query: string, limit?: number) => {
      try {
        return await handleSkillsMPSearch(query, limit);
      } catch (error) {
        logger.error('Failed to search SkillsMP', { error });
        throw error;
      }
    }
  );

  // ------------------------------------------------------------------------
  // Combo Skills Recording
  // ------------------------------------------------------------------------

  ipcMain.handle(SKILL_CHANNELS.COMBO_START, (_, sessionId: string) => {
    try {
      const recorder = getComboRecorder();
      recorder.startRecording(sessionId);
      return { success: true };
    } catch (error) {
      logger.error('Failed to start combo recording', { sessionId, error });
      throw error;
    }
  });

  ipcMain.handle(SKILL_CHANNELS.COMBO_STOP, (_, sessionId: string) => {
    try {
      const recorder = getComboRecorder();
      recorder.stopRecording(sessionId);
      return { success: true };
    } catch (error) {
      logger.error('Failed to stop combo recording', { sessionId, error });
      throw error;
    }
  });

  ipcMain.handle(SKILL_CHANNELS.COMBO_MARK_TURN, (_, sessionId: string, userMessage: string) => {
    try {
      const recorder = getComboRecorder();
      recorder.markTurn(sessionId, userMessage);
      return { success: true };
    } catch (error) {
      logger.error('Failed to mark combo turn', { sessionId, error });
      throw error;
    }
  });

  ipcMain.handle(SKILL_CHANNELS.COMBO_CHECK_SUGGESTION, (_, sessionId: string) => {
    try {
      const recorder = getComboRecorder();
      return recorder.checkSuggestion(sessionId);
    } catch (error) {
      logger.error('Failed to check combo suggestion', { sessionId, error });
      throw error;
    }
  });

  ipcMain.handle(
    SKILL_CHANNELS.COMBO_SAVE,
    async (_, sessionId: string, name: string, description: string, workingDirectory?: string) => {
      try {
        const recorder = getComboRecorder();
        return await recorder.saveAsSkill(sessionId, name, description, workingDirectory);
      } catch (error) {
        logger.error('Failed to save combo skill', { sessionId, name, error });
        throw error;
      }
    }
  );

  ipcMain.handle(SKILL_CHANNELS.COMBO_GET_RECORDING, (_, sessionId: string) => {
    try {
      const recorder = getComboRecorder();
      const recording = recorder.getRecording(sessionId);
      if (!recording) return null;
      // Serialize Set for IPC
      return {
        ...recording,
        toolNames: Array.from(recording.toolNames),
      };
    } catch (error) {
      logger.error('Failed to get combo recording', { sessionId, error });
      throw error;
    }
  });

  // ------------------------------------------------------------------------
  // Skill 草稿确认队列（GAP-005 半自动蒸馏，严禁自动入库）
  // ------------------------------------------------------------------------

  ipcMain.handle(SKILL_CHANNELS.DRAFT_LIST, async () => {
    try {
      return await listSkillDrafts();
    } catch (error) {
      logger.error('Failed to list skill drafts', { error });
      throw error;
    }
  });

  ipcMain.handle(
    SKILL_CHANNELS.DRAFT_CONFIRM,
    async (_, draftId: string, workingDirectory?: string) => {
      try {
        const result = await confirmSkillDraft(draftId, workingDirectory);
        if (result.success) {
          // 入库后重扫 skill discovery，让新 skill 立即可用
          const discoveryService = getSkillDiscoveryService();
          await discoveryService.initialize(workingDirectory || getSkillIpcWorkingDirectory());
        }
        return result;
      } catch (error) {
        logger.error('Failed to confirm skill draft', { draftId, error });
        throw error;
      }
    }
  );

  ipcMain.handle(SKILL_CHANNELS.DRAFT_REJECT, async (_, draftId: string) => {
    try {
      return await rejectSkillDraft(draftId);
    } catch (error) {
      logger.error('Failed to reject skill draft', { draftId, error });
      throw error;
    }
  });

  logger.info('Skill handlers registered', {
    channels: Object.values(SKILL_CHANNELS),
  });
}
