import { useEffect } from 'react';
import { useComposerStore } from '../../../../stores/composerStore';

/**
 * 输入框预填的接收半（发起半在 composerStore.setPendingComposerPrefill）：
 * 专家团快捷句等入口把句子放进 store 后，这里消费——填进输入框并聚焦，
 * 不自动发送（发不发给用户自己决定）。
 *
 * ChatInput 在能力中心等二级页打开期间是卸载的，事件会丢，所以走 store：
 * 消费发生在挂载后的 effect 里，先清再填，同句连点靠 nonce 各触发一次。
 */
export function useComposerPrefill(
  apply: (text: string) => void,
  focusComposer: () => void,
): void {
  const prefill = useComposerStore((state) => state.pendingComposerPrefill);
  useEffect(() => {
    if (!prefill) return;
    useComposerStore.getState().setPendingComposerPrefill(null);
    apply(prefill.text);
    focusComposer();
  }, [prefill, apply, focusComposer]);
}
