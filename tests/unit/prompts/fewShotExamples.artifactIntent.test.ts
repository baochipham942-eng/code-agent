// ============================================================================
// few-shot 选择器的产物意图失明（P0-2）
//
// 背景：系统已识别出「这是个 PPT 任务」（detectTaskFeatures.isPPTTask），却在选
// few-shot 前把它丢掉，只留「这是个规划任务」，再拿去匹配一个八条示例全是编程题的
// 语料库。于是「帮我做份营销方案 PPT」拿到的范本是「Phase 1 探索代码库…Phase 4
// 按计划逐步编码」。Neo 是产物为主轴的 cowork 产品，默认用户是非程序员协作者。
//
// 范围：本轮只放开 isPPTTask 一条产物路由。isExcelTask / isDocumentTask /
// isImageTask 靠裸英文词做子串匹配，与代码标识符碰撞（'document.getElementById'
// 会被判成写文档任务），接进来会把编程 prompt 从「无示例」变成「错示例」。
// 下方「裸英文词不得把编程任务带进产物示例」一组就是锁这条线的。
//
// 纪律：
// - 全部走真实链路 createReminderContext → selectReminders，喂真实用户句子，
//   断言真实选中结果。不在测试里重写一遍打分公式（抄的人不会发现被抄的那份是错的）。
// - 双向：修 cowork 不许把编程场景弄坏。
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  createReminderContext,
  selectReminders,
} from '../../../src/host/prompts/dynamicReminders';
import {
  FEW_SHOT_EXAMPLES,
  type FewShotExample,
} from '../../../src/host/prompts/fewShotExamples';
import { detectTaskFeatures } from '../../../src/host/prompts/systemReminders';

/** 走生产同款链路：真实句子 → 特征检测 → 描述串 → 示例选择 */
function selectedExamplesFor(prompt: string): FewShotExample[] {
  // tokenBudget 用生产实传值（conversationRuntime 传 maxReminderTokens: 1200，
  // few-shot 门槛是 tokenBudget > 400）
  const context = createReminderContext(prompt, { tokenBudget: 4000 });
  return selectReminders(context, { maxTokens: 1200 }).examples;
}

const titlesOf = (examples: FewShotExample[]) => examples.map((e) => e.title);

describe('few-shot 选择：PPT 任务拿产物示例，不拿编程示例', () => {
  it.each([
    '帮我做一份 Q3 营销方案的 PPT',
    '做个产品介绍的演示文稿',
    '做个 10 页的幻灯片',
    '帮我做一份介绍我们代码库的 PPT', // 内容关于代码，但交付物仍是 PPT
  ])('%s → 只拿产物示例', (prompt) => {
    const examples = selectedExamplesFor(prompt);

    // 必须真的选到东西——空数组等于静默关掉 few-shot，那是另一种坏
    expect(examples.length).toBeGreaterThan(0);
    expect(examples.every((e) => e.domain === 'artifact')).toBe(true);
    expect(examples.map((e) => e.type)).toContain('ppt_creation');
  });

  it('「做 PPT」不再被喂「分五个 Phase 编码」的范本', () => {
    const examples = selectedExamplesFor('帮我做一份 Q3 营销方案的 PPT');

    expect(titlesOf(examples)).not.toContain('Plan Mode 执行流程');
    // 断言不到具体标题就没意义了——先确认那条编程示例真的还在语料库里
    expect(FEW_SHOT_EXAMPLES.some((e) => e.title === 'Plan Mode 执行流程')).toBe(true);
  });
});

describe('反回归：编程场景行为不变', () => {
  it('「帮我实现一个用户管理功能」仍选中 plan_mode', () => {
    const examples = selectedExamplesFor('帮我实现一个用户管理功能');

    expect(examples.map((e) => e.type)).toContain('plan_mode');
    expect(examples.every((e) => e.domain === 'code')).toBe(true);
  });

  it.each([
    '对项目进行全面的安全审计',
    '分析这个模块的代码质量',
    '帮我找到所有处理用户认证的代码',
    '分析这个项目的整体架构',
  ])('%s → 不被产物示例污染', (prompt) => {
    const examples = selectedExamplesFor(prompt);

    expect(examples.length).toBeGreaterThan(0);
    expect(examples.every((e) => e.domain === 'code')).toBe(true);
  });
});

describe('裸英文词不得把编程任务带进产物示例', () => {
  // 这些句子里 image / document / excel / slide / presentation 都是代码标识符或
  // 技术术语，不是产物诉求。检测层是子串匹配，全部会误命中对应的 isXxxTask——
  // 所以产物路由只放开 isPPTTask，且 pptKeywords 已剔掉裸词。
  it.each([
    '帮我修一下 document.getElementById 的报错',
    '这个 image 加载失败了',
    '重构 excel 导出那段代码',
    '改一下 slider 组件的样式',
    'presentation 层的接口改一下',
    '演示一下这个 API 怎么调用',
    '给 video 标签加个 poster 属性',
    'stylesheet 里的样式没生效',
  ])('%s → 不得拿到产物示例', (prompt) => {
    const examples = selectedExamplesFor(prompt);

    expect(examples.every((e) => e.domain === 'code')).toBe(true);
  });
});

describe('isPPTTask 检测：产物路由的唯一入口，必须干净', () => {
  // 它既决定 few-shot 产物示例，也决定 250 token 的 PPT_FORMAT_SELECTION 提醒。
  // 收窄前实测 6/11 误判（裸词 演示/slide/slides/presentation 咬到代码语境）。
  it.each([
    '帮我做一份 Q3 营销方案的 PPT',
    '做个产品介绍的演示文稿',
    '做个 10 页的幻灯片',
    '用 slidev 做个分享',
    'make some slides for the demo',
    'make a presentation about AI',
  ])('真产物诉求仍命中: %s', (prompt) => {
    expect(detectTaskFeatures(prompt).isPPTTask).toBe(true);
  });

  it.each([
    '演示一下这个 API 怎么调用',
    '给我演示下怎么用这个函数',
    '改一下 slider 组件的样式',
    'presentation 层的接口改一下',
    '修一下 carousel slides 的 bug',
    'slide 动画卡顿',
  ])('代码语境不得误命中: %s', (prompt) => {
    expect(detectTaskFeatures(prompt).isPPTTask).toBe(false);
  });
});

describe('token 预算', () => {
  it('产物示例不撑爆 few-shot 预算（默认 400）', () => {
    const prompts = [
      '帮我做一份 Q3 营销方案的 PPT',
      '帮我实现一个用户管理功能',
      '对项目进行全面的安全审计',
    ];

    for (const prompt of prompts) {
      const examples = selectedExamplesFor(prompt);
      const total = examples.reduce((sum, e) => sum + e.tokens, 0);
      expect(total).toBeLessThanOrEqual(400);
      expect(examples.length).toBeLessThanOrEqual(2);
    }
  });
});
