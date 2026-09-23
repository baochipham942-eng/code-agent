import type { ContextEventRecord } from '../../../context/contextEventLedger';
import type { RuntimeContext } from '../runtimeContext';
import type { ContextAssemblyCtx, ContextTranscriptEntry } from './shared';

export type RuntimeAssemblyCache = {
  lastAssembledSystemPrompt?: string;
  dynamicPrompt?: {
    key: string;
    createdAt: number;
    prompt: string;
    turnContext: string;
    tokens: number;
    /** GAP-023: prompt 构建时被预算丢弃的块（缓存命中时恢复，保持可见化一致） */
    droppedBlocks?: string[];
    promptLayers?: ContextEventRecord[];
  };
  compression?: {
    key: string;
    createdAt: number;
    apiView: ContextTranscriptEntry[];
    state: string;
  };
  imageBudgetNoticeKey?: string;
};

const runtimeAssemblyCaches = new WeakMap<object, RuntimeAssemblyCache>();

export function getRuntimeAssemblyCache(ctx: ContextAssemblyCtx): RuntimeAssemblyCache {
  let cache = runtimeAssemblyCaches.get(ctx.runtime as unknown as object);
  if (!cache) {
    cache = {};
    runtimeAssemblyCaches.set(ctx.runtime as unknown as object, cache);
  }
  return cache;
}

export function getCachedDynamicSystemPrompt(runtime: RuntimeContext): string | undefined {
  const cache = runtimeAssemblyCaches.get(runtime as unknown as object);
  return cache?.lastAssembledSystemPrompt;
}
