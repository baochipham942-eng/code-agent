// ============================================================================
// pptGenerate × DeckVerifier integration smoke — Phase 4 PR-3 step 3.
//
// 验证 wire-up：
// - preview=true 路径下 wire-up 跑通不崩
// - logger.warn 收到的 "Deck verifier" 前缀消息（如有）格式正确
// - DeckVerifier 抛错也不会让 ppt_generate 失败（fallback path 有 try/catch）
//
// 不验证 PPT 实际生成质量 — 那是 visualReview / 端到端测试的事。
// 不跑真实 LLM — preview 路径不需要 modelCallback。
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/host/protocol/tools';
import {
  pptGenerateModule,
} from '../../../../../src/host/tools/modules/network/pptGenerate';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: '/tmp/work',
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

const ENV_FLAG = 'ENABLE_LEGACY_PPT_GENERATE';
const originalEnvFlag = process.env[ENV_FLAG];

beforeEach(() => {
  process.env[ENV_FLAG] = '1';
});

afterEach(() => {
  if (originalEnvFlag === undefined) {
    delete process.env[ENV_FLAG];
  } else {
    process.env[ENV_FLAG] = originalEnvFlag;
  }
});

async function runPreview(content: string, ctx: ToolContext = makeCtx()) {
  const handler = await pptGenerateModule.createHandler();
  return handler.execute(
    {
      topic: 'Wire-up smoke',
      content,
      preview: true,
      research: false,
      review: false,
    },
    ctx,
    allowAll,
    () => void 0,
  );
}

describe('pptGenerate × DeckVerifier (PR-3 wire-up)', () => {
  it('preview path executes wire-up without throwing on a clean deck', async () => {
    const ctx = makeCtx();
    // 设计成 narrative 全 pass：含 intro / evidence / summary 关键词
    const cleanContent = `# Wire-up smoke
## subtitle

# 背景概述
- 第一点
- 第二点

# 数据分析
- 指标 A 100
- 指标 B 200

# 总结回顾
- 收尾

# 谢谢观看`;

    const result = await runPreview(cleanContent, ctx);
    expect(result.ok).toBe(true);
    // 干净 deck 不应当触发任何 "Deck verifier" warn
    const warnCalls = (ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const verifierWarns = warnCalls.filter((args) =>
      typeof args[0] === 'string' && args[0].startsWith('Deck verifier'),
    );
    expect(verifierWarns).toEqual([]);
  });

  it('logger.warn formatted with "Deck verifier (subtype): ..." when narrative fails', async () => {
    const ctx = makeCtx();
    // 故意触发 missing_intro + missing_summary + no_evidence
    const failingContent = `# Wire-up smoke
## subtitle

# 产品功能
- 功能A
- 功能B

# 谢谢观看`;

    await runPreview(failingContent, ctx);
    const warnCalls = (ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const verifierWarns = warnCalls.filter((args) =>
      typeof args[0] === 'string' && args[0].startsWith('Deck verifier'),
    );
    expect(verifierWarns.length).toBeGreaterThan(0);
    for (const call of verifierWarns) {
      expect(call[0]).toMatch(/^Deck verifier \(general\): /);
    }
  });

  it('preview ok=true regardless of verifier verdict (non-blocking)', async () => {
    const ctx = makeCtx();
    const failingContent = `# Wire-up smoke
## subtitle

# 产品功能
- 功能A

# 谢谢观看`;
    const result = await runPreview(failingContent, ctx);
    expect(result.ok).toBe(true);
  });
});
