import { IPC_CHANNELS, SIDE_CHAT_FAILURE_CAUSES, type SideChatFailureCause } from '@shared/ipc';
import { generateMessageId } from '@shared/utils/id';
import { invoke } from './ipcService';

/** askSideChat 的预期失败：cause 是宿主归并出的稳定 token，不带 provider 原始文案。 */
export class SideChatRequestError extends Error {
  constructor(readonly cause: SideChatFailureCause) {
    super(`SIDE_CHAT_${cause.toUpperCase()}`);
    this.name = 'SideChatRequestError';
  }
}

function readCause(result: unknown): SideChatFailureCause | undefined {
  const failure = result && typeof result === 'object' && 'failure' in result
    ? (result as { failure?: unknown }).failure
    : undefined;
  if (!failure || typeof failure !== 'object') return undefined;
  const cause = (failure as { cause?: unknown }).cause;
  return typeof cause === 'string' && (SIDE_CHAT_FAILURE_CAUSES as readonly string[]).includes(cause)
    ? (cause as SideChatFailureCause)
    : undefined;
}

function readAnswer(result: unknown): string {
  if (result && typeof result === 'object' && 'answer' in result && typeof result.answer === 'string') {
    return result.answer;
  }
  throw new SideChatRequestError(readCause(result) ?? 'unknown');
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
    throw new SideChatRequestError('unknown');
  }
  signal.addEventListener('abort', abortHost, { once: true });
  try {
    const result = await invoke(IPC_CHANNELS.SIDE_CHAT_ASK, {
      sessionId: input.sessionId,
      question: input.question,
      requestId,
    });
    if (signal.aborted) throw new SideChatRequestError('unknown');
    return readAnswer(result);
  } finally {
    signal.removeEventListener('abort', abortHost);
  }
}
