import { describe, expect, it } from 'vitest';
import { en, zh } from '../../../src/renderer/i18n';
import { getRoleToolCapabilities } from '../../../src/renderer/utils/roleToolCapabilities';

function capabilities(
  toolNames: readonly string[],
  language: 'zh' | 'en',
): string[] {
  const copy = language === 'zh' ? zh : en;
  return getRoleToolCapabilities({
    toolNames,
    capabilityLabels: copy.receiptPresentation.roleCapabilityLabels,
    humanToolLabels: copy.receiptPresentation.humanToolLabels,
  });
}

describe('getRoleToolCapabilities', () => {
  it('中文合并读写与记忆能力，未注册的腾讯会议旧名只进入通用兜底', () => {
    const rawNames = ['tmeetCalendarList', 'MemoryRead', 'MemoryWrite', 'Read', 'Write'];
    const result = capabilities(rawNames, 'zh');

    expect(result).toEqual(['记住和回想', '读取和查找文件', '写入和编辑文件', '其他 1 项能力']);
    expect(result.join('、')).not.toMatch(/tmeetCalendarList|MemoryRead|MemoryWrite|Read|Write/);
  });

  it('English groups web, memory, and file tools in stable first-seen order', () => {
    const rawNames = ['WebSearch', 'WebFetch', 'MemoryRead', 'Glob'];
    const result = capabilities(rawNames, 'en');

    expect(result).toEqual(['Search the web', 'Open web pages', 'Remember and recall', 'Read and find files']);
    for (const rawName of rawNames) expect(result.join(', ')).not.toContain(rawName);
  });

  it('同组工具和别名去重，不改变各组首次出现的顺序', () => {
    expect(capabilities(
      ['Glob', 'Read', 'read_file', 'WebSearch', 'web_search', 'History', 'MemoryRead'],
      'zh',
    )).toEqual(['读取和查找文件', '联网搜索', '记住和回想']);
  });

  it('连接器工具复用双语连接器名称，同一连接器只显示一次', () => {
    expect(capabilities(['tmeetMeetingList', 'tmeetMeetingCreate'], 'zh')).toEqual(['腾讯会议']);
    expect(capabilities(['calendar', 'calendar_create_event'], 'en')).toEqual(['Calendar']);
  });

  it('多个未注册名称合并为一条尾部计数，且不泄露任何原名', () => {
    const rawNames = ['brand_new_tool', 'anotherTool', 'BRAND-NEW-TOOL'];
    const result = capabilities(['Read', ...rawNames], 'en');

    expect(result).toEqual(['Read and find files', '2 other abilities']);
    for (const rawName of rawNames) expect(result.join(', ')).not.toContain(rawName);
  });
});
