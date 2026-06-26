// ============================================================================
// 截屏意图检测 + 场景 reminder 选择
// 背景：「截个屏，分析下屏幕上有什么」此前要烧 3 轮 ToolSearch 找工具
// （Computer 可搜不可调 → 再搜 → 最终用 Bash），且因含"分析"被误选
// DATA_PROCESSING reminder。截屏意图应：单独检测 + 专属 reminder 优先于
// 内容生成链 + 配合 image_analyze 预载。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { detectTaskFeatures, getSystemReminders } from '../../../src/host/prompts/systemReminders';

describe('detectTaskFeatures — isScreenCaptureTask', () => {
  it.each([
    '截个屏，分析下屏幕上有什么',
    '截屏看看现在的页面',
    '帮我截取屏幕',
    '看看屏幕上有什么',
    '看一下当前屏幕',
    'take a screenshot and describe it',
    'capture the screen for me',
  ])('detects screen-capture intent: %s', (prompt) => {
    expect(detectTaskFeatures(prompt).isScreenCaptureTask).toBe(true);
  });

  it.each([
    '分析这张截图里的报错', // 已有截图文件，不是要去截屏
    '帮我画一张架构图',
    '分析一下这份数据',
  ])('does not flag non-capture prompts: %s', (prompt) => {
    expect(detectTaskFeatures(prompt).isScreenCaptureTask).toBe(false);
  });
});

describe('getSystemReminders — screen capture mode', () => {
  it('selects the screen-capture reminder for capture prompts', () => {
    const reminders = getSystemReminders('截个屏，分析下屏幕上有什么');
    expect(reminders.some((r) => r.includes('截屏分析模式'))).toBe(true);
  });

  it('suppresses the data-processing reminder even when the prompt contains 分析', () => {
    const reminders = getSystemReminders('截个屏，分析下屏幕上有什么');
    expect(reminders.some((r) => r.includes('数据处理'))).toBe(false);
  });
});
