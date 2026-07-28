import { describe, expect, it } from 'vitest';
import {
  applyDictationPartial,
  beginDictationAnchor,
  cancelDictationAnchor,
  markDictationUserEdit,
  settleDictationFinal,
} from '../../../src/renderer/components/features/chat/ChatInput/dictationComposerAnchor';

describe('ChatInput 流式口述锚点', () => {
  it('保留已有草稿，partial 覆盖而非重复追加', () => {
    let state = beginDictationAnchor('原草稿：');
    let applied = applyDictationPartial(state, '你');
    state = applied.state;
    expect(applied.value).toBe('原草稿：你');

    applied = applyDictationPartial(state, '你好');
    expect(applied.value).toBe('原草稿：你好');
  });

  it('final 定稿后前移锚点，多句能够累积', () => {
    let state = beginDictationAnchor('草稿 ');
    const first = settleDictationFinal(state, '草稿 你', '你好。');
    state = first.state;
    const secondPartial = applyDictationPartial(state, '今');
    const second = settleDictationFinal(secondPartial.state, secondPartial.value!, '今天好。');

    expect(second.value).toBe('草稿 你好。今天好。');
    expect(second.state.anchor).toBe(second.value.length);
  });

  it('用户中途手改后不再覆盖，后续 final 追加到末尾', () => {
    let state = beginDictationAnchor('草稿 ');
    state = applyDictationPartial(state, '你').state;
    const edited = '草稿 用户手改';
    state = markDictationUserEdit(state, edited);

    expect(applyDictationPartial(state, '你好').value).toBeNull();
    expect(settleDictationFinal(state, edited, '你好。').value).toBe('草稿 用户手改你好。');
  });

  it('取消或出错会清掉仍存在的 partial，并保留用户手改内容', () => {
    let state = beginDictationAnchor('草稿 ');
    state = applyDictationPartial(state, '临时字').state;
    expect(cancelDictationAnchor(state, '草稿 临时字')).toBe('草稿 ');

    state = markDictationUserEdit(state, '草稿 临时字 + 用户补充');
    expect(cancelDictationAnchor(state, '草稿 临时字 + 用户补充')).toBe('草稿  + 用户补充');
  });
});
