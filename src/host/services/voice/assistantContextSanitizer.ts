interface AssistantItemDeletionQueue {
  queue(itemId: string, onDeleted: () => void): boolean;
  flush(sendDelete: (itemId: string) => void): void;
  clear(): void;
}

export function createAssistantItemDeletionQueue(): AssistantItemDeletionQueue {
  const pending = new Map<string, () => void>();
  return {
    queue(itemId, onDeleted) {
      if (!itemId) return false;
      pending.set(itemId, onDeleted);
      while (pending.size > 32) {
        const oldest = pending.keys().next().value as string | undefined;
        if (!oldest) break;
        pending.delete(oldest);
      }
      return true;
    },
    flush(sendDelete) {
      for (const [itemId, onDeleted] of pending) {
        sendDelete(itemId);
        onDeleted();
      }
      pending.clear();
    },
    clear: () => pending.clear(),
  };
}
