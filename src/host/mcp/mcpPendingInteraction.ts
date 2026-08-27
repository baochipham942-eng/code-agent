type PendingInteractionListener = (pending: boolean) => void;

const pendingInteractions = new Map<string, number>();
const listeners = new Map<string, Set<PendingInteractionListener>>();

function emitPendingInteractionChange(serverName: string): void {
  const pending = hasPendingMcpInteraction(serverName);
  for (const listener of listeners.get(serverName) ?? []) {
    listener(pending);
  }
}

/**
 * Marks a server-scoped MCP interaction as waiting for a human.
 *
 * MCP's legacy elicitation request does not expose the parent tools/call id to
 * the client handler. Server identity is therefore the narrowest correlation
 * available across stdio, in-memory, and HTTP transports.
 */
export function beginPendingMcpInteraction(serverName: string): () => void {
  pendingInteractions.set(serverName, (pendingInteractions.get(serverName) ?? 0) + 1);
  emitPendingInteractionChange(serverName);

  let ended = false;
  return () => {
    if (ended) return;
    ended = true;

    const remaining = (pendingInteractions.get(serverName) ?? 1) - 1;
    if (remaining > 0) pendingInteractions.set(serverName, remaining);
    else pendingInteractions.delete(serverName);
    emitPendingInteractionChange(serverName);
  };
}

export function hasPendingMcpInteraction(serverName: string): boolean {
  return (pendingInteractions.get(serverName) ?? 0) > 0;
}

export function onPendingMcpInteractionChange(
  serverName: string,
  listener: PendingInteractionListener,
): () => void {
  let serverListeners = listeners.get(serverName);
  if (!serverListeners) {
    serverListeners = new Set();
    listeners.set(serverName, serverListeners);
  }
  serverListeners.add(listener);

  return () => {
    serverListeners?.delete(listener);
    if (serverListeners?.size === 0) listeners.delete(serverName);
  };
}
