// ============================================================================
// AutoContextCompressor 特征测试（characterization tests）
// ----------------------------------------------------------------------------
// autoCompressor.ts（921 行）此前 0 单测，却是上下文压缩核心——51 次工具调用
// 死循环那类 bug 的发源地。本测试钉住同步决策逻辑的当前行为（策略选择阈值、
// 绝对 token 触发、激进截断的配对保留、收尾预算判定），让后续改动有回归保护。
// 不触达 LLM/外部 service 的方法，纯逻辑可独立实例化测试。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { AutoContextCompressor } from '../../../src/main/context/autoCompressor';
import type { CompressedMessage } from '../../../src/main/context/tokenOptimizer';

type CompressionStrategy = 'truncate' | 'code_extract' | 'ai_summary';

// selectStrategy / extractCodeBlocks 是 private，特征测试经类型逃逸访问（测试专用）
interface CompressorInternals {
  selectStrategy(usageRatio: number): CompressionStrategy;
  extractCodeBlocks(content: string): string;
}
function internals(c: AutoContextCompressor): CompressorInternals {
  return c as unknown as CompressorInternals;
}

function msg(role: string, content: string): CompressedMessage {
  return { role, content };
}

describe('AutoContextCompressor.selectStrategy', () => {
  it('默认配置下 usageRatio≥0.8 走 ai_summary（aiSummaryThreshold=0.8）', () => {
    const c = new AutoContextCompressor();
    expect(internals(c).selectStrategy(0.8)).toBe('ai_summary');
    expect(internals(c).selectStrategy(0.95)).toBe('ai_summary');
  });

  it('低使用率走 truncate', () => {
    const c = new AutoContextCompressor();
    expect(internals(c).selectStrategy(0)).toBe('truncate');
    expect(internals(c).selectStrategy(0.79)).toBe('truncate');
  });

  it('关键设计边界：useAISummary=true 时 code_extract 不可达（aiSummaryThreshold 0.8 < criticalThreshold 0.85，0.8 先命中）', () => {
    const c = new AutoContextCompressor();
    // 即使 usageRatio 落在 criticalThreshold(0.85) 之上，也先被 0.8 的 ai_summary 拦截
    expect(internals(c).selectStrategy(0.85)).toBe('ai_summary');
    expect(internals(c).selectStrategy(0.9)).toBe('ai_summary');
  });

  it('仅当 useAISummary=false 且 usageRatio≥criticalThreshold 才走 code_extract', () => {
    const c = new AutoContextCompressor({ useAISummary: false });
    expect(internals(c).selectStrategy(0.85)).toBe('code_extract');
    expect(internals(c).selectStrategy(0.99)).toBe('code_extract');
    // 低于 critical 仍是 truncate
    expect(internals(c).selectStrategy(0.84)).toBe('truncate');
  });
});

describe('AutoContextCompressor.shouldTriggerByTokens', () => {
  it('达到或超过 triggerTokens 触发', () => {
    const c = new AutoContextCompressor({ triggerTokens: 100000 });
    expect(c.shouldTriggerByTokens(100000)).toBe(true);
    expect(c.shouldTriggerByTokens(150000)).toBe(true);
    expect(c.shouldTriggerByTokens(99999)).toBe(false);
  });

  it('triggerTokens 未配置时永不触发', () => {
    const c = new AutoContextCompressor({ triggerTokens: undefined });
    expect(c.shouldTriggerByTokens(10_000_000)).toBe(false);
  });
});

describe('AutoContextCompressor.aggressiveTruncate', () => {
  it('消息数 ≤20 原样返回（不压缩）', () => {
    const c = new AutoContextCompressor();
    const messages = Array.from({ length: 20 }, (_, i) => msg('user', `m${i}`.repeat(100)));
    expect(c.aggressiveTruncate(messages)).toBe(messages);
  });

  it('末尾 20 条完整保留，未被截断', () => {
    const c = new AutoContextCompressor();
    const long = 'x'.repeat(500);
    const messages = Array.from({ length: 60 }, () => msg('user', long));
    const out = c.aggressiveTruncate(messages);
    // 末 20 条（index 40-59）应保持原内容
    for (let i = 40; i < 60; i++) {
      expect(out[i].content).toBe(long);
      expect(out[i].compressed).toBeUndefined();
    }
  });

  it('距末 20-50 条截断到 200 字符并标记 compressed', () => {
    const c = new AutoContextCompressor();
    const long = 'x'.repeat(500);
    const messages = Array.from({ length: 60 }, () => msg('user', long));
    const out = c.aggressiveTruncate(messages);
    // index 10..39 距末 20-49，应被截断
    expect(out[20].content).toBe('x'.repeat(200) + '...[truncated]');
    expect(out[20].compressed).toBe(true);
  });

  it('距末 >50 的 tool 消息内容清为 [cleared]，保留配对结构', () => {
    const c = new AutoContextCompressor();
    const messages: CompressedMessage[] = Array.from({ length: 60 }, (_, i) =>
      i === 0
        ? { role: 'tool', content: 'big tool result', toolCallId: 'tc-1' }
        : msg('user', 'x'.repeat(500))
    );
    const out = c.aggressiveTruncate(messages);
    // index 0 距末 59 > 50，且是 tool
    expect(out[0].content).toBe('[cleared]');
    expect(out[0].compressed).toBe(true);
    expect(out[0].toolCallId).toBe('tc-1'); // 配对关系保留
  });
});

describe('AutoContextCompressor compaction 计数与收尾预算', () => {
  it('recordCompaction 累加 getCompactionCount', () => {
    const c = new AutoContextCompressor();
    expect(c.getCompactionCount()).toBe(0);
    c.recordCompaction(1000);
    c.recordCompaction(2000, 'truncate');
    expect(c.getCompactionCount()).toBe(2);
  });

  it('shouldWrapUp：缺 totalTokenBudget 或 triggerTokens 时恒 false', () => {
    const noBudget = new AutoContextCompressor({ triggerTokens: 100000 });
    expect(noBudget.shouldWrapUp()).toBe(false);
    const noTrigger = new AutoContextCompressor({ totalTokenBudget: 300000, triggerTokens: undefined });
    expect(noTrigger.shouldWrapUp()).toBe(false);
  });

  it('shouldWrapUp：累计 compaction × triggerTokens 达到预算时触发', () => {
    const c = new AutoContextCompressor({ triggerTokens: 100000, totalTokenBudget: 300000 });
    c.recordCompaction(1);
    c.recordCompaction(1);
    expect(c.shouldWrapUp()).toBe(false); // 2×100k=200k < 300k
    c.recordCompaction(1);
    expect(c.shouldWrapUp()).toBe(true); // 3×100k=300k ≥ 300k
  });

  it('getStats.recentStrategies 仅取最近 5 条', () => {
    const c = new AutoContextCompressor();
    for (let i = 0; i < 7; i++) c.recordCompaction(1, i % 2 === 0 ? 'truncate' : 'ai_summary');
    expect(c.getStats().recentStrategies).toHaveLength(5);
  });

  it('reset 清空 compaction 历史', () => {
    const c = new AutoContextCompressor();
    c.recordCompaction(1);
    c.reset();
    expect(c.getCompactionCount()).toBe(0);
  });
});

describe('AutoContextCompressor 配置管理', () => {
  it('updateConfig 浅合并并保留未覆盖项', () => {
    const c = new AutoContextCompressor({ preserveRecentCount: 10 });
    c.updateConfig({ targetUsage: 0.3 });
    expect(c.getConfig().targetUsage).toBe(0.3);
    expect(c.getConfig().preserveRecentCount).toBe(10); // 未覆盖项保留
  });
});

describe('AutoContextCompressor.extractCodeBlocks', () => {
  it('保留 fenced 代码块，前置内容压成简短摘要', () => {
    const content = 'intro line\n```ts\nconst x = 1;\n```\ntrailer';
    const out = internals(new AutoContextCompressor()).extractCodeBlocks(content);
    expect(out).toContain('```ts\nconst x = 1;\n```');
    expect(out).toContain('[Code preserved]');
  });

  it('无代码块且行数 >10 时首 5 行 + 尾 3 行截断', () => {
    const content = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
    const out = internals(new AutoContextCompressor()).extractCodeBlocks(content);
    expect(out).toContain('line0');
    expect(out).toContain('...[truncated]...');
    expect(out).toContain('line19');
    expect(out).not.toContain('line10'); // 中间行被截掉
  });

  it('无代码块且行数 ≤10 原样返回', () => {
    const content = 'a\nb\nc';
    const out = internals(new AutoContextCompressor()).extractCodeBlocks(content);
    expect(out).toBe(content);
  });
});
