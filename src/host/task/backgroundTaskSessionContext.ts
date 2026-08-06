import { getSessionManager, type SessionWithMessages } from '../services/infra/sessionManager';
import { SESSION_COMMAND_CENTER_TOOL_NAMES } from '../../shared/constants/sessionCommandCenter';

export type BackgroundTaskSessionContext = Pick<SessionWithMessages, 'messages' | 'workingDirectory'>;

function isConsumedVoiceDispatchCommand(
  message: SessionWithMessages['messages'][number],
): boolean {
  return message.role === 'user'
    && message.metadata?.source === 'voice'
    && /spawn[\s_-]*task|派发任务工具/i.test(message.content);
}

function excludeCommandCenterDispatchTurns(
  messages: SessionWithMessages['messages'],
): SessionWithMessages['messages'] {
  const dispatchToolNames = new Set<string>(SESSION_COMMAND_CENTER_TOOL_NAMES);
  const excludedIndexes = new Set<number>();
  let turnStart = 0;

  for (let index = 0; index <= messages.length; index += 1) {
    const startsNextTurn = index === messages.length
      || (index > turnStart && messages[index]?.role === 'user');
    if (!startsNextTurn) continue;

    const turn = messages.slice(turnStart, index);
    const isDispatchTurn = turn.some((message) => message.role === 'assistant'
      && message.toolCalls?.some((toolCall) => dispatchToolNames.has(toolCall.name)));
    if (isDispatchTurn) {
      for (let turnIndex = turnStart; turnIndex < index; turnIndex += 1) {
        excludedIndexes.add(turnIndex);
      }
    }
    turnStart = index;
  }

  return messages.filter((_message, index) => !excludedIndexes.has(index));
}

export async function getBackgroundTaskSessionContext(
  sessionId: string,
): Promise<BackgroundTaskSessionContext | null> {
  const session = await getSessionManager().getSession(sessionId);
  if (!session) return null;
  const foregroundMessages = session.messages.filter(
    (message) => !message.isMeta
      && message.visibility !== 'rewound'
      && !isConsumedVoiceDispatchCommand(message),
  );
  return {
    // auxiliary run 的消息会回写同一 Neo 会话并标为 meta。新槽只继承前台历史，
    // 不能把兄弟槽的中间推理和工具结果、也不能把已经消费过的指挥台派发 turn
    // 当成自己的指令。真正的任务 prompt 会由 startBackgroundTask 单独追加。
    messages: excludeCommandCenterDispatchTurns(foregroundMessages),
    ...(session.workingDirectory ? { workingDirectory: session.workingDirectory } : {}),
  };
}
