// ============================================================================
// VoiceContextAssembler（方案 §6.5，批 H）
//
// 把「用户此刻在看什么」拼成 instructions 的 [Context — Focus] 段。
// 焦点变化时增量 session.update——只重发 instructions，不重发整份 session。
//
// 为什么字段是 view/filePath/unsaved/selectedElement 而不是方案里写的
// 「当前文件 / 选区 / diff」：Neo 不是 IDE，它没有编辑器文本选区、也没有 diff 视图。
// 照抄 IDE 词汇的结果是通话 brain 一本正经地聊不存在的东西——比没有上下文更糟。
// ============================================================================

import type { VoiceFocusContext } from '../../../shared/contract/voice';

const VIEW_LABEL: Record<string, string> = {
  overview: '概览',
  files: '文件列表',
  browser: '浏览器',
  'design-canvas': '设计画布',
};

function describeView(view: string): string {
  if (view.startsWith('preview:')) return `文件预览（${view.slice('preview:'.length)}）`;
  return VIEW_LABEL[view] ?? view;
}

/** 空焦点返回空串——没东西可说时不要塞一段「（无）」进 instructions。 */
export function buildFocusBlock(focus: VoiceFocusContext | null): string {
  if (!focus) return '';
  const lines: string[] = [];
  if (focus.view) lines.push(`- 右栏正在看：${describeView(focus.view)}`);
  if (focus.filePath) lines.push(`- 当前文件：${focus.filePath}${focus.unsaved ? '（有未保存改动）' : ''}`);
  if (focus.selectedElement) lines.push(`- 选中的元素：${focus.selectedElement}`);
  if (!lines.length) return '';
  return [
    '[Context — Focus]',
    ...lines,
    '用户说「这个」「这里」「当前这个文件」时，多半指的就是上面这些。不确定就问一句，别猜。',
  ].join('\n');
}

/** 人设 + 焦点。焦点为空时原样返回人设，不留空行。 */
export function composeVoiceInstructions(persona: string, focus: VoiceFocusContext | null): string {
  const block = buildFocusBlock(focus);
  return block ? `${persona}\n\n${block}` : persona;
}

/** 焦点有没有实质变化。没变就不发 session.update——上游每次刷新都有代价。 */
export function focusChanged(a: VoiceFocusContext | null, b: VoiceFocusContext | null): boolean {
  return buildFocusBlock(a) !== buildFocusBlock(b);
}
