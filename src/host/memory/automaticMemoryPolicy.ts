import type { Message } from '../../shared/contract';
import type { RuntimeContext } from '../agent/runtime/runtimeContext';
import type { UntrustedContentPolicy } from '../protocol/tools';
import { canonicalToolName } from '../tools/toolNames';
import { getProtocolToolSchemas } from '../tools/protocolToolRegistration';
import { recordMemoryInjectionTrace } from './memoryInjectionTrace';

export function getUntrustedContentPolicy(toolName: string): UntrustedContentPolicy | undefined {
  const name = canonicalToolName(toolName);
  const schemas = getProtocolToolSchemas();
  // Prefix matching exists for dynamic aliases (mcp__server__tool under `mcp`).
  // A tool with its own registered schema that explicitly declares
  // readOnly: false is a write tool whose result is agent-/user-authored — it
  // never inherits a read parent's policy (mail -> mail_send: a 'block' hit on
  // a successful send would flip success=false and invite a resend). Tools
  // without such a schema (or with their own declaration) keep prefix matching.
  const ownSchema = schemas.find((schema) => canonicalToolName(schema.name) === name);
  if (ownSchema?.readOnly === false && ownSchema.readsUntrustedContent === undefined) return undefined;
  return schemas
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
