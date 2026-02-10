// ============================================================================
// Content Quality Gate — 提示词扩展链测试
// ============================================================================
// 验证 data/document/image 3 种内容类型的意图识别 + 提醒注入
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  detectTaskFeatures,
  getSystemReminders,
} from '../../../src/main/generation/prompts/systemReminders';
import {
  REMINDER_DEFINITIONS,
} from '../../../src/main/generation/prompts/reminderRegistry';

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
    const baseCtx = {
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
    // PPT + DATA + DOCUMENT + IMAGE + VIDEO = 5
    expect(taskTypeReminders.length).toBe(5);
    expect(taskTypeReminders.every((r) => r.priority === 1)).toBe(true);
  });
});
