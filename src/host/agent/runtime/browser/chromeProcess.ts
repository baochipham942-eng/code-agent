import type { ChildProcess } from 'child_process';

export async function waitForCdpEndpoint(port: number, chromeProcess: ChildProcess, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    if (chromeProcess.exitCode !== null || chromeProcess.signalCode !== null) {
      throw new Error(`System Chrome exited before CDP became ready (code=${chromeProcess.exitCode ?? 'null'}, signal=${chromeProcess.signalCode ?? 'null'})`);
    }

    try {
      const response = await fetch(endpoint);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError || 'unknown error');
  throw new Error(`Timed out waiting for Chrome CDP endpoint on port ${port}: ${message}`);
}

export async function stopChromeProcess(chromeProcess: ChildProcess | null): Promise<void> {
  if (!chromeProcess || chromeProcess.killed || chromeProcess.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (chromeProcess.exitCode === null && !chromeProcess.killed) {
        chromeProcess.kill('SIGKILL');
      }
      resolve();
    }, 2000);

    chromeProcess.once('close', () => {
      clearTimeout(timer);
      resolve();
    });

    chromeProcess.kill('SIGTERM');
  });
}
