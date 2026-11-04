import type { InputRedirectReceiptMetadata } from '../../../shared/contract';
import { generateMessageId } from '../../../shared/utils/id';
import { createLogger } from '../../services/infra/logger';
import type { RuntimeContext } from './runtimeContext';

const logger = createLogger('AgentLoop');

export async function persistInputRedirectReceipt(
  ctx: Pick<RuntimeContext, 'persistMessage' | 'onEvent'>,
  input: {
    newMessage: string;
    displayContent?: string;
    expectedTurnId?: string;
    partial: InputRedirectReceiptMetadata['partial'];
    interruptedTools: string[];
  },
): Promise<void> {
  const receipt: InputRedirectReceiptMetadata = {
    receiptId: generateMessageId(),
    originalContent: input.displayContent ?? input.newMessage,
    expectedTurnId: input.expectedTurnId,
    partial: input.partial,
    interruptedTools: input.interruptedTools,
  };
  try {
    await ctx.persistMessage?.({
      id: receipt.receiptId,
      role: 'system',
      content: '已按你的纠正改了方向',
      timestamp: Date.now(),
      metadata: { inputRedirectReceipt: receipt },
    });
  } catch (err) {
    logger.warn('[ConversationRuntime] persist input redirect receipt failed:', err);
  }
  ctx.onEvent({ type: 'input_redirected', data: receipt });
}
