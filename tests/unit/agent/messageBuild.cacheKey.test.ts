// ============================================================================
// buildDynamicPromptCacheKey isolated test (E 风险闭环)
// ============================================================================
// Codex audit Round 1 E 风险:cache invalidation 测试不严谨 —— 同时改了
// SYSTEM.md + user query,cache miss 不能单独归因到 SYSTEM.md 变化。
// 这里固定 userQuery + ctx 其它字段,只改 system prompt 维度,verify cache key
// 真的变了。
// ============================================================================

import { describe, it, expect } from 'vitest';
import { buildDynamicPromptCacheKey } from '../../../src/host/agent/runtime/contextAssembly/messageBuild';
import type { ContextAssemblyCtx } from '../../../src/host/agent/runtime/contextAssembly';
import type { ProjectSystemPromptResult } from '../../../src/host/prompts/projectSystemPrompt';

function makeCtx(): ContextAssemblyCtx {
  // cacheKey 只读以下字段,其余字段不会被触达 —— 用 as unknown as 跳过完整接口
  return {
    runtime: {
      sessionId: 'session-fixed',
      agentId: 'agent-fixed',
      workingDirectory: '/tmp/work',
      isDefaultWorkingDirectory: false,
      isSimpleTaskMode: false,
      enableToolDeferredLoading: true,
      modelConfig: { model: 'kimi-k2.5' },
      messages: [
        { id: 'msg-last', role: 'user', content: 'fixed user query' },
      ],
      activeSkillInvocation: undefined,
      activeSkillContextBlock: undefined,
    },
  } as unknown as ContextAssemblyCtx;
}

const EMPTY_SYSTEM_PROMPT: ProjectSystemPromptResult = {
  custom: null,
  append: null,
  fullReplace: null,
  sources: { customPath: null, appendPath: null, fullReplacePath: null },
};

const FIXED_QUERY = 'fixed user query';

describe('buildDynamicPromptCacheKey — system prompt 维度独立失效', () => {
  it('其余字段全等 → cacheKey 一致(基线)', () => {
    const ctx1 = makeCtx();
    const ctx2 = makeCtx();
    const k1 = buildDynamicPromptCacheKey(ctx1, FIXED_QUERY, false, EMPTY_SYSTEM_PROMPT);
    const k2 = buildDynamicPromptCacheKey(ctx2, FIXED_QUERY, false, EMPTY_SYSTEM_PROMPT);
    expect(k1).toBe(k2);
  });

  it('只改 SYSTEM.md(custom)长度 → cacheKey 必须变', () => {
    const ctx = makeCtx();
    const shorter: ProjectSystemPromptResult = {
      custom: 'short',
      append: null,
      fullReplace: null,
      sources: {
        customPath: '/tmp/work/.code-agent/SYSTEM.md',
        appendPath: null,
        fullReplacePath: null,
      },
    };
    const longer: ProjectSystemPromptResult = {
      ...shorter,
      custom: 'a much longer system prompt body that should be detected',
    };
    const k1 = buildDynamicPromptCacheKey(ctx, FIXED_QUERY, false, shorter);
    const k2 = buildDynamicPromptCacheKey(ctx, FIXED_QUERY, false, longer);
    expect(k1).not.toBe(k2);
  });

  it('只改 FULL_SYSTEM.md(fullReplace)长度 → cacheKey 必须变', () => {
    const ctx = makeCtx();
    const shorter: ProjectSystemPromptResult = {
      custom: null,
      append: null,
      fullReplace: 'tiny',
      sources: {
        customPath: null,
        appendPath: null,
        fullReplacePath: '/tmp/work/.code-agent/FULL_SYSTEM.md',
      },
    };
    const longer: ProjectSystemPromptResult = {
      ...shorter,
      fullReplace: 'a fully expanded takeover prompt with much more body',
    };
    const k1 = buildDynamicPromptCacheKey(ctx, FIXED_QUERY, false, shorter);
    const k2 = buildDynamicPromptCacheKey(ctx, FIXED_QUERY, false, longer);
    expect(k1).not.toBe(k2);
  });

  it('只改 FULL_SYSTEM.md 路径(项目↔全局) → cacheKey 必须变', () => {
    const ctx = makeCtx();
    const sameLength = 'same body length but different source path';
    const fromProject: ProjectSystemPromptResult = {
      custom: null,
      append: null,
      fullReplace: sameLength,
      sources: {
        customPath: null,
        appendPath: null,
        fullReplacePath: '/tmp/work/.code-agent/FULL_SYSTEM.md',
      },
    };
    const fromGlobal: ProjectSystemPromptResult = {
      ...fromProject,
      sources: {
        ...fromProject.sources,
        fullReplacePath: '/home/me/.code-agent/FULL_SYSTEM.md',
      },
    };
    const k1 = buildDynamicPromptCacheKey(ctx, FIXED_QUERY, false, fromProject);
    const k2 = buildDynamicPromptCacheKey(ctx, FIXED_QUERY, false, fromGlobal);
    expect(k1).not.toBe(k2);
  });

  it('只改 APPEND_SYSTEM.md(append)长度 → cacheKey 必须变', () => {
    const ctx = makeCtx();
    const shorter: ProjectSystemPromptResult = {
      custom: null,
      append: 'a',
      fullReplace: null,
      sources: {
        customPath: null,
        appendPath: '/tmp/work/.code-agent/APPEND_SYSTEM.md',
        fullReplacePath: null,
      },
    };
    const longer: ProjectSystemPromptResult = {
      ...shorter,
      append: 'aa long body that should bust the cache when only this changes',
    };
    const k1 = buildDynamicPromptCacheKey(ctx, FIXED_QUERY, false, shorter);
    const k2 = buildDynamicPromptCacheKey(ctx, FIXED_QUERY, false, longer);
    expect(k1).not.toBe(k2);
  });

  it('userQuery 不变,system prompt 不变 → cacheKey 完全相同', () => {
    const ctx = makeCtx();
    const sp: ProjectSystemPromptResult = {
      custom: 'identical',
      append: 'identical',
      fullReplace: null,
      sources: {
        customPath: '/tmp/work/.code-agent/SYSTEM.md',
        appendPath: '/tmp/work/.code-agent/APPEND_SYSTEM.md',
        fullReplacePath: null,
      },
    };
    const k1 = buildDynamicPromptCacheKey(ctx, FIXED_QUERY, false, sp);
    const k2 = buildDynamicPromptCacheKey(ctx, FIXED_QUERY, false, sp);
    expect(k1).toBe(k2);
  });
});
