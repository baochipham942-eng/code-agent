// ============================================================================
// 产物意图：检测（强/弱信号）+ few-shot 选择
//
// 背景：系统已识别出「这是个 PPT 任务」（detectTaskFeatures.isPPTTask），却在选
// few-shot 前把它丢掉，只留「这是个规划任务」，再拿去匹配一个八条示例全是编程题的
// 语料库。于是「帮我做份营销方案 PPT」拿到的范本是「Phase 1 探索代码库…Phase 4
// 按计划逐步编码」。Neo 是产物为主轴的 cowork 产品，默认用户是非程序员协作者。
//
// 检测层是这条路由的可信前提：产物关键词表原本大量用裸英文词做子串匹配，与代码标识符
// 全面碰撞（`document.getElementById` → isDocumentTask、`重构 excel 导出那段代码`
// → isExcelTask、`stylesheet` → isExcelTask）。接上去会把一整类编程 prompt 从
// 「无示例」变成「错示例」——错示例是模型的行为范本，比没示例更有害。
// 现在靠强/弱信号分级 + ASCII 词边界挡住，下面两组分别锁两层。
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

const ARTIFACT_FEATURES = [
  'isPPTTask',
  'isExcelTask',
  'isDocumentTask',
  'isImageTask',
  'isVideoTask',
] as const;

const artifactFeaturesOf = (prompt: string): string[] => {
  const f = detectTaskFeatures(prompt) as unknown as Record<string, boolean>;
  return ARTIFACT_FEATURES.filter((k) => f[k]);
};

// ---------------------------------------------------------------------------
// 第一层：检测
// ---------------------------------------------------------------------------

describe('detectTaskFeatures：真产物诉求要命中', () => {
  it.each([
    ['帮我做一份 Q3 营销方案的 PPT', 'isPPTTask'],
    ['做个产品介绍的演示文稿', 'isPPTTask'],
    ['做个 10 页的幻灯片', 'isPPTTask'],
    ['make a presentation about AI', 'isPPTTask'],
    // 内容关于代码，但交付物仍是 PPT——强信号不该被代码语境否决
    ['帮我做一份介绍我们代码库的 PPT', 'isPPTTask'],
    ['帮我把这些销售数据做成 Excel 表，按区域汇总', 'isExcelTask'],
    ['帮我处理这个 excel', 'isExcelTask'],
    ['做个透视表看下各区域占比', 'isExcelTask'],
    // 「函数」同时是代码词，但 Excel 也有函数——不该被它否决
    ['excel 里这个函数怎么写', 'isExcelTask'],
    ['帮我写一份 Q3 营销季度报告', 'isDocumentTask'],
    ['帮我撰写一篇产品介绍文章', 'isDocumentTask'],
    ['帮我设计一张海报', 'isImageTask'],
    ['帮我画一张插图', 'isImageTask'],
    ['generate an image of a cat', 'isImageTask'],
    // 强信号（架构图/流程图）压过代码语境（模块/函数）
    ['帮我把模块依赖画成架构图', 'isImageTask'],
    ['给这个函数的逻辑做张流程图', 'isImageTask'],
    ['帮我做个短视频', 'isVideoTask'],
    ['帮我做个动画', 'isVideoTask'],
  ])('%s → %s', (prompt, expected) => {
    expect(artifactFeaturesOf(prompt)).toContain(expected);
  });
});

describe('T11：英文 pptx 拼写命中 PPT 产物意图', () => {
  it('Create a pptx about our product roadmap → PPT 检测与产物示例', () => {
    const prompt = 'Create a pptx about our product roadmap';
    const examples = selectedExamplesFor(prompt);

    expect.soft(detectTaskFeatures(prompt).isPPTTask).toBe(true);
    expect.soft(examples.map((e) => e.type)).toContain('ppt_creation');
    expect.soft(examples.every((e) => e.domain === 'artifact')).toBe(true);
    expect.soft(titlesOf(examples)).not.toContain('Plan Mode 执行流程');
  });

  it.each([
    ['Create a ppt about our product roadmap', true],
    ['生成pptx', true],
    ['Open roadmap.pptx', true],
    ['fix the carousel slides bug', false],
  ])('%s → isPPTTask=%s', (prompt, expected) => {
    expect(detectTaskFeatures(prompt).isPPTTask).toBe(expected);
  });
});

describe('detectTaskFeatures：代码语境不得误命中任何产物特征', () => {
  // 这些句子里 image/document/excel/slide/presentation/report/draw/video 都是代码
  // 标识符或技术术语，不是产物诉求。
  it.each([
    '帮我修一下 document.getElementById 的报错', // 裸 document（'.' 也是词边界，只能靠不收裸词）
    '这个 image 加载失败了',
    '帮我实现 image 上传功能',
    '重构 excel 导出那段代码', // 弱信号 excel 让位于代码语境
    '把 report 接口改成分页',
    '实现 draw 方法',
    '给 video 标签加个 poster 属性',
    'stylesheet 里的样式没生效', // sheet ⊂ stylesheet，靠词边界挡
    '改一下 slider 组件的样式', // slide ⊂ slider
    '修一下 carousel slides 的 bug',
    'presentation 层的接口改一下',
    '演示一下这个 API 怎么调用',
    '这个函数写错了，帮我看看',
    '给 drawer 加动画', // 动画≠视频；draw ⊂ drawer
    '给按钮加个过渡动画',
  ])('%s → 无产物特征', (prompt) => {
    expect(artifactFeaturesOf(prompt)).toEqual([]);
  });
});

describe('T12：去重/汇总需要明确表格语境', () => {
  it.each([
    '把这两个函数去重合并一下',
    '把这些工具函数汇总到一个文件',
  ])('%s → isExcelTask=false', (prompt) => {
    expect(detectTaskFeatures(prompt).isExcelTask).toBe(false);
  });

  it.each([
    '把这列数据去重',
    '帮我汇总这张表',
  ])('%s → isExcelTask=true', (prompt) => {
    expect(detectTaskFeatures(prompt).isExcelTask).toBe(true);
  });
});

describe('detectTaskFeatures：正文扩展名服从产物意图，真实附件仍是强证据', () => {
  it.each([
    ['这个 logo.svg 图标渲染模糊，帮我修一下组件代码', 'isImageTask'],
    ['把 spec.pdf 里的需求实现成代码', 'isDocumentTask'],
  ])('%s → %s=false', (prompt, feature) => {
    expect(detectTaskFeatures(prompt)[feature as 'isImageTask' | 'isDocumentTask']).toBe(false);
  });

  it.each([
    ['把 logo.svg 转成海报', 'isImageTask'],
    ['帮我把这份 spec.pdf 总结成文档', 'isDocumentTask'],
  ])('%s → %s=true', (prompt, feature) => {
    expect(detectTaskFeatures(prompt)[feature as 'isImageTask' | 'isDocumentTask']).toBe(true);
  });

  it.each([
    ['帮我修一下组件代码', ['.svg'], 'isImageTask'],
    ['把里面的需求实现成代码', ['.pdf'], 'isDocumentTask'],
  ])('%s + 附件 %j → %s=true', (prompt, extensions, feature) => {
    expect(detectTaskFeatures(prompt, extensions)[feature as 'isImageTask' | 'isDocumentTask']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 第二层：few-shot 选择
// ---------------------------------------------------------------------------

describe('few-shot 选择：产物任务拿产物示例', () => {
  it.each([
    ['帮我做一份 Q3 营销方案的 PPT', 'ppt_creation'],
    ['帮我做一份介绍我们代码库的 PPT', 'ppt_creation'],
    ['帮我把这些销售数据做成 Excel 表，按区域汇总', 'spreadsheet_creation'],
    ['帮我写一份 Q3 营销季度报告', 'document_draft'],
    ['帮我设计一张海报', 'design_creation'],
    ['帮我把模块依赖画成架构图', 'design_creation'],
  ])('%s → %s，且不含编程示例', (prompt, expectedType) => {
    const examples = selectedExamplesFor(prompt);

    // 必须真的选到东西——空数组等于静默关掉 few-shot，那是另一种坏
    expect(examples.length).toBeGreaterThan(0);
    expect(examples.every((e) => e.domain === 'artifact')).toBe(true);
    expect(examples.map((e) => e.type)).toContain(expectedType);
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
    // 检测层已挡住，这里再从选择层锁一道
    '帮我修一下 document.getElementById 的报错',
    '重构 excel 导出那段代码',
    '这个 image 加载失败了',
  ])('%s → 不被产物示例污染', (prompt) => {
    const examples = selectedExamplesFor(prompt);

    expect(examples.every((e) => e.domain === 'code')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// token 账
// ---------------------------------------------------------------------------

describe('token 预算', () => {
  it('tokens 必须来自 assistantResponse 本身，不许手写摘要低报', () => {
    // 旧写法把响应压成一句摘要再估算，低报 2.0x（1.6x~3.0x），预算门形同虚设
    for (const e of FEW_SHOT_EXAMPLES) {
      expect(e.tokens).toBe(Math.ceil(e.assistantResponse.length / 4));
    }
  });

  it('任意任务选出的示例都不撑爆 few-shot 预算（默认 400）', () => {
    const prompts = [
      '帮我做一份 Q3 营销方案的 PPT',
      '帮我设计一张海报',
      '帮我写一份 Q3 营销季度报告',
      '帮我把这些销售数据做成 Excel 表，按区域汇总',
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
