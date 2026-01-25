// ============================================================================
// Skill IPC Handlers - skill:* 通道
// 处理 Skill 仓库管理和会话挂载相关的 IPC 请求
// ============================================================================

import type { IpcMain } from 'electron';
import { SKILL_CHANNELS } from '../../shared/ipc/channels';
import { getSkillRepositoryService } from '../services/skills/skillRepositoryService';
import { getSessionSkillService } from '../services/skills/sessionSkillService';
import { getSkillDiscoveryService } from '../services/skills/skillDiscoveryService';
import { RECOMMENDED_REPOSITORIES } from '../services/skills/skillRepositories';
import type { SkillRepository } from '../../shared/types/skillRepository';
import { createLogger } from '../services/infra/logger';
import { getConfigService } from '../services/core/configService';

const logger = createLogger('SkillIPC');

// ============================================================================
// Internal Handlers
// ============================================================================

// ----------------------------------------------------------------------------
// Repository Management
// ----------------------------------------------------------------------------

/**
 * 获取已下载仓库列表
 */
async function handleRepoList() {
  const service = getSkillRepositoryService();
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
// Skill Management
// ----------------------------------------------------------------------------

/**
 * 获取所有可用 skills
 */
function handleSkillList() {
  const discoveryService = getSkillDiscoveryService();
  return discoveryService.getAllSkills();
}

/**
 * 全局启用 skill
 */
function handleSkillEnable(skillName: string) {
  const service = getSkillRepositoryService();
  service.enableSkill(skillName);
}

/**
 * 全局禁用 skill
 */
function handleSkillDisable(skillName: string) {
  const service = getSkillRepositoryService();
  service.disableSkill(skillName);
}

// ----------------------------------------------------------------------------
// Session Mounting
// ----------------------------------------------------------------------------

/**
 * 挂载到会话
 */
function handleSessionMount(
  sessionId: string,
  skillName: string,
  libraryId: string
) {
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
 * 获取推荐 skills
 */
function handleSessionRecommend(sessionId: string, userInput?: string) {
  const service = getSessionSkillService();
  return service.recommendSkills(sessionId, userInput || '');
}

// ----------------------------------------------------------------------------
// Recommended Repositories
// ----------------------------------------------------------------------------

/**
 * 获取推荐仓库列表
 */
function handleRecommendedRepos() {
  return RECOMMENDED_REPOSITORIES;
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
  // Skill Management
  // ------------------------------------------------------------------------

  ipcMain.handle(SKILL_CHANNELS.SKILL_LIST, () => {
    try {
      return handleSkillList();
    } catch (error) {
      logger.error('Failed to list skills', { error });
      throw error;
    }
  });

  ipcMain.handle(SKILL_CHANNELS.SKILL_ENABLE, (_, skillName: string) => {
    try {
      handleSkillEnable(skillName);
    } catch (error) {
      logger.error('Failed to enable skill', { skillName, error });
      throw error;
    }
  });

  ipcMain.handle(SKILL_CHANNELS.SKILL_DISABLE, (_, skillName: string) => {
    try {
      handleSkillDisable(skillName);
    } catch (error) {
      logger.error('Failed to disable skill', { skillName, error });
      throw error;
    }
  });

  // ------------------------------------------------------------------------
  // Session Mounting
  // ------------------------------------------------------------------------

  ipcMain.handle(
    SKILL_CHANNELS.SESSION_MOUNT,
    (_, sessionId: string, skillName: string, libraryId: string) => {
      try {
        return handleSessionMount(sessionId, skillName, libraryId);
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
    (_, sessionId: string, userInput?: string) => {
      try {
        return handleSessionRecommend(sessionId, userInput);
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

  logger.info('Skill handlers registered', {
    channels: Object.values(SKILL_CHANNELS),
  });
}
