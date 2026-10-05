import type { ProbeResult } from './types';

async function readFirstByte(response: Response): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  try {
    await reader.read();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function defaultProbe(url: string, timeoutMs: number): Promise<ProbeResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // GET, then cancel after the first body byte so TTFB is the real first byte
    // and a large index is not downloaded. Range would blur the 2xx check.
    const response = await fetch(url, { method: 'GET', signal: controller.signal });
    await readFirstByte(response);
    const ok = response.ok || response.status === 206;
    return { url, ok, ttfbMs: Date.now() - started };
  } catch {
    return { url, ok: false, ttfbMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}
