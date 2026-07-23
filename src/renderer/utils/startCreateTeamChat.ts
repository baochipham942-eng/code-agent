import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';

const CREATE_TEAM_SEED = '/create-team';

export async function startCreateTeamChat(sessionTitle: string): Promise<void> {
  const app = useAppStore.getState();
  app.setShowSettings(false);
  const session = await useSessionStore.getState().createSession(sessionTitle);
  if (!session) return;
  app.setPendingRoleChatSeed(CREATE_TEAM_SEED);
}
