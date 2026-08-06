import { randomUUID } from 'crypto';
import { MEMORY_TIMEOUTS } from '../../shared/constants';
import type { MemoryConfirmRequest } from '../../shared/contract/memory';
import { IPC_CHANNELS } from '../../shared/ipc';
import { broadcastToRenderer } from '../platform/windowBridge';

interface PendingDirectiveConfirmation {
  resolve: (result: DirectiveMemoryConfirmationResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface DirectiveMemoryConfirmationResult {
  requestId: string;
  confirmed: boolean;
  respondedAt: number;
}

const pending = new Map<string, PendingDirectiveConfirmation>();

export async function requestDirectiveMemoryConfirmation(input: {
  content: string;
  category: string;
}): Promise<DirectiveMemoryConfirmationResult> {
  const id = `directive-${randomUUID()}`;
  const request: MemoryConfirmRequest = {
    id,
    content: input.content,
    category: input.category,
    type: 'directive',
    authority: 'directive',
    confidence: 1,
    timestamp: Date.now(),
  };

  return new Promise<DirectiveMemoryConfirmationResult>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ requestId: id, confirmed: false, respondedAt: Date.now() });
    }, MEMORY_TIMEOUTS.DIRECTIVE_CONFIRM);
    pending.set(id, { resolve, timer });
    broadcastToRenderer(IPC_CHANNELS.MEMORY_CONFIRM_REQUEST, request);
  });
}

export function respondToDirectiveMemoryConfirmation(id: string, confirmed: boolean): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  clearTimeout(entry.timer);
  entry.resolve({ requestId: id, confirmed, respondedAt: Date.now() });
  return true;
}

export function assertDirectivePersistenceAuthorized(
  memoryType: string,
  explicitlyConfirmed: boolean,
): void {
  if (memoryType === 'directive' && !explicitlyConfirmed) {
    throw new Error('Directive memory requires explicit user confirmation.');
  }
}

export function clearDirectiveMemoryConfirmationsForTest(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
}
