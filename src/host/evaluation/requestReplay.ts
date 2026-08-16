import { createHash } from 'crypto';
import type { Message } from '../../shared/contract';
import type { ModelMessage } from '../agent/loopTypes';
import { canonicalizeModelMessage } from '../agent/runtime/contextAssembly/requestManifestBuilder';
import { projectLedgerMessage } from '../agent/runtime/contextAssembly/ledgerMessageProjection';
import type { TraceEventDataMap } from '../agent/runtime/turnTrace';

export interface RequestReplayContentReaders {
  getSystemPrompt(hash: string): { content: string } | null;
  getContent(hash: string): string | null;
  getToolSchema(hash: string): string | null;
}

export interface ReconstructedRequest {
  messages: ModelMessage[];
  canonicalMessages: string[];
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  canonicalTools: string;
}

export class RequestNotReconstructableError extends Error {
  constructor(public readonly reasons: string[]) {
    super(`此轮不可重建：${reasons.join('；')}`);
    this.name = 'RequestNotReconstructableError';
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function requireHash(content: string | null, expectedHash: string, label: string, reasons: string[]): string | null {
  if (content == null) {
    reasons.push(`${label}缺少哈希 ${expectedHash}`);
    return null;
  }
  const actualHash = sha256(content);
  if (actualHash !== expectedHash) {
    reasons.push(`${label}哈希不符：期望 ${expectedHash}，实际 ${actualHash}`);
    return null;
  }
  return content;
}

function readContentRef(
  ref: Extract<TraceEventDataMap['request_manifest']['messageRefs'][number], { kind: 'content' }>,
  readers: RequestReplayContentReaders,
  label: string,
  reasons: string[],
): string | null {
  if (!ref.blocks) {
    return requireHash(readers.getContent(ref.contentHash), ref.contentHash, `${label} content_cache`, reasons);
  }

  const blocks: string[] = [];
  for (const [blockIndex, blockRef] of ref.blocks.entries()) {
    const blockLabel = `${label}.blocks[${blockIndex}] content_cache`;
    const block = requireHash(readers.getContent(blockRef.contentHash), blockRef.contentHash, blockLabel, reasons);
    if (block == null) continue;
    const bytes = Buffer.byteLength(block, 'utf-8');
    if (bytes !== blockRef.bytes) {
      reasons.push(`${blockLabel}字节数不符：期望 ${blockRef.bytes}，实际 ${bytes}`);
      continue;
    }
    blocks.push(block);
  }
  if (blocks.length !== ref.blocks.length) return null;
  return requireHash(blocks.join(''), ref.contentHash, `${label} block assembly`, reasons);
}

function parseModelMessage(canonical: string, label: string, reasons: string[]): ModelMessage | null {
  try {
    const parsed = JSON.parse(canonical) as ModelMessage;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.role !== 'string') {
      reasons.push(`${label}不是 ModelMessage`);
      return null;
    }
    if (canonicalizeModelMessage(parsed) !== canonical) {
      reasons.push(`${label}不是 canonical ModelMessage JSON`);
      return null;
    }
    return parsed;
  } catch (error) {
    reasons.push(`${label}无法解析：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Reconstructs the first assembled request recorded by request_manifest.
 * Compact/non-streaming/network retries can resend rewritten messages while
 * retaining the first manifest, so this contract intentionally excludes them.
 */
export function reconstructRequest(
  manifest: TraceEventDataMap['request_manifest'],
  ledgerMessages: readonly Message[],
  readers: RequestReplayContentReaders,
): ReconstructedRequest {
  if (manifest.degraded) {
    throw new RequestNotReconstructableError(['request_manifest degraded=true']);
  }

  const reasons: string[] = [];
  const ledgerById = new Map(ledgerMessages.map((message) => [message.id, message]));
  const ledgerOffsets = new Map<string, number>();
  const messages: ModelMessage[] = [];

  for (const [index, ref] of manifest.messageRefs.entries()) {
    const label = `messageRefs[${index}]`;
    if (ref.kind === 'ledger_message') {
      const ledgerMessage = ledgerById.get(ref.messageId);
      if (!ledgerMessage) {
        reasons.push(`${label}账本缺 messageId ${ref.messageId}`);
        continue;
      }
      const offset = ledgerOffsets.get(ref.messageId) ?? 0;
      const projected = projectLedgerMessage(ledgerMessage)[offset];
      if (!projected) {
        reasons.push(`${label}无法从账本消息 ${ref.messageId} 取得投影 #${offset}`);
        continue;
      }
      ledgerOffsets.set(ref.messageId, offset + 1);
      messages.push(projected);
      continue;
    }

    if (ref.kind === 'system_prompt') {
      const prompt = requireHash(
        readers.getSystemPrompt(ref.contentHash)?.content ?? null,
        ref.contentHash,
        `${label} system_prompt_cache`,
        reasons,
      );
      if (prompt != null) messages.push({ role: 'system', content: prompt });
      continue;
    }

    const canonical = readContentRef(ref, readers, label, reasons);
    if (canonical == null) continue;
    const parsed = parseModelMessage(canonical, label, reasons);
    if (parsed) messages.push(parsed);
  }

  const canonicalTools = requireHash(
    readers.getToolSchema(manifest.toolSchemaHash),
    manifest.toolSchemaHash,
    'tool_schema_cache',
    reasons,
  );
  let tools: ReconstructedRequest['tools'] = [];
  if (canonicalTools != null) {
    try {
      const parsed = JSON.parse(canonicalTools) as unknown;
      if (!Array.isArray(parsed)) reasons.push('tool_schema_cache 内容不是工具数组');
      else tools = parsed as ReconstructedRequest['tools'];
    } catch (error) {
      reasons.push(`tool_schema_cache 无法解析：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (reasons.length > 0 || canonicalTools == null) {
    throw new RequestNotReconstructableError(reasons);
  }
  return {
    messages,
    canonicalMessages: messages.map(canonicalizeModelMessage),
    tools,
    canonicalTools,
  };
}
