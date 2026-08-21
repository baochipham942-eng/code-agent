export interface WaitForStableOptions {
  timeoutMs?: number;
  stableForMs?: number;
  pollIntervalMs?: number;
}

export interface WaitForStableWithRetryOptions extends WaitForStableOptions {
  attempts?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

export async function waitForStable<T>(
  read: () => T | null,
  options: WaitForStableOptions = {},
): Promise<T | null> {
  const {
    timeoutMs = 3_000,
    stableForMs = 200,
    pollIntervalMs = 50,
  } = options;
  const deadline = performance.now() + timeoutMs;
  let stableSince: number | null = null;

  while (performance.now() < deadline) {
    const value = read();
    const now = performance.now();
    if (value !== null) {
      stableSince ??= now;
      if (now - stableSince >= stableForMs) return value;
    } else {
      stableSince = null;
    }
    await delay(pollIntervalMs);
  }
  return null;
}

export async function waitForStableWithRetry<T>(
  read: () => T | null,
  retry: (attempt: number) => void | Promise<void>,
  options: WaitForStableWithRetryOptions = {},
): Promise<T | null> {
  const { attempts = 1, ...waitOptions } = options;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const value = await waitForStable(read, waitOptions);
    if (value !== null) return value;
    if (attempt < attempts) await retry(attempt + 1);
  }
  return null;
}
