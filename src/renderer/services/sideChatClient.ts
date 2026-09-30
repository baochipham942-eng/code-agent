import { IPC_CHANNELS } from '@shared/ipc';
import { generateMessageId } from '@shared/utils/id';
import { invoke } from './ipcService';

function readAnswer(result: unknown): string {
  if (result && typeof result === 'object' && 'answer' in result && typeof result.answer === 'string') {
    return result.answer;
  }
  const message = result && typeof result === 'object' && 'error' in result
    ? (result.error as { message?: unknown } | undefined)?.message
    : undefined;
  throw new Error(typeof message === 'string' && message ? message : 'SIDE_CHAT_FAILED');
}

/** Ask the host. `signal` abort invokes SIDE_CHAT_ABORT and drops a late answer. */
export async function askSideChat(
  input: { sessionId: string; question: string },
  signal: AbortSignal,
): Promise<string> {
  const requestId = generateMessageId();
  const abortHost = () => {
    void invoke(IPC_CHANNELS.SIDE_CHAT_ABORT, { requestId });
  };
  if (signal.aborted) {
    abortHost();
    throw new Error('SIDE_CHAT_ABORTED');
  }
  signal.addEventListener('abort', abortHost, { once: true });
  try {
    const result = await invoke(IPC_CHANNELS.SIDE_CHAT_ASK, {
      sessionId: input.sessionId,
      question: input.question,
      requestId,
    });
    if (signal.aborted) throw new Error('SIDE_CHAT_ABORTED');
    return readAnswer(result);
  } finally {
    signal.removeEventListener('abort', abortHost);
  }
}
