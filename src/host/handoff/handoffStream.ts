const HANDOFF_OPEN_TAGS = ['<handoff-proposal>', '<handoff_proposal>'];

function findHandoffOpenTagIndex(text: string): number {
  const lower = text.toLowerCase();
  let firstIndex = -1;

  for (const tag of HANDOFF_OPEN_TAGS) {
    const index = lower.indexOf(tag);
    if (index >= 0 && (firstIndex < 0 || index < firstIndex)) {
      firstIndex = index;
    }
  }

  return firstIndex;
}

function getOpenTagPrefixSuffixLength(text: string): number {
  const lower = text.toLowerCase();
  let best = 0;

  for (const tag of HANDOFF_OPEN_TAGS) {
    const lowerTag = tag.toLowerCase();
    const maxLength = Math.min(lower.length, lowerTag.length - 1);
    for (let length = maxLength; length > best; length--) {
      if (lower.endsWith(lowerTag.slice(0, length))) {
        best = length;
        break;
      }
    }
  }

  return best;
}

export function createHandoffTailStreamFilter(emit: (text: string) => void): {
  push: (text: string | undefined) => void;
  flush: () => void;
} {
  let pending = '';
  let suppressing = false;

  return {
    push: (text) => {
      if (!text || suppressing) return;
      pending += text;

      const openTagIndex = findHandoffOpenTagIndex(pending);
      if (openTagIndex >= 0) {
        const visibleText = pending.slice(0, openTagIndex);
        pending = '';
        suppressing = true;
        emit(visibleText);
        return;
      }

      const keepLength = getOpenTagPrefixSuffixLength(pending);
      const visibleLength = pending.length - keepLength;
      if (visibleLength <= 0) return;

      const visibleText = pending.slice(0, visibleLength);
      pending = keepLength > 0 ? pending.slice(-keepLength) : '';
      emit(visibleText);
    },

    flush: () => {
      if (suppressing || !pending) return;
      emit(pending);
      pending = '';
    },
  };
}
