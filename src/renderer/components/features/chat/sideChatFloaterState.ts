// In-memory side-chat request. Not sessionStore, not localStorage.
// A new open replaces the current one. Dismiss leaves nothing to remount.

export interface SideChatRequest {
  id: number;
  sessionId: string;
  question: string;
}

let current: SideChatRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function openSideChat(sessionId: string, question: string): void {
  seq += 1;
  current = { id: seq, sessionId, question };
  emit();
}

export function dismissSideChat(): void {
  if (!current) return;
  current = null;
  emit();
}

export function getSideChatRequest(): SideChatRequest | null {
  return current;
}

export function subscribeSideChat(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
