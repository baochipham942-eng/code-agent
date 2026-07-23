import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { launchRecipe, type LaunchRecipeResult } from '../services/teamClient';

/** 点配方卡 → 关面板 → 建会话（title=配方名）→ 起团队。审批卡由 host 侧 scope-based 弹出。 */
export async function launchTeamRecipe(
  recipeId: string,
  recipeName: string,
  topic: string,
): Promise<LaunchRecipeResult> {
  const app = useAppStore.getState();
  app.setShowCapabilityHub(false);

  // 建会话失败不带 error：调用方用 i18n 文案兜底，避免这里硬编码中文串漏出到英文界面
  let session;
  try {
    session = await useSessionStore.getState().createSession(recipeName);
  } catch {
    return { ok: false };
  }
  if (!session) return { ok: false };

  return launchRecipe(session.id, recipeId, topic);
}
