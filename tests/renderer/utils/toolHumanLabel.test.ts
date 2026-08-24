import { describe, expect, it } from 'vitest';
import { en, zh } from '../../../src/renderer/i18n';
import { getHumanToolLabel } from '../../../src/renderer/utils/toolHumanLabel';

describe('getHumanToolLabel', () => {
  it.each([
    ['mail', '邮件', 'Mail'],
    ['calendar', '日历', 'Calendar'],
    ['reminders', '提醒事项', 'Reminders'],
  ])('connector %s 优先使用双语人话名', (connector, expectedZh, expectedEn) => {
    expect(getHumanToolLabel({
      connector,
      toolName: 'internal_tool_name',
      labels: zh.receiptPresentation.humanToolLabels,
    })).toBe(expectedZh);
    expect(getHumanToolLabel({
      connector,
      toolName: 'internal_tool_name',
      labels: en.receiptPresentation.humanToolLabels,
    })).toBe(expectedEn);
  });

  it.each([
    ['web_fetch', '网页抓取', 'Web fetch'],
    ['WebSearch', '联网搜索', 'Web search'],
    ['analyst · Read', '读取文件', 'Read file'],
    ['memory_search', '记忆检索', 'Memory search'],
  ])('常见工具 %s 使用双语人话名', (toolName, expectedZh, expectedEn) => {
    expect(getHumanToolLabel({
      toolName,
      labels: zh.receiptPresentation.humanToolLabels,
    })).toBe(expectedZh);
    expect(getHumanToolLabel({
      toolName,
      labels: en.receiptPresentation.humanToolLabels,
    })).toBe(expectedEn);
  });

  it('未知工具复用 getToolDisplayName 兜底且永不空白', () => {
    expect(getHumanToolLabel({
      toolName: 'brand_new_tool',
      labels: zh.receiptPresentation.humanToolLabels,
    })).toBe('brand_new_tool');
    expect(getHumanToolLabel({
      toolName: '',
      labels: zh.receiptPresentation.humanToolLabels,
    })).toBe('工具');
  });
});
