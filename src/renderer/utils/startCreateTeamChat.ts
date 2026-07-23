import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';

export async function startCreateTeamChat(sessionTitle: string): Promise<void> {
  useAppStore.getState().setShowSettings(false);
  const session = await useSessionStore.getState().createSession(sessionTitle);
  if (!session) return;
  window.dispatchEvent(new CustomEvent('app:openSeedComposer', { detail: { kind: 'team' } }));
}
