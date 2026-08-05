import { getSessionManager, type SessionWithMessages } from '../services/infra/sessionManager';

export type BackgroundTaskSessionContext = Pick<SessionWithMessages, 'messages' | 'workingDirectory'>;

function isConsumedVoiceDispatchCommand(
  message: SessionWithMessages['messages'][number],
): boolean {
  return message.role === 'user'
    && message.metadata?.source === 'voice'
    && /spawn[\s_-]*task|派发任务工具/i.test(message.content);
}

export async function getBackgroundTaskSessionContext(
  sessionId: string,
): Promise<BackgroundTaskSessionContext | null> {
  const session = await getSessionManager().getSession(sessionId);
  if (!session) return null;
  return {
    // auxiliary run 的消息会回写同一 Neo 会话并标为 meta。新槽只继承前台历史，
    // 不能把兄弟槽的中间推理和工具结果当成自己的上下文。
    messages: session.messages.filter(
      (message) => !message.isMeta && !isConsumedVoiceDispatchCommand(message),
    ),
    ...(session.workingDirectory ? { workingDirectory: session.workingDirectory } : {}),
  };
}
