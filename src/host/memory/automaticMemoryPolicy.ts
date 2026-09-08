import type { Message } from '../../shared/contract';
import type { RuntimeContext } from '../agent/runtime/runtimeContext';
import type { UntrustedContentPolicy } from '../protocol/tools';
import { canonicalToolName } from '../tools/toolNames';
import { getProtocolToolSchemas } from '../tools/protocolToolRegistration';
import { recordMemoryInjectionTrace } from './memoryInjectionTrace';

export function getUntrustedContentPolicy(toolName: string): UntrustedContentPolicy | undefined {
  const name = canonicalToolName(toolName);
  return getProtocolToolSchemas()
    .filter((schema) => schema.readsUntrustedContent !== undefined
      && name.startsWith(canonicalToolName(schema.name)))
    .sort((left, right) => right.name.length - left.name.length)[0]?.readsUntrustedContent;
}

export function hasUntrustedMemoryInput(messages: readonly Message[]): boolean {
  return messages.some((message) => message.metadata?.memoryTainted === true
    || Boolean(message.metadata?.channel)
    || message.metadata?.workbench?.memoryTainted === true
    || Boolean(message.metadata?.voiceTranscript || message.metadata?.workbench?.voiceInput)
    || Boolean(message.attachments?.length)
    || message.toolResults?.some((result) => result.metadata?.memoryTainted === true)
    || message.toolCalls?.some((call) => getUntrustedContentPolicy(call.name) !== undefined));
}

/** One admission rule shared by run-time writers and stored consolidation candidates. */
export function skipAutomaticMemory(
  provenance: { memoryTainted?: boolean },
  sessionId: string,
  source: string,
): boolean {
  if (provenance.memoryTainted !== true) return false;
  recordMemoryInjectionTrace({
    blockType: 'automatic_memory', trigger: 'skipped:tainted',
    injected: false, source, sessionId,
  });
  return true;
}

export function skipRunAutomaticMemory(ctx: RuntimeContext, source: string): boolean {
  const memoryTainted = ctx.control?.memoryTainted === true
    || hasUntrustedMemoryInput(ctx.messages ?? []);
  if (memoryTainted) ctx.control?.markMemoryTainted();
  return skipAutomaticMemory({ memoryTainted }, ctx.sessionId, source);
}
