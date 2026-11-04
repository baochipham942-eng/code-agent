import { beforeEach, describe, expect, it, vi } from 'vitest';

const REAL_GLM_OUTLINE = `# AI 编程助手：从代码补全到智能开发的范式转移

## 背景：AI 编程助手进入爆发期
- 市场规模：GitHub Copilot 用户超 150 万，付费转化率持续提升；Cursor、Windsurf 等新锐估值快速攀升
- 技术驱动：大模型代码能力跃升（GPT-4o、Claude 3.5、DeepSeek-Coder），代码生成准确率从 50% 提升至 80%+
- 采用率数据：Stack Overflow 调研显示 76% 开发者正在使用或计划使用 AI 编程工具
- 竞争格局：微软、Google、Amazon 大厂入局，与创业公司形成三层竞争生态

## 问题：传统开发模式的效率瓶颈
- 重复劳动占比高：样板代码、单元测试、文档编写消耗开发者 40% 以上时间
- 上下文切换成本：查阅文档、搜索 Stack Overflow 打断心流，日均损耗 1-2 小时
- 人才供需矛盾：全球软件开发需求增速远超工程师供给，企业交付压力持续加大
- 遗留系统维护难：老代码理解成本高，新人上手周期长达 3-6 个月

## 方案：AI 编程助手的能力演进路径
- 第一阶段：单点补全（2021-2023），以 Copilot 为代表，行级/函数级代码补全
- 第二阶段：对话式开发（2023-2024），Chat 模式支持代码解释、重构、Debug
- 第三阶段：Agent 自主执行（2024 至今），Cursor Agent、Devin 可自主完成多文件修改、运行测试、提交 PR
- 关键技术趋势：仓库级上下文理解、RAG 检索私有代码库、工具调用（MCP 协议）生态

## 价值：效率与质量的双重提升
- 效率数据：Google 内部统计 AI 助手减少 6% 代码迭代时间；多家企业报告重复性任务效率提升 30-50%
- 质量改善：自动生成单测提升覆盖率，AI 辅助 Code Review 减少低级缺陷
- 门槛降低：初级开发者生产力接近中级水平，非程序员（产品、运营）可实现原型开发
- 成本重构：企业研发人力成本结构变化，AI 工具投入产出比普遍超过 3:1

## 落地：企业级应用的最佳实践
- 选型策略：按场景分层——补全用 Copilot/Codeium，复杂任务用 Cursor/Claude Code，私有化部署选 Continue/开源方案
- 代码资产安全：私有代码不上传、本地推理方案、审计日志合规（SOC2、数据驻留）
- 推广路径：试点团队 → 度量基线（DORA 指标）→ 全员推广，配套 Prompt 与 Agent 使用培训
- 度量体系：接受率、PR 周期、缺陷密度三指标追踪 ROI，避免“为用而用”

## 总结：趋势判断与行动建议
- 短期（1 年）：Agent 化加速，多文件自主编辑成为标配，MCP 工具生态走向标准化
- 中期（2-3 年）：AI 原生开发环境兴起，开发者角色向“需求定义 + 审查决策”迁移
- 风险提示：代码版权争议、幻觉代码安全漏洞、过度依赖导致技能退化
- 行动建议：个人尽早建立 AI 协作工作流；企业立即启动试点，抢占效率红利窗口期`;

const h = vi.hoisted(() => ({
  inference: vi.fn(async (_messages: unknown, _tools: unknown, _config: unknown) => ({ content: REAL_GLM_OUTLINE })),
}));

vi.mock('../../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getSettings: () => ({ models: { default: '', providers: {} } }),
    getApiKey: () => 'test-key',
  }),
}));

vi.mock('../../../../../src/host/model/modelRouter', () => ({
  ModelRouter: class {
    inference(messages: unknown, tools: unknown, config: unknown) {
      return h.inference(messages, tools, config);
    }
  },
}));

import { buildAiOutline } from '../../../../../src/host/services/design/slidesAiOutline';
import { parseContentToSlides } from '../../../../../src/host/tools/media/ppt/parser';

function expectedSections() {
  return REAL_GLM_OUTLINE.split(/^## /m).slice(1).map(section => {
    const [title, ...lines] = section.split('\n');
    return {
      title,
      points: lines.filter(line => line.startsWith('- ')).map(line => line.slice(2)),
    };
  });
}

describe('parseContentToSlides h2AsPages', () => {
  it('puts each real GLM section and its bullets on a separate slide', () => {
    const slides = parseContentToSlides(REAL_GLM_OUTLINE, 10, { h2AsPages: true });

    expect(slides).toHaveLength(expectedSections().length + 1);
    expect(slides[0]).toMatchObject({
      title: 'AI 编程助手：从代码补全到智能开发的范式转移',
      points: [],
      isTitle: true,
    });
    expect(slides.slice(1).map(slide => ({ title: slide.title, points: slide.points }))).toEqual(expectedSections());
  });

  it('keeps cover bullets and marks an ending h2 page', () => {
    const slides = parseContentToSlides(
      '# 封面\n- 封面要点\n## 背景\n- 背景要点\n## 问题\n* 问题要点\n## 方案\n1. 方案要点\n## 价值\n普通文本\n## 总结\n- 总结要点',
      6,
      { h2AsPages: true },
    );

    expect(slides).toHaveLength(6);
    expect(slides[0].points).toEqual(['封面要点']);
    expect(slides[1].points).toEqual(['背景要点']);
    expect(slides[2].points).toEqual(['问题要点']);
    expect(slides[3].points).toEqual(['方案要点']);
    expect(slides[4].points).toEqual(['普通文本']);
    expect(slides[5]).toMatchObject({ title: '总结', isTitle: false, isEnd: true });
  });

  it('preserves the legacy one-slide result without options', () => {
    const slides = parseContentToSlides(REAL_GLM_OUTLINE, 10);

    expect(slides).toHaveLength(1);
    expect(slides[0]).toMatchObject({
      title: 'AI 编程助手：从代码补全到智能开发的范式转移',
      subtitle: '背景：AI 编程助手进入爆发期',
      isTitle: true,
    });
    expect(slides[0].points).toHaveLength(24);
  });
});

describe('buildAiOutline h2AsPages', () => {
  beforeEach(() => {
    h.inference.mockClear();
  });

  it('returns the real GLM outline as independently owned pages', async () => {
    const result = await buildAiOutline('AI 编程助手的行业趋势', 10);

    expect(result.ai).toBe(true);
    expect(result.slides.length).toBeGreaterThan(1);
    expect(result.slides).toHaveLength(expectedSections().length + 1);
    expect(result.slides[0]).toMatchObject({ points: [], isTitle: true });
    expect(result.slides.slice(1).map(slide => ({ title: slide.title, points: slide.points }))).toEqual(
      expectedSections(),
    );
  });

  it('keeps the last section when the model follows the prompt literally (cover + count sections)', async () => {
    h.inference.mockResolvedValueOnce({
      content: '# 封面标题\n\n## 背景\n- 背景要点\n\n## 问题\n- 问题要点\n\n## 方案\n- 方案要点\n\n## 总结\n- 总结要点',
    });

    const result = await buildAiOutline('主题', 4);

    expect(result.ai).toBe(true);
    expect(result.slides.map(slide => slide.title)).toEqual(['封面标题', '背景', '问题', '方案', '总结']);
    expect(result.slides[4].points).toEqual(['总结要点']);
    expect(result.slides[4].isEnd).toBe(true);
  });
});
