export function bindExternalEngineAbort(
  signal: AbortSignal | undefined,
  terminate: () => void,
): () => void {
  if (!signal) return () => {};
  const onAbort = () => terminate();
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}
