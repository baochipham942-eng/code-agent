// ============================================================================
// useSkillRecommendations - 聊天输入的 Skill 推荐（含未安装可获取的目录推荐）
// ============================================================================
// 用户输入命中技能关键词时，在输入框上方推荐：
// - 已安装未挂载的 skill → 一键挂载
// - 推荐目录里未安装的 skill → 一键安装来源仓库并挂载

import { useState, useEffect, useCallback } from 'react';
import { SKILL_CHANNELS } from '@shared/ipc/channels';
import type {
  SkillCatalogPayload,
  SkillRecommendation,
} from '@shared/contract/skillRepository';
import ipcService from '../../../../services/ipcService';
import { toast } from '../../../../hooks/useToast';
import { createLogger } from '../../../../utils/logger';
import type { SkillRecommendationView } from './CapabilitySuggestionStrip';

const logger = createLogger('useSkillRecommendations');

/** 输入防抖时长 */
const RECOMMEND_DEBOUNCE_MS = 500;
/** 触发推荐的最短输入长度 */
const MIN_INPUT_LENGTH = 4;
/** 最多展示的推荐数 */
// 降噪：一次只推最相关的 2 个，避免输入区塞一排技能（旧值 4 实测观感杂乱、黑话多）
const MAX_RECOMMENDATIONS = 2;

const invokeSkillIPC = async <T = unknown>(channel: string, ...args: unknown[]): Promise<T | undefined> => {
  try {
    const invoke = ipcService.invoke as unknown as (
      ipcChannel: string,
      ...ipcArgs: unknown[]
    ) => Promise<T>;
    return await invoke(channel, ...args);
  } catch (err) {
    logger.warn(`IPC invoke failed for ${channel}`, { error: err });
    return undefined;
  }
};

/** 输入是否应该触发推荐（跳过命令、@ 提及、过短输入） */
export function shouldFetchRecommendations(input: string): boolean {
  const text = input.trim();
  if (text.length < MIN_INPUT_LENGTH) return false;
  if (text.startsWith('/') || text.startsWith('@')) return false;
  return true;
}

export interface UseSkillRecommendationsResult {
  recommendations: SkillRecommendationView[];
  installingSkillName: string | null;
  mountRecommendedSkill: (recommendation: SkillRecommendationView, sessionIdOverride?: string | null) => Promise<boolean>;
  installRecommendedSkill: (recommendation: SkillRecommendationView, sessionIdOverride?: string | null) => Promise<boolean>;
}

export function useSkillRecommendations(
  currentSessionId: string | null,
  inputValue: string
): UseSkillRecommendationsResult {
  const [recommendations, setRecommendations] = useState<SkillRecommendationView[]>([]);
  const [installingSkillName, setInstallingSkillName] = useState<string | null>(null);

  // 输入变化 → 防抖拉取推荐
  useEffect(() => {
    if (!currentSessionId || !shouldFetchRecommendations(inputValue)) {
      setRecommendations([]);
      return;
    }

    const timer = setTimeout(async () => {
      const recs = await invokeSkillIPC<SkillRecommendation[]>(
        SKILL_CHANNELS.SESSION_RECOMMEND,
        currentSessionId,
        inputValue.trim()
      );
      setRecommendations((recs || []).slice(0, MAX_RECOMMENDATIONS));
    }, RECOMMEND_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [currentSessionId, inputValue]);

  // 挂载已安装的推荐 skill
  const mountRecommendedSkill = useCallback(async (
    recommendation: SkillRecommendationView,
    sessionIdOverride?: string | null,
  ) => {
    const targetSessionId = sessionIdOverride ?? currentSessionId;
    if (!targetSessionId) return false;
    const mounted = await invokeSkillIPC<boolean>(
      SKILL_CHANNELS.SESSION_MOUNT,
      targetSessionId,
      recommendation.skillName,
      recommendation.libraryId
    );
    if (mounted) {
      toast.success(`已挂载 ${recommendation.skillName}`);
      setRecommendations((prev) => prev.filter((item) => item.skillName !== recommendation.skillName));
      return true;
    } else {
      toast.error(`挂载失败: ${recommendation.skillName}`);
      return false;
    }
  }, [currentSessionId]);

  // 安装未安装的推荐 skill：下载来源仓库 → 挂载到当前会话
  const installRecommendedSkill = useCallback(async (
    recommendation: SkillRecommendationView,
    sessionIdOverride?: string | null,
  ) => {
    const targetSessionId = sessionIdOverride ?? currentSessionId;
    if (!targetSessionId || !recommendation.repoId) return false;
    setInstallingSkillName(recommendation.skillName);
    try {
      const catalog = await invokeSkillIPC<SkillCatalogPayload>(SKILL_CHANNELS.CATALOG);
      const repo = catalog?.repositories.find((item) => item.id === recommendation.repoId);
      if (!repo) {
        toast.error('未找到来源仓库');
        return false;
      }

      const result = await invokeSkillIPC<{ success: boolean; error?: string }>(
        SKILL_CHANNELS.REPO_DOWNLOAD,
        repo
      );
      if (!result?.success) {
        toast.error(result?.error || `安装失败: ${recommendation.displayName || recommendation.skillName}`);
        return false;
      }

      // 安装完成后挂载到当前会话，用户无需再去设置页操作
      const mounted = await invokeSkillIPC<boolean>(
        SKILL_CHANNELS.SESSION_MOUNT,
        targetSessionId,
        recommendation.skillName,
        recommendation.repoId
      );
      if (!mounted) {
        toast.error(`挂载失败: ${recommendation.displayName || recommendation.skillName}`);
        return false;
      }
      toast.success(`已安装并挂载「${recommendation.displayName || recommendation.skillName}」`);
      setRecommendations((prev) => prev.filter((item) => item.skillName !== recommendation.skillName));
      return true;
    } finally {
      setInstallingSkillName(null);
    }
  }, [currentSessionId]);

  return {
    recommendations,
    installingSkillName,
    mountRecommendedSkill,
    installRecommendedSkill,
  };
}
