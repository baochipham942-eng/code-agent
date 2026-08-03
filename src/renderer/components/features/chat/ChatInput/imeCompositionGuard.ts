import { useEffect, useRef } from 'react';

/**
 * IME 组合态跟踪：搜狗/百度等输入法在 compositionEnd 之后才发 keyDown，
 * 单看 keydown 的 isComposing 会漏判。全局捕获 compositionstart/end，
 * end 后延迟 50ms 复位（与 InputArea 的 isComposingRef 同一套路）。
 */
export function useImeCompositionRef(): { current: boolean } {
  const isComposingRef = useRef(false);
  useEffect(() => {
    const handleStart = () => {
      isComposingRef.current = true;
    };
    const handleEnd = () => {
      window.setTimeout(() => {
        isComposingRef.current = false;
      }, 50);
    };
    window.addEventListener('compositionstart', handleStart, true);
    window.addEventListener('compositionend', handleEnd, true);
    return () => {
      window.removeEventListener('compositionstart', handleStart, true);
      window.removeEventListener('compositionend', handleEnd, true);
    };
  }, []);
  return isComposingRef;
}

/** 与 InputArea 提交防护同款的三重判定：isComposing + keyCode 229 + 延迟复位的组合态 ref。 */
export function isImeKeyEvent(
  event: { isComposing: boolean; keyCode: number },
  isComposingRef: { current: boolean },
): boolean {
  return event.isComposing || event.keyCode === 229 || isComposingRef.current;
}
