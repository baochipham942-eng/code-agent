import { createHash } from 'node:crypto';

/**
 * 发给模型的工具表指纹。只覆盖有序的 name / description / inputSchema，
 * 对象键递归排序，这样同一份 schema 换键序不会被当成另一次断缓存。
 */
export interface CachePromptSample {
  prompt: string;
  modelId: string;
  toolsFingerprint?: string;
}

export interface CachePromptSampleHolder {
  current?: CachePromptSample;
  /** 最近一次真正发出的工具表指纹。conversationRuntime 整对象覆盖 current 时从这里抄回去。 */
  toolsFingerprint?: string;
}

interface FingerprintableTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const child = source[key];
      if (child === undefined) continue;
      sorted[key] = canonicalize(child);
    }
    return sorted;
  }
  return value;
}

export function fingerprintToolTable(tools: readonly FingerprintableTool[]): string {
  const payload = tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? null,
  }));
  return createHash('sha256').update(JSON.stringify(canonicalize(payload)), 'utf8').digest('hex');
}

/** 把发送时记下的工具表指纹并进本轮样本。没有指纹时不造一个空字段。 */
export function sampleWithToolsFingerprint(
  holder: CachePromptSampleHolder,
  sample: { prompt: string; modelId: string },
): CachePromptSample {
  const next: CachePromptSample = {
    prompt: sample.prompt,
    modelId: sample.modelId,
  };
  if (holder.toolsFingerprint) next.toolsFingerprint = holder.toolsFingerprint;
  return next;
}
