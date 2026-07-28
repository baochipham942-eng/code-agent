// ============================================================================
// 「用户此刻在看什么」的取值（方案 §6.5 [Context — Focus]，批 H）
//
// 方案原文写的是「当前文件 / 选区 / diff」——那是 IDE 的词汇。Neo 里这三样只有
// 第一样真实存在：右栏 preview tab 有 path 和未保存态；「选区」最接近的是实时预览里
// 用户点选的元素；diff 视图根本不存在。所以这里按**真实存在的焦点**取值，
// 缺的就不报——让通话 brain 一本正经地聊不存在的东西，比没有上下文更糟。
// ============================================================================

import type { VoiceFocusContext } from '@shared/contract/voice';
import type { AppState, LivePreviewSelectedElement } from '../stores/appStore';

/** 元素描述压到一行：这段会进 instructions，别把整棵 DOM 塞给模型。 */
function describeSelectedElement(element: LivePreviewSelectedElement | null | undefined): string | undefined {
  if (!element) return undefined;
  const parts: string[] = [];
  if (element.componentName) parts.push(element.componentName);
  else if (element.tag) parts.push(element.tag.toLowerCase());
  const text = element.text?.trim().slice(0, 40);
  if (text) parts.push(`「${text}」`);
  if (element.relativeFile) parts.push(`（${element.relativeFile}:${element.line}）`);
  return parts.length ? parts.join(' ') : undefined;
}

export function selectVoiceFocusContext(state: Pick<AppState, 'previewTabs' | 'activePreviewTabId' | 'activeWorkbenchTab' | 'workbenchCollapsed'>): VoiceFocusContext {
  // 右栏整栏收起时用户其实什么都没在看，别拿上次的视图当现状。
  if (state.workbenchCollapsed) return {};
  const context: VoiceFocusContext = {};
  if (state.activeWorkbenchTab) context.view = state.activeWorkbenchTab;

  const tab = state.previewTabs.find((item) => item.id === state.activePreviewTabId);
  // 只有右栏真的停在这个 preview 上才算「当前文件」——tab 还开着但用户在看画布，
  // 那他嘴里的「这个」指的是画布，不是那个文件。
  if (tab && state.activeWorkbenchTab === `preview:${tab.path}`) {
    if (tab.kind === 'liveDev') {
      const element = describeSelectedElement(tab.selectedElement);
      if (element) context.selectedElement = element;
    } else {
      context.filePath = tab.path;
      if (tab.mode === 'edit' && tab.content !== tab.savedContent) context.unsaved = true;
    }
  }
  return context;
}
