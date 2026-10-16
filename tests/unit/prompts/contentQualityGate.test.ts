// ============================================================================
// Content Quality Gate — 提示词扩展链测试
// ============================================================================
// 验证 data/document/image 3 种内容类型的意图识别 + 提醒注入
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  detectTaskFeatures,
  getSystemReminders,
} from '../../../src/host/prompts/systemReminders';
import { getRemindersForTask } from '../../../src/host/prompts/dynamicReminders';
import { chatTranscriptEn, chatTranscriptZh } from '../../../src/renderer/i18n/chatTranscript';
import {
  REMINDER_DEFINITIONS,
} from '../../../src/host/prompts/reminderRegistry';
import type { ReminderContext } from '../../../src/host/prompts/reminders/types';

// ============================================================================
// detectTaskFeatures — 意图识别
// ============================================================================

describe('detectTaskFeatures — 内容类型识别', () => {
  // --- 数据处理任务 ---
  it.each([
    '帮我分析这个 Excel 文件的销售数据',
    '把 data.csv 的数据做个透视表',
    '用 pandas 清洗一下这个数据集',
    '对 report.xlsx 进行聚合统计',
    '帮我做个数据分析',
  ])('isDataTask: "%s"', (prompt) => {
    const features = detectTaskFeatures(prompt);
    expect(features.isDataTask).toBe(true);
  });

  it.each([
    '你好',
    '帮我写个 React 组件',
    '部署到生产环境',
  ])('非 data 任务不触发: "%s"', (prompt) => {
    const features = detectTaskFeatures(prompt);
    expect(features.isDataTask).toBe(false);
  });

  // --- 文档生成任务 ---
  it.each([
    '帮我写一篇关于 AI 的文章',
    '撰写项目进度报告',
    '编写文档说明接口用法',
    'write a report about Q1 sales',
    '帮我起草一份技术方案文档',
  ])('isDocumentTask: "%s"', (prompt) => {
    const features = detectTaskFeatures(prompt);
    expect(features.isDocumentTask).toBe(true);
  });

  it.each([
    '你好',
    '帮我 debug 这段代码',
    '运行测试',
  ])('非 document 任务不触发: "%s"', (prompt) => {
    const features = detectTaskFeatures(prompt);
    expect(features.isDocumentTask).toBe(false);
  });

  // --- 图像生成任务 ---
  it.each([
    '帮我画一个架构图',
    '生成一张流程图',
    'generate an image of a cat',
    '画图说明这个系统的工作流',
    '生成一个插图',
  ])('isImageTask: "%s"', (prompt) => {
    const features = detectTaskFeatures(prompt);
    expect(features.isImageTask).toBe(true);
  });

  it.each([
    '你好',
    '修复登录页面的 bug',
    '帮我做个 PPT',
  ])('非 image 任务不触发: "%s"', (prompt) => {
    const features = detectTaskFeatures(prompt);
    expect(features.isImageTask).toBe(false);
  });

  // --- PPT 仍然正常工作 ---
  it('PPT 任务检测不受影响', () => {
    const features = detectTaskFeatures('帮我做个 PPT 介绍公司');
    expect(features.isPPTTask).toBe(true);
    expect(features.isDataTask).toBe(false);
  });

  it('游戏生成请求不会误触发既有内容类型提醒', () => {
    const features = detectTaskFeatures('生成一个类似超级玛丽的游戏，主角是一只柯基');
    expect(features.isPPTTask).toBe(false);
    expect(features.isDataTask).toBe(false);
    expect(features.isDocumentTask).toBe(false);
    expect(features.isImageTask).toBe(false);
  });
});

// ============================================================================
// getSystemReminders — 提醒注入
// ============================================================================

describe('getSystemReminders — 内容类型提醒注入', () => {
  it('数据处理任务 → 注入 DATA_PROCESSING 提醒', () => {
    const reminders = getSystemReminders('帮我分析 Excel 数据');
    expect(reminders.length).toBeGreaterThanOrEqual(1);
    expect(reminders.some((r) => r.includes('数据处理任务'))).toBe(true);
  });

  it('文档生成任务 → 注入 DOCUMENT_GENERATION 提醒', () => {
    const reminders = getSystemReminders('撰写一份项目报告');
    expect(reminders.length).toBeGreaterThanOrEqual(1);
    expect(reminders.some((r) => r.includes('文档生成任务'))).toBe(true);
  });

  it('图像生成任务 → 注入 IMAGE_GENERATION 提醒', () => {
    const reminders = getSystemReminders('帮我画一个架构图');
    expect(reminders.length).toBeGreaterThanOrEqual(1);
    expect(reminders.some((r) => r.includes('图像生成任务'))).toBe(true);
  });

  it('PPT 任务 → 仍注入 PPT 提醒', () => {
    const reminders = getSystemReminders('帮我做个 PPT');
    expect(reminders.some((r) => r.includes('PPT 生成任务'))).toBe(true);
    expect(reminders.some((r) => r.includes('数据处理任务'))).toBe(false);
  });

  it('普通任务 → 不注入内容类型提醒', () => {
    const reminders = getSystemReminders('你好');
    expect(reminders.length).toBe(0);
  });

  it('游戏生成请求不走旧的内容类型提醒词表', () => {
    const reminders = getSystemReminders('生成一个类似超级玛丽的游戏，主角是一只柯基');
    expect(reminders.some((r) => r.includes('PPT 生成任务'))).toBe(false);
    expect(reminders.some((r) => r.includes('数据处理任务'))).toBe(false);
    expect(reminders.some((r) => r.includes('图像生成任务'))).toBe(false);
  });

  it('内容类型提醒互斥（PPT 优先于 data）', () => {
    // "帮我做个 PPT 分析数据" → PPT 优先
    const reminders = getSystemReminders('帮我做个 PPT 分析数据');
    expect(reminders.some((r) => r.includes('PPT 生成任务'))).toBe(true);
    expect(reminders.some((r) => r.includes('数据处理任务'))).toBe(false);
  });
});

// ============================================================================
// reminderRegistry — 动态提醒定义
// ============================================================================

describe('reminderRegistry — 3 个新 P1 提醒定义', () => {
  it('DATA_PROCESSING_WORKFLOW 存在且为 P1', () => {
    const def = REMINDER_DEFINITIONS.find((r) => r.id === 'DATA_PROCESSING_WORKFLOW');
    expect(def).toBeDefined();
    expect(def!.priority).toBe(1);
    expect(def!.exclusiveGroup).toBe('task-type-selection');
  });

  it('DOCUMENT_GENERATION_WORKFLOW 存在且为 P1', () => {
    const def = REMINDER_DEFINITIONS.find((r) => r.id === 'DOCUMENT_GENERATION_WORKFLOW');
    expect(def).toBeDefined();
    expect(def!.priority).toBe(1);
    expect(def!.exclusiveGroup).toBe('task-type-selection');
  });

  it('IMAGE_GENERATION_WORKFLOW 存在且为 P1', () => {
    const def = REMINDER_DEFINITIONS.find((r) => r.id === 'IMAGE_GENERATION_WORKFLOW');
    expect(def).toBeDefined();
    expect(def!.priority).toBe(1);
    expect(def!.exclusiveGroup).toBe('task-type-selection');
  });

  it('shouldInclude 只在对应 taskType 时返回 1.0', () => {
    const baseCtx: ReminderContext = {
      taskFeatures: {
        isMultiDimension: false,
        isComplexTask: false,
        isAuditTask: false,
        isReviewTask: false,
        isPlanningTask: false,
        isPPTTask: false,
        isDataTask: false,
        isDocumentTask: false,
        isImageTask: false,
        isExcelTask: false,
        isVideoTask: false,
        isFuzzyCodeReview: false,
        isFuzzyTroubleshooting: false,
        isScreenCaptureTask: false,
        dimensions: [],
      },
      toolsUsedInTurn: [],
      iterationCount: 0,
      tokenBudget: 1200,
      currentMode: 'normal',
      hasError: false,
    };

    const dataDef = REMINDER_DEFINITIONS.find((r) => r.id === 'DATA_PROCESSING_WORKFLOW')!;
    const docDef = REMINDER_DEFINITIONS.find((r) => r.id === 'DOCUMENT_GENERATION_WORKFLOW')!;
    const imgDef = REMINDER_DEFINITIONS.find((r) => r.id === 'IMAGE_GENERATION_WORKFLOW')!;

    // data task → only DATA matches
    const dataCtx = { ...baseCtx, taskFeatures: { ...baseCtx.taskFeatures, isDataTask: true } };
    expect(dataDef.shouldInclude(dataCtx)).toBe(1.0);
    expect(docDef.shouldInclude(dataCtx)).toBe(0);
    expect(imgDef.shouldInclude(dataCtx)).toBe(0);

    // document task → only DOC matches
    const docCtx = { ...baseCtx, taskFeatures: { ...baseCtx.taskFeatures, isDocumentTask: true } };
    expect(dataDef.shouldInclude(docCtx)).toBe(0);
    expect(docDef.shouldInclude(docCtx)).toBe(1.0);
    expect(imgDef.shouldInclude(docCtx)).toBe(0);

    // image task → only IMG matches
    const imgCtx = { ...baseCtx, taskFeatures: { ...baseCtx.taskFeatures, isImageTask: true } };
    expect(dataDef.shouldInclude(imgCtx)).toBe(0);
    expect(docDef.shouldInclude(imgCtx)).toBe(0);
    expect(imgDef.shouldInclude(imgCtx)).toBe(1.0);

    // no task → none matches
    expect(dataDef.shouldInclude(baseCtx)).toBe(0);
    expect(docDef.shouldInclude(baseCtx)).toBe(0);
    expect(imgDef.shouldInclude(baseCtx)).toBe(0);
  });

  it('所有 task-type-selection 提醒共享互斥组', () => {
    const taskTypeReminders = REMINDER_DEFINITIONS.filter(
      (r) => r.exclusiveGroup === 'task-type-selection'
    );
    // FILE_DELIVERABLE + PPT + DATA + DOCUMENT + IMAGE + VIDEO + EXCEL = 7
    expect(taskTypeReminders.length).toBe(7);
    expect(taskTypeReminders.every((r) => r.priority === 1)).toBe(true);
  });
});

// ============================================================================
// 单轮 Office 文件交付（N-HOME-STARTER-CARDS-FILES r2）
// 首屏卡点击的周报/表格轮：提醒面指向原生生成工具，不再给 Python 工作流。
// ============================================================================

describe('单轮 Office 文件交付 — 意图与提醒', () => {
  const weeklyZh = '帮我把这周的工作要点写成一份可以直接发给主管的周报（Word .docx）：结构含 本周完成 / 数据与进展 / 风险与需协调 / 下周计划。请写入一个 .docx 文件，并在回复中说明生成的文件名。不要问我任何问题。';
  const weeklyEn = 'Turn this week’s rough bullets into a Word status report (.docx) I can send my manager as-is. Write the report to a .docx file and state the generated filename in your reply, without asking me any questions.';
  const sheetZh = '分析下面这份月度销售数据，并生成一个 Excel 工作簿（.xlsx）：包含原始数据工作表和汇总表。请写入一个 .xlsx 文件，并在回复中说明生成的文件名。不要问我任何问题。';
  const sheetEn = 'Analyze this monthly sales dataset and generate an Excel workbook (.xlsx): include a raw-data worksheet and a summary table. Write the workbook to a .xlsx file and state the generated filename in your reply, without asking me any questions.';

  it.each([
    ['zh 周报卡', weeklyZh],
    ['en 周报卡', weeklyEn],
    ['zh 表格卡', sheetZh],
    ['en 表格卡', sheetEn],
  ])('文件交付意图命中且判为单轮：%s', (_label, prompt) => {
    const features = detectTaskFeatures(prompt);
    expect(features.isOfficeFileDeliverable).toBe(true);
    expect(features.isOneTurnFileDeliverable).toBe(true);
  });

  it.each([
    ['读取已有 docx 不算交付（生成动词门）', '打开 report.docx 看看结论'],
    ['闲聊不触发', '你好，帮我看看今天有什么安排'],
    ['普通数据任务仍是数据任务', '帮我分析这个 Excel 文件的销售数据'],
  ])('非交付意图不触发：%s', (_label, prompt) => {
    expect(detectTaskFeatures(prompt).isOneTurnFileDeliverable).toBe(false);
  });

  it('复杂大型文件交付不豁免（仍走既有后台/派发路径）', () => {
    const prompt = '全面深入地研究这个行业，给我生成一份完整报告 .docx';
    const features = detectTaskFeatures(prompt);
    expect(features.isOfficeFileDeliverable).toBe(true);
    expect(features.isOneTurnFileDeliverable).toBe(false);
  });

  it.each([
    ['zh 周报卡', weeklyZh],
    ['en 周报卡', weeklyEn],
  ])('%s：注入 FILE_DELIVERABLE，不再注入文档/数据 Python 工作流与委派提醒', (_label, prompt) => {
    const reminders = getSystemReminders(prompt);
    expect(reminders.some((r) => r.includes('文件交付任务') && r.includes('docx_generate'))).toBe(true);
    for (const absent of ['文档生成任务', '数据处理任务', '委派提醒', '并行派发提醒']) {
      expect(reminders.some((r) => r.includes(absent))).toBe(false);
    }
    const gen8 = getRemindersForTask(prompt, { includeFewShot: false });
    expect(gen8.some((r) => r.includes('文件交付任务') && r.includes('docx_generate'))).toBe(true);
    for (const absent of ['文档生成必须遵循的流程', '数据处理必须遵循的流程', '委派提醒', '并行派发']) {
      expect(gen8.some((r) => r.includes(absent))).toBe(false);
    }
  });

  it.each([
    ['zh 表格卡', sheetZh],
    ['en 表格卡', sheetEn],
  ])('%s：注入 FILE_DELIVERABLE（excel_generate + DocEdit），Excel/数据 Python 工作流不再注入', (_label, prompt) => {
    const reminders = getSystemReminders(prompt);
    expect(reminders.some((r) => r.includes('文件交付任务') && r.includes('excel_generate'))).toBe(true);
    for (const absent of ['数据处理任务', '文档生成任务', '委派提醒', '并行派发提醒']) {
      expect(reminders.some((r) => r.includes(absent))).toBe(false);
    }
    const gen8 = getRemindersForTask(prompt, { includeFewShot: false });
    expect(gen8.some((r) => r.includes('文件交付任务') && r.includes('excel_generate'))).toBe(true);
    for (const absent of ['Excel 数据处理必须遵循的流程', '数据处理必须遵循的流程', '文档生成必须遵循的流程']) {
      expect(gen8.some((r) => r.includes(absent))).toBe(false);
    }
  });

  it('普通数据任务的 DATA_PROCESSING 提醒不受影响（无回归）', () => {
    const prompt = '帮我分析这个 Excel 文件的销售数据并做个透视表';
    expect(getSystemReminders(prompt).some((r) => r.includes('数据处理任务'))).toBe(true);
    expect(getRemindersForTask(prompt, { includeFewShot: false }).some((r) => r.includes('数据处理必须遵循的流程'))).toBe(true);
  });

  // PR review 2026-10-15（rework r2）：office 令牌处于**源位置**的请求（转换的输入、
  // 另存/复制的对象）不是「从会话内容生成交付物」——生成器做不了 docx→PDF 转换也
  // 做不了另存桌面，误判会收走委派面并把模型指去重新生成 Word，整轮失败。
  it.each([
    ['zh 已有 docx 转 PDF', '把已有 report.docx 转成 PDF 发我'],
    ['zh 另存到桌面', '帮我把 report.docx 另存到桌面'],
    ['zh 保存到桌面', '帮我把 report.docx 保存到桌面'],
    ['zh excel 表格转 csv', '把这份 excel 表格转成 csv'],
    ['en convert docx to PDF', 'convert report.docx to PDF and send it over'],
    ['en save xlsx to desktop', 'save the .xlsx to my desktop'],
  ])('已有文件操作不算单轮交付：%s', (_label, prompt) => {
    const features = detectTaskFeatures(prompt);
    expect(features.isOneTurnFileDeliverable).toBe(false);
    expect(getSystemReminders(prompt).some((r) => r.includes('文件交付任务'))).toBe(false);
  });

  it.each([
    ['目标是 office 格式的转换仍算交付（md 转成 .docx）', '把 note.md 的内容整理好，转成一份排版漂亮的 .docx'],
    ['周报卡仍是交付', weeklyZh],
  ])('office 令牌在目标位不误伤：%s', (_label, prompt) => {
    expect(detectTaskFeatures(prompt).isOneTurnFileDeliverable).toBe(true);
  });
});

// ============================================================================
// 小范围单轮对比（bounded comparison）— PR review 2026-10-15（rework r2）
// 竞品简报卡这类「少量实体 + 单轮交付」的对比，不能被通用复杂度启发式推去
// 自动委派/并行派发（glm-5.3 收到委派指引会拉起 swarm，成员启动审批卡可再卡死
// 首轮——2026-10-11 缺陷）。触发策略在 host 侧收口，卡片文案不写内部指令。
// ============================================================================

describe('小范围单轮对比 — 不触发委派/并行派发', () => {
  const competitorZh = chatTranscriptZh.chat.suggestions.competitorBrief.prompt;
  const competitorEn = chatTranscriptEn.chat.suggestions.competitorBrief.prompt;

  it.each([
    ['zh 竞品卡', competitorZh],
    ['en 竞品卡', competitorEn],
    ['en 泛化样本', 'Write a competitor brief: compare exactly Notion, Lark, and DingTalk across 5 dimensions, then deliver the full brief in one turn.'],
  ])('%s：判为 bounded，不注入委派/并行派发提醒', (_label, prompt) => {
    const features = detectTaskFeatures(prompt);
    expect(features.isBoundedComparison).toBe(true);
    expect(features.isMultiDimension).toBe(false);
    expect(getSystemReminders(prompt).some((r) => r.includes('委派提醒') || r.includes('并行派发'))).toBe(false);
    expect(getRemindersForTask(prompt, { includeFewShot: false }).some((r) => r.includes('委派提醒') || r.includes('并行派发'))).toBe(false);
  });

  it('大型多维任务仍保留并行派发与委派信号（无回归）', () => {
    const prompt = 'Perform a comprehensive security, performance, quality, frontend, backend, database, and API audit across the entire codebase with independent findings and a complete report.';
    const features = detectTaskFeatures(prompt);

    expect(features.isBoundedComparison).toBe(false);
    expect(features.isMultiDimension).toBe(true);
    expect(getSystemReminders(prompt).some((r) => r.includes('并行派发'))).toBe(true);
    expect(getRemindersForTask(prompt, { includeFewShot: false }).some((r) => r.includes('并行派发'))).toBe(true);
  });
});
