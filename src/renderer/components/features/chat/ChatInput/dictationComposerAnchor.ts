export interface DictationComposerAnchor {
  /** 本轮尚未定稿的句子开始位置。 */
  anchor: number;
  /** 已定稿文本（含口述前草稿），partial 永远只追加在它后面。 */
  prefix: string;
  /** 最近一次由流式识别写入的 partial。 */
  renderedPartial: string;
  /** 输入框最近一次由口述逻辑写出的完整值。 */
  expectedValue: string;
  /** 用户是否在口述期间手动改过输入框。 */
  detached: boolean;
}

export function beginDictationAnchor(value: string): DictationComposerAnchor {
  return {
    anchor: value.length,
    prefix: value,
    renderedPartial: '',
    expectedValue: value,
    detached: false,
  };
}

export function applyDictationPartial(
  state: DictationComposerAnchor,
  text: string,
): { state: DictationComposerAnchor; value: string | null } {
  if (state.detached) return { state, value: null };
  const value = state.prefix + text;
  return {
    value,
    state: {
      ...state,
      renderedPartial: text,
      expectedValue: value,
    },
  };
}

export function settleDictationFinal(
  state: DictationComposerAnchor,
  currentValue: string,
  text: string,
): { state: DictationComposerAnchor; value: string } {
  const value = state.detached ? currentValue + text : state.prefix + text;
  return {
    value,
    state: {
      anchor: value.length,
      prefix: value,
      renderedPartial: '',
      expectedValue: value,
      detached: state.detached,
    },
  };
}

export function markDictationUserEdit(
  state: DictationComposerAnchor,
  value: string,
): DictationComposerAnchor {
  if (value === state.expectedValue) return state;
  return { ...state, expectedValue: value, detached: true };
}

export function cancelDictationAnchor(
  state: DictationComposerAnchor,
  currentValue: string,
): string {
  if (!state.detached) return state.prefix;
  // 用户只在 partial 之后追加/编辑其他内容时，可以精确删除仍原样存在的 partial；
  // 用户改过 partial 本身则不猜，避免误删用户输入。
  if (
    state.renderedPartial
    && currentValue.startsWith(state.prefix)
    && currentValue.slice(state.anchor, state.anchor + state.renderedPartial.length) === state.renderedPartial
  ) {
    return currentValue.slice(0, state.anchor)
      + currentValue.slice(state.anchor + state.renderedPartial.length);
  }
  return currentValue;
}
