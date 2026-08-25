import { describe, expect, it } from 'vitest';
import { en, zh } from '../../../src/renderer/i18n';
import { CONNECTOR_TOOL_NAMES } from '../../../src/shared/contract/workbenchTools';
import { getHumanToolLabel } from '../../../src/renderer/utils/toolHumanLabel';

describe('getHumanToolLabel', () => {
  it.each([
    ['mail', '邮件', 'Mail'],
    ['calendar', '日历', 'Calendar'],
    ['reminders', '提醒事项', 'Reminders'],
    ['tmeet', '腾讯会议', 'Tencent Meeting'],
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

  it('fail-loud：连接器注册表里的每个工具都必须脱离内部名', () => {
    const missing = Object.entries(CONNECTOR_TOOL_NAMES).flatMap(([connector, toolNames]) => (
      toolNames
        .filter((toolName) => getHumanToolLabel({
          toolName,
          labels: zh.receiptPresentation.humanToolLabels,
        }) === toolName)
        .map((toolName) => `${connector}:${toolName}`)
    ));

    expect(missing, `连接器工具缺少人话标签：${missing.join(', ')}`).toEqual([]);
  });
});
