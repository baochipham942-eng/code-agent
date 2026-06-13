// ============================================================================
// Skill Store - 会话级 Skill 管理状态
// 用于管理当前会话的 Skill 挂载/卸载
// ============================================================================

import { create } from 'zustand';
import type {
  SessionSkillMount,
  LocalSkillLibrary,
  SkillRecommendation,
} from '@shared/contract/skillRepository';
import type { ParsedSkill } from '@shared/contract/agentSkill';
import { createLogger } from '../utils/logger';
import ipcService from '../services/ipcService';

// Skill IPC 通道常量（与 src/shared/ipc/channels.ts 保持一致）
const SKILL_CHANNELS = {
  SESSION_LIST: 'skill:session:list',
  SESSION_MOUNT: 'skill:session:mount',
  SESSION_UNMOUNT: 'skill:session:unmount',
  SESSION_RECOMMEND: 'skill:session:recommend',
  SKILL_LIST: 'skill:list',
} as const;

const logger = createLogger('SkillStore');

// skill:* 通道尚未进 IpcInvokeHandlers 联合类型，走 ipcService 的具名逃生入口
const invokeSkillChannel = <T>(channel: string, ...args: unknown[]): Promise<T | undefined> => {
  return ipcService.unsafeInvoke<T | undefined>(channel, ...args) ?? Promise.resolve(undefined);
};

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

interface SkillState {
  /** 当前会话挂载的 skills */
  mountedSkills: SessionSkillMount[];
  /** 所有可用的 skills */
  availableSkills: ParsedSkill[];
  /** 推荐的 skills */
  recommendations: SkillRecommendation[];
  /** 本地库列表 */
  localLibraries: LocalSkillLibrary[];
  /** 加载状态 */
  loading: boolean;
  /** 错误信息 */
  error: string | null;
  /** 当前会话 ID */
  currentSessionId: string | null;
}

interface SkillActions {
  /** 设置当前会话 */
  setCurrentSession: (sessionId: string) => void;
  /** 获取当前会话的挂载列表 */
  fetchMountedSkills: (options?: { force?: boolean }) => Promise<void>;
  /** 获取所有可用 skills */
  fetchAvailableSkills: () => Promise<void>;
  /** 获取推荐 skills */
  fetchRecommendations: (userInput?: string) => Promise<void>;
  /** 挂载 skill 到当前会话 */
  mountSkill: (skillName: string, libraryId: string) => Promise<boolean>;
  /** 从当前会话卸载 skill */
  unmountSkill: (skillName: string) => Promise<boolean>;
  /** 刷新所有数据 */
  refreshAll: () => Promise<void>;
  /** 清除错误 */
  clearError: () => void;
}

type SkillStore = SkillState & SkillActions;

// ----------------------------------------------------------------------------
// Store
// ----------------------------------------------------------------------------

// In-flight Promise 去重：组件树里多个 hook 实例（useWorkbenchCapabilities /
// useWorkbenchCapabilityRegistry 等）首次 mount 时会同步触发 fetchAvailable，
// 在第一次 set 落地前所有调用者读到的 availableSkills.length 都是 0，会发出
// N 个并行请求。这里把进行中的 Promise 暂存，让并发调用共享同一次请求。
let availableSkillsInFlight: Promise<void> | null = null;
let mountedSkillsInFlight: { sessionId: string; promise: Promise<void> } | null = null;
let mountedSkillsRequestSeq = 0;

export const useSkillStore = create<SkillStore>()((set, get) => ({
  // 初始状态
  mountedSkills: [],
  availableSkills: [],
  recommendations: [],
  localLibraries: [],
  loading: false,
  error: null,
  currentSessionId: null,

  // 设置当前会话
  setCurrentSession: (sessionId: string) => {
    const { currentSessionId } = get();
    if (currentSessionId === sessionId) return;

    set({ currentSessionId: sessionId });
    // 切换会话时重新加载挂载列表
    get().fetchMountedSkills();
  },

  // 获取当前会话的挂载列表
  fetchMountedSkills: async (options?: { force?: boolean }) => {
    const { currentSessionId } = get();
    if (!currentSessionId) {
      logger.debug('No current session, skipping fetchMountedSkills');
      return;
    }
    if (!options?.force && mountedSkillsInFlight?.sessionId === currentSessionId) {
      return mountedSkillsInFlight.promise;
    }

    const requestSeq = ++mountedSkillsRequestSeq;
    const promise = (async () => {
      try {
        set({ loading: true, error: null });
        const mounted = await invokeSkillChannel<SessionSkillMount[]>(
          SKILL_CHANNELS.SESSION_LIST,
          currentSessionId
        );
        if (requestSeq === mountedSkillsRequestSeq) {
          set({ mountedSkills: mounted || [] });
        }
        logger.debug('Fetched mounted skills', { count: (mounted || []).length });
      } catch (err) {
        const message = err instanceof Error ? err.message : '加载挂载列表失败';
        logger.error('Failed to fetch mounted skills', { error: err });
        if (requestSeq === mountedSkillsRequestSeq) {
          set({ error: message });
        }
      } finally {
        if (requestSeq === mountedSkillsRequestSeq) {
          set({ loading: false });
          mountedSkillsInFlight = null;
        }
      }
    })();
    mountedSkillsInFlight = { sessionId: currentSessionId, promise };
    return promise;
  },

  // 获取所有可用 skills
  fetchAvailableSkills: async () => {
    if (availableSkillsInFlight) return availableSkillsInFlight;

    availableSkillsInFlight = (async () => {
      try {
        const skills = await invokeSkillChannel<ParsedSkill[]>(SKILL_CHANNELS.SKILL_LIST);
        set({ availableSkills: skills || [] });
        logger.debug('Fetched available skills', { count: (skills || []).length });
      } catch (err) {
        const message = err instanceof Error ? err.message : '加载可用 skills 失败';
        logger.error('Failed to fetch available skills', { error: err });
        set({ error: message });
      } finally {
        availableSkillsInFlight = null;
      }
    })();
    return availableSkillsInFlight;
  },

  // 获取推荐 skills
  fetchRecommendations: async (userInput?: string) => {
    const { currentSessionId } = get();
    if (!currentSessionId) return;

    try {
      const recs = await invokeSkillChannel<SkillRecommendation[]>(
        SKILL_CHANNELS.SESSION_RECOMMEND,
        currentSessionId,
        userInput
      );
      set({ recommendations: recs || [] });
      logger.debug('Fetched recommendations', { count: (recs || []).length });
    } catch (err) {
      // 推荐失败不显示错误，只记录日志
      logger.warn('Failed to fetch recommendations', { error: err });
    }
  },

  // 挂载 skill 到当前会话
  mountSkill: async (skillName: string, libraryId: string) => {
    const { currentSessionId } = get();
    if (!currentSessionId) {
      logger.warn('Cannot mount skill: no current session');
      return false;
    }

    try {
      set({ loading: true, error: null });
      const mounted = await invokeSkillChannel<boolean>(
        SKILL_CHANNELS.SESSION_MOUNT,
        currentSessionId,
        skillName,
        libraryId
      );
      if (!mounted) {
        set({ error: `未找到 Skill：${skillName}`, loading: false });
        return false;
      }
      // 重新加载挂载列表
      await get().fetchMountedSkills({ force: true });
      logger.info('Skill mounted', { skillName, libraryId });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : '挂载失败';
      logger.error('Failed to mount skill', { skillName, error: err });
      set({ error: message, loading: false });
      return false;
    }
  },

  // 从当前会话卸载 skill
  unmountSkill: async (skillName: string) => {
    const { currentSessionId } = get();
    if (!currentSessionId) {
      logger.warn('Cannot unmount skill: no current session');
      return false;
    }

    try {
      set({ loading: true, error: null });
      await invokeSkillChannel<void>(
        SKILL_CHANNELS.SESSION_UNMOUNT,
        currentSessionId,
        skillName
      );
      // 重新加载挂载列表
      await get().fetchMountedSkills({ force: true });
      logger.info('Skill unmounted', { skillName });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : '卸载失败';
      logger.error('Failed to unmount skill', { skillName, error: err });
      set({ error: message, loading: false });
      return false;
    }
  },

  // 刷新所有数据
  refreshAll: async () => {
    await Promise.all([
      get().fetchMountedSkills(),
      get().fetchAvailableSkills(),
    ]);
  },

  // 清除错误
  clearError: () => {
    set({ error: null });
  },
}));
