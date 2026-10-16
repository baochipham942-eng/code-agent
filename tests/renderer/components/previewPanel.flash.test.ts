import { describe, expect, it } from 'vitest';
import { shouldFlashOnDiskLoad } from '../../../src/renderer/components/PreviewPanel';

// Grok Build 借鉴 T7：产物更新回执——只有"agent 改了正在预览的文件"才闪现。
describe('shouldFlashOnDiskLoad（产物更新闪现判据）', () => {
  const at = (tabId: string, savedContent: string, content = savedContent) => ({
    tabId,
    savedContent,
    content,
  });

  it('首次加载（无前快照）不闪', () => {
    expect(shouldFlashOnDiskLoad(null, { tabId: 't1', savedContent: 'v1' })).toBe(false);
  });

  it('切换到别的 tab 不闪', () => {
    expect(shouldFlashOnDiskLoad(at('t1', 'v1'), { tabId: 't2', savedContent: 'v2' })).toBe(false);
  });

  it('内容没变的重渲染不闪', () => {
    expect(shouldFlashOnDiskLoad(at('t1', 'v1'), { tabId: 't1', savedContent: 'v1' })).toBe(false);
  });

  it('agent 重写文件后磁盘重载 → 闪现', () => {
    expect(shouldFlashOnDiskLoad(at('t1', 'v1'), { tabId: 't1', savedContent: 'v2' })).toBe(true);
  });

  it('用户自己保存（savedContent 追上正在显示的编辑内容）不闪', () => {
    // 用户在编辑器把 v1 改成 v2 后保存：快照里 content 已是 v2
    expect(shouldFlashOnDiskLoad(at('t1', 'v1', 'v2'), { tabId: 't1', savedContent: 'v2' })).toBe(false);
  });

  it('有未保存编辑时 agent 重写为其他内容 → 仍闪（外来更新盖不掉的信号）', () => {
    expect(shouldFlashOnDiskLoad(at('t1', 'v1', 'v1-edited'), { tabId: 't1', savedContent: 'v3' })).toBe(true);
  });
});
