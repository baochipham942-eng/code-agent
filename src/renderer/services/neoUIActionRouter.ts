import { useMessageActionStore } from '../stores/messageActionStore';

/**
 * Typed boundary for conversation actions emitted by native Generative UI.
 * Legacy IACT remains the transport into ChatInput while its draft is local
 * component state; native components never construct CustomEvent directly.
 */
export const neoUIActionRouter = {
  fillComposer(text: string): void {
    const value = text.trim();
    if (!value) return;
    window.dispatchEvent(new CustomEvent<string>('iact:add', { detail: value }));
  },
  async sendConversation(text: string): Promise<void> {
    const value = text.trim();
    if (!value) return;
    await useMessageActionStore.getState().sendPrompt(value);
  },
};
