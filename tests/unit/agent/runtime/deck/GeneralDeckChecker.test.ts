// ============================================================================
// GeneralDeckChecker integration — Phase 4 PR-3 step 2.
//
// 验证 schema + narrative 两组 probe 并存时的行为：
//   - schema 与 narrative 用各自的 vacuous-pass 短路
//   - 两组同时 fail 时 failures 聚合
//   - probe 顺序保持 [SCHEMA_PROBE, ...NARRATIVE_PROBES]
// ============================================================================

import { describe, it, expect } from 'vitest';

import type { SlideData } from '../../../../../src/host/tools/media/ppt/types';
import type { StructuredSlide } from '../../../../../src/host/tools/media/ppt/slideSchemas';
import { GeneralDeckChecker } from '../../../../../src/host/agent/runtime/deck/general/GeneralDeckChecker';

const checker = new GeneralDeckChecker();

describe('GeneralDeckChecker probe set', () => {
  it('exposes schema probe followed by 4 narrative probes (order preserved)', () => {
    const ids = checker.probes.map((p) => p.id);
    expect(ids).toEqual([
      'schema_invalid',
      'missing_intro',
      'consecutive_data',
      'no_evidence',
      'missing_summary',
    ]);
  });
});

describe('GeneralDeckChecker validate — schema only', () => {
  it('passes when both structured and legacy are empty', () => {
    const r = checker.validate({ structured: [], legacy: [] });
    expect(r.passed).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.probes.every((p) => p.passed)).toBe(true);
  });

  it('reports schema failure when structured invalid + legacy empty', () => {
    const slides: StructuredSlide[] = [
      { layout: 'stats', title: '坏', content: {} as never },
    ];
    const r = checker.validate({ structured: slides, legacy: [] });
    expect(r.passed).toBe(false);
    const schemaProbe = r.probes.find((p) => p.probe === 'schema_invalid');
    expect(schemaProbe?.passed).toBe(false);
    expect(schemaProbe?.failure).toMatch(/schema:/);
    // narrative 因为 legacy 空，全部 vacuous pass
    expect(r.probes.filter((p) => p.probe !== 'schema_invalid').every((p) => p.passed)).toBe(true);
  });
});

describe('GeneralDeckChecker validate — both schema + narrative fail', () => {
  it('aggregates failures from both groups', () => {
    const structuredBad: StructuredSlide[] = [
      // 缺 stats 数组
      { layout: 'stats', title: '坏数据', content: {} as never },
    ];
    const legacyBad: SlideData[] = [
      { title: '标题', points: [], isTitle: true, isEnd: false },
      // 首页内容页非 intro 关键词 → missing_intro
      { title: '产品功能', points: ['功能A'], isTitle: false, isEnd: false },
      // 末尾非 isEnd 的 last-content 也不是 summary 关键词 → missing_summary
      { title: '谢谢', points: [], isTitle: false, isEnd: true },
    ];
    const r = checker.validate({ structured: structuredBad, legacy: legacyBad });
    expect(r.passed).toBe(false);

    const failedIds = new Set(r.probes.filter((p) => !p.passed).map((p) => p.probe));
    expect(failedIds.has('schema_invalid')).toBe(true);
    expect(failedIds.has('missing_intro')).toBe(true);
    // no_evidence 与 missing_summary 也应当 fail（无 evidence 关键词、末页非 summary）
    expect(failedIds.has('no_evidence')).toBe(true);
    expect(failedIds.has('missing_summary')).toBe(true);

    // failures 聚合至少含 schema + 3 个 narrative
    expect(r.failures.length).toBeGreaterThanOrEqual(4);
    expect(r.failures.some((m) => m.startsWith('schema:'))).toBe(true);
  });
});

describe('GeneralDeckChecker validate — fixture parity (PR-1 baseline)', () => {
  // PR-1 baseline.json 的 fixture 应当全 pass：schema 6/6 valid, narrative 0 issues。
  // 这是 PR-3 接进 pptGenerate 之前的硬约束。
  it('passes on PR-1 sample-slides.json shape (smoke)', () => {
    const structured: StructuredSlide[] = [
      { layout: 'list', title: 'AI Coding 工具 2026 简报', subtitle: '市场格局与团队选型建议', isTitle: true,
        content: { points: ['面向资深产品经理 / 工程负责人', '覆盖 Claude Code / Cursor / Replit / v0 / Bolt'] } },
      { layout: 'list', title: '背景概述',
        content: { points: ['AI Coding 工具从代码补全演进到端到端 Agent', '评测体系尚未收敛', '本简报锚定 2026 年 4 月主流工具'] } },
      { layout: 'stats', title: '数据分析报告',
        content: { stats: [
          { label: 'Claude Code 周活', value: '230 万', description: '环比增长 18%' },
          { label: 'Cursor 用户', value: '85 万', description: '环比增长 12%' },
          { label: 'Replit Agent 跑通率', value: '62%', description: '对照基线 41%' },
        ] } },
      { layout: 'timeline', title: '团队接入路径',
        content: { steps: [
          { title: '评估', description: '锚定团队语料、评测集与红线' },
          { title: '试点', description: '选 1 条业务线跑 4 周 A/B' },
          { title: '推广', description: '把 winning 工具沉淀到 onboarding' },
        ] } },
      { layout: 'list', title: '总结回顾',
        content: { points: ['选型不是选最强', 'BoN 与 self-repair 上限是工具基础能力', '下一阶段重点是把多 Agent 协作流程标准化'] } },
      { layout: 'list', title: '致谢', isEnd: true,
        content: { points: ['Q&A', '联系方式：lin@porsche.cn'] } },
    ];
    const legacy: SlideData[] = [
      { title: 'AI Coding 工具 2026 简报', subtitle: '市场格局与团队选型建议', points: [], isTitle: true, isEnd: false },
      { title: '背景概述', points: ['AI Coding 工具从代码补全演进到端到端 Agent', '评测体系尚未收敛', '本简报锚定 2026 年 4 月主流工具'], isTitle: false, isEnd: false },
      { title: '数据分析报告', points: ['Claude Code 周活 230 万', 'Cursor 用户 85 万', 'Replit Agent 跑通率 62%'], isTitle: false, isEnd: false },
      { title: '团队接入路径', points: ['评估：锚定团队语料', '试点：选一条业务线', '推广：把 winning 工具沉淀'], isTitle: false, isEnd: false },
      { title: '总结回顾', points: ['选型不是选最强', 'BoN 与 self-repair 上限是工具基础能力', '下一阶段重点是把多 Agent 协作流程标准化'], isTitle: false, isEnd: false },
      { title: '致谢', points: [], isTitle: false, isEnd: true },
    ];
    const r = checker.validate({ structured, legacy });
    expect(r.passed).toBe(true);
    expect(r.failures).toEqual([]);
  });
});
