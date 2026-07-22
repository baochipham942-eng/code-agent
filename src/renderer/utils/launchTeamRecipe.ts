import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { launchRecipe } from '../services/teamClient';

/** 点配方卡 → 关面板 → 建会话（title=配方名）→ 起团队。审批卡由 host 侧 scope-based 弹出。 */
export async function launchTeamRecipe(recipeId: string, recipeName: string, topic: string): Promise<void> {
  const app = useAppStore.getState();
  app.setShowExpertPanel(false);

  const session = await useSessionStore.getState().createSession(recipeName);
  if (!session) return;

  await launchRecipe(session.id, recipeId, topic);
}
